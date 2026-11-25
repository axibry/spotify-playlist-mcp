// MCP server definition: the tools Claude sees, and nothing else.
// Deliberately omitted: deleting playlists, removing tracks, touching the library,
// playback, or reading playlists this connector did not create.
//
// Cloudflare's free plan allows 50 outbound requests per call, so batch sizes below
// are capped to stay well under that even with retries.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type Env,
  KV_KEYS,
  NotConnectedError,
  parseAlbumId,
  parsePlaylistId,
  parseTrackId,
  Spotify,
  SpotifyError,
  buildSearchQueries,
  type PlaylistTrack,
  type TrackSummary,
} from "./spotify";

const INSTRUCTIONS = `Builds private Spotify playlists from exact recordings the user names. Never add a track the user did not ask for.

Workflow:
1. Call search_tracks for every requested track (up to 10 per call; make several calls for longer lists). Put the artists the user named (band, performer or composer) in "artist" so unrelated results are dropped. If the user gave Spotify links or IDs, use get_track instead.
2. For each request, choose the recording the user means. Results come in Spotify's relevance order. Copies of the same recording on other releases are grouped under "also_on", and the one shown is its earliest non-compilation release. Don't swap in a different version (live, remix, re-recording, cover, sped-up, karaoke) unless the user asked for it or it is clearly the recording they mean; some famous recordings are live. If nothing matches, or several different recordings are plausible, ask the user rather than guessing.
3. If a piece may be split across several tracks (movements, parts, suites, medleys), or the user wants part of an album, call get_album with the candidate's album_id to see how the album divides it.
4. Call create_playlist once with all the chosen track IDs in the user's order.
5. Check the "verification" field of the result. Report the playlist link, any request you could not match, and any mismatch the verification shows.

If something fails:
- Tool errors say whether anything was changed and whether it is safe to retry.
- If a write fails part-way, the result says which playlist exists and what landed. Fix it with add_tracks_to_playlist; never create a second playlist to retry.
- If a call fails with no result at all (a bare HTTP error such as 502 or 503), it may or may not have run. Before retrying create_playlist, call list_created_playlists; before retrying add_tracks_to_playlist, call get_playlist.`;

const SAFE_TO_RETRY = "Nothing was changed, so it's safe to retry.";

function json(data: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], ...(isError ? { isError } : {}) };
}

function errorMessage(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof NotConnectedError) message += " (Open the connector's home page in a browser to sign in.)";
  return message;
}

/**
 * Runs a tool body and turns thrown errors into tool errors. `onError` says what a failure
 * at this point means for the user's data, so Claude knows whether retrying is safe.
 */
async function guard(fn: () => Promise<{ data: unknown; isError?: boolean }>, onError = SAFE_TO_RETRY) {
  try {
    const { data, isError } = await fn();
    return json(data, isError);
  } catch (err) {
    if (!(err instanceof SpotifyError)) console.error(err);
    const message = errorMessage(err);
    const text = message.includes("safe to retry") ? message : `${message} ${onError}`;
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

/**
 * Runs tasks with limited concurrency so a batch doesn't trip Spotify's rate limit.
 * One failing item doesn't sink the others; only "not connected" aborts the batch.
 */
async function pool<I, O>(items: I[], size: number, fn: (item: I) => Promise<O>): Promise<Array<O | { error: string }>> {
  const out: Array<O | { error: string }> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        if (err instanceof NotConnectedError) throw err;
        out[i] = { error: errorMessage(err) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- search helpers

/** Lower-case, strip accents and punctuation, drop a leading "the", so "Dvořák" matches "Dvorak". */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");
}

/** True when any credited artist matches the requested name (either contains the other). */
export function artistMatches(requested: string, artists: string[]): boolean {
  const want = normalizeName(requested);
  if (!want) return true;
  return artists.some((a) => {
    const have = normalizeName(a);
    return have.includes(want) || (have.length > 0 && want.includes(have));
  });
}

interface ReleaseRef {
  id: string;
  album: string;
  album_type?: string;
  release_date?: string;
  link: string;
}

type GroupedCandidate = TrackSummary & { also_on?: ReleaseRef[] };

/**
 * Merges results that are the same recording (same ISRC) released on several albums.
 * The track shown is the earliest non-compilation release; the rest are listed in also_on.
 * Groups keep Spotify's relevance order (by their best-ranked member).
 */
export function groupByRecording(tracks: TrackSummary[]): GroupedCandidate[] {
  const groups = new Map<string, Array<{ t: TrackSummary; rank: number }>>();
  tracks.forEach((t, rank) => {
    const key = t.isrc ? `isrc:${t.isrc}` : `id:${t.id}`;
    const g = groups.get(key);
    if (g) g.push({ t, rank });
    else groups.set(key, [{ t, rank }]);
  });
  const isCompilation = (t: TrackSummary) => (t.album_type === "compilation" ? 1 : 0);
  const date = (t: TrackSummary) => t.release_date || "9999";
  return [...groups.values()].map((members) => {
    const [first, ...rest] = [...members].sort(
      (a, b) => isCompilation(a.t) - isCompilation(b.t) || date(a.t).localeCompare(date(b.t)) || a.rank - b.rank,
    );
    if (rest.length === 0) return first.t;
    return {
      ...first.t,
      also_on: rest.map(({ t }) => ({
        id: t.id,
        album: t.album,
        album_type: t.album_type,
        release_date: t.release_date,
        link: t.link,
      })),
    };
  });
}

// ---------------------------------------------------------------- playlist helpers

interface PlaylistRecord {
  name: string;
  created_at: string;
}

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

async function listCreated(env: Env): Promise<Array<{ playlist_id: string } & PlaylistRecord>> {
  const out: Array<{ playlist_id: string } & PlaylistRecord> = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list<PlaylistRecord>({ prefix: KV_KEYS.playlistPrefix, cursor });
    for (const key of page.keys) {
      out.push({
        playlist_id: key.name.slice(KV_KEYS.playlistPrefix.length),
        name: key.metadata?.name ?? "",
        created_at: key.metadata?.created_at ?? "",
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function requireOwnPlaylist(env: Env, input: string): Promise<string> {
  const id = parsePlaylistId(input);
  const record = await env.KV.get(KV_KEYS.playlistPrefix + id);
  if (!record) {
    throw new SpotifyError(
      "This connector only reads or changes playlists it created itself. Use list_created_playlists to see them.",
    );
  }
  return id;
}

function verify(expected: string[], landed: PlaylistTrack[], start: number) {
  const mismatches = expected.flatMap((id, i) => {
    const got = landed[i];
    return got?.id === id ? [] : [{ position: start + i, expected: id, found: got?.id ?? null }];
  });
  return {
    ok: mismatches.length === 0 && landed.length >= expected.length,
    expected_count: expected.length,
    checked_from_position: start,
    mismatches,
  };
}

const trackRef = z
  .string()
  .min(1)
  .describe("A Spotify track ID, a spotify:track: URI, or an open.spotify.com/track link");

// ---------------------------------------------------------------- server

export function buildServer(env: Env): McpServer {
  const spotify = new Spotify(env);
  const server = new McpServer(
    { name: "spotify-playlist-mcp", version: "1.2.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "search_tracks",
    {
      title: "Search tracks",
      description:
        "Look up to 10 tracks on Spotify per call. Each request returns distinct recordings in Spotify's relevance order, with ID, title, artists, album (and album_id), release date, track position and duration. Copies of the same recording on other releases are grouped under also_on. When 'artist' is given, results that don't credit that artist are dropped (accents and case ignored); if that would drop everything, the unfiltered results are returned with a note. Searches with field filters first and falls back to a plain-text search if that finds nothing.",
      inputSchema: {
        requests: z
          .array(
            z.object({
              title: z.string().optional().describe("Track or work title"),
              artist: z
                .string()
                .optional()
                .describe("An artist the result must credit: band, performer or composer"),
              album: z.string().optional().describe("Album name, to narrow to one release"),
              year: z.string().optional().describe("Release year or range, e.g. 1997 or 1990-1999"),
              query: z
                .string()
                .optional()
                .describe("Raw Spotify search query; replaces title/album/year in the search, but 'artist' still filters"),
            }),
          )
          .min(1)
          .max(10)
          .describe("Up to 10 track lookups, in the user's order"),
        candidates: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Distinct recordings to return per request (max 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ requests, candidates }) =>
      guard(async () => {
        const results = await pool(requests, 3, async (req) => {
          const { strict, loose } = buildSearchQueries(req);
          let used = strict;
          let raw: TrackSummary[] = [];
          let kept: TrackSummary[] = [];
          for (const q of loose ? [strict, loose] : [strict]) {
            const found = await spotify.searchTracks(q, 10); // Spotify's maximum per search
            if (found.length === 0) continue;
            used = q;
            raw = found;
            kept = req.artist ? found.filter((t) => artistMatches(req.artist!, t.artists)) : found;
            if (kept.length > 0) break;
          }
          let note: string | undefined;
          let dropped = raw.length - kept.length;
          if (kept.length === 0 && raw.length > 0) {
            kept = raw;
            dropped = 0;
            note = `No result credits "${req.artist}"; showing unfiltered results. The name may be spelled differently on Spotify.`;
          }
          return {
            query_used: used,
            ...(dropped > 0 ? { dropped_other_artists: dropped } : {}),
            ...(note ? { note } : {}),
            candidates: groupByRecording(kept).slice(0, candidates),
          };
        });
        return {
          data: { results: results.map((r, i) => ({ request: i + 1, asked_for: requests[i], ...r })) },
        };
      }),
  );

  server.registerTool(
    "get_track",
    {
      title: "Get track",
      description: "Look up specific tracks (up to 10 per call) by Spotify ID, URI or link, to confirm exactly what they are.",
      inputSchema: { tracks: z.array(trackRef).min(1).max(10) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ tracks }) =>
      guard(async () => {
        const results = await pool(tracks, 3, (ref) => spotify.getTrack(parseTrackId(ref)));
        return { data: { tracks: results.map((r, i) => ("error" in r ? { asked_for: tracks[i], ...r } : r)) } };
      }),
  );

  server.registerTool(
    "get_album",
    {
      title: "Get album",
      description:
        "List an album's tracks in order with disc and track numbers, to see how a work is divided (movements, parts) or to pick tracks from an album. Takes an album ID (album_id from search results), URI or link.",
      inputSchema: {
        album: z.string().min(1).describe("Album ID, spotify:album: URI, or open.spotify.com/album link"),
        offset: z.number().int().min(0).default(0).describe("Zero-based track position to start from"),
        limit: z.number().int().min(1).max(300).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ album, offset, limit }) =>
      guard(async () => ({ data: await spotify.getAlbum(parseAlbumId(album), offset, limit) })),
  );

  server.registerTool(
    "create_playlist",
    {
      title: "Create playlist",
      description:
        "Create one new private playlist containing exactly the given tracks, in order, then read it back and report whether it matches. Only pass track IDs you have confirmed with search_tracks, get_track or get_album. Call once per playlist; if it fails part-way, fix the result with add_tracks_to_playlist rather than calling this again. Refuses if this connector created a playlist with the same name in the last 10 minutes, unless allow_duplicate is true.",
      inputSchema: {
        name: z.string().trim().min(1).max(100),
        description: z.string().max(300).optional(),
        tracks: z.array(trackRef).min(1).max(500).describe("Track IDs, URIs or links, in playlist order"),
        allow_duplicate: z
          .boolean()
          .default(false)
          .describe("Create even if a playlist with this name was just created (only when the user wants two)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ name, description, tracks, allow_duplicate }) =>
      guard(async () => {
        const ids = tracks.map(parseTrackId); // validate everything before creating anything

        if (!allow_duplicate) {
          const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
          const recent = (await listCreated(env)).find(
            (p) => p.created_at >= cutoff && p.name.trim().toLowerCase() === name.trim().toLowerCase(),
          );
          if (recent) {
            return {
              data: {
                error: `A playlist named "${recent.name}" was created at ${recent.created_at}, probably by an earlier attempt. No new playlist was created. Check it with get_playlist and complete it with add_tracks_to_playlist, or call again with allow_duplicate: true if the user wants a second one.`,
                existing_playlist_id: recent.playlist_id,
                link: `https://open.spotify.com/playlist/${recent.playlist_id}`,
              },
              isError: true,
            };
          }
        }

        const cleanDescription = description?.replace(/\s+/g, " ").trim() || undefined;
        const playlist = await spotify.createPlaylist(name, cleanDescription);
        // From here on the playlist exists: report what happened rather than throwing.
        const record: PlaylistRecord = { name, created_at: new Date().toISOString() };
        let registrationWarning: string | undefined;
        try {
          await env.KV.put(KV_KEYS.playlistPrefix + playlist.id, JSON.stringify(record), { metadata: record });
        } catch (err) {
          console.error("Could not record created playlist", err);
          registrationWarning =
            "The playlist was created, but the connector couldn't record it, so it can't read or change it later. Fix any problems in the Spotify app.";
        }
        const base = {
          playlist_id: playlist.id,
          name,
          link: playlist.link,
          visibility: "private",
          ...(registrationWarning ? { warning: registrationWarning } : {}),
        };
        const add = await spotify.addTracks(playlist.id, ids);
        try {
          const { tracks: landed } = await spotify.getPlaylistTracks(playlist.id);
          const verification = verify(ids, landed, 0);
          if (add.error) {
            return {
              data: {
                ...base,
                error: `The playlist was created, but adding tracks stopped after ${add.added} of ${ids.length}: ${add.error} Don't create it again; add the missing tracks with add_tracks_to_playlist.`,
                verification,
                tracks: landed,
              },
              isError: true,
            };
          }
          return { data: { ...base, verification, tracks: landed } };
        } catch (err) {
          return {
            data: {
              ...base,
              tracks_added: add.added,
              error:
                add.error ??
                `The playlist was created and ${add.added} tracks were added, but reading it back failed: ${errorMessage(err)} Check it with get_playlist before changing anything.`,
            },
            isError: true,
          };
        }
      }, "No playlist was created, so it's safe to retry."),
  );

  server.registerTool(
    "add_tracks_to_playlist",
    {
      title: "Add tracks to playlist",
      description:
        "Add tracks to a playlist this connector created earlier, then read back the inserted range and report whether it matches. Appends to the end unless a position is given.",
      inputSchema: {
        playlist: z.string().min(1).describe("Playlist ID, URI or link"),
        tracks: z.array(trackRef).min(1).max(500),
        position: z.number().int().min(0).optional().describe("Zero-based position to insert at"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ playlist, tracks, position }) =>
      guard(async () => {
        const id = await requireOwnPlaylist(env, playlist);
        const ids = tracks.map(parseTrackId);
        const start = position ?? (await spotify.playlistLength(id));
        const add = await spotify.addTracks(id, ids, position);
        const base = { playlist_id: id, link: `https://open.spotify.com/playlist/${id}` };
        const stopped =
          add.error &&
          (add.added === 0
            ? `Nothing was added (${add.error}), so it's safe to retry.`
            : `Adding stopped after ${add.added} of ${ids.length}: ${add.error} Retry only the tracks that didn't land.`);
        try {
          const { tracks: landed, total } = await spotify.getPlaylistTracks(id, start, ids.length);
          const verification = verify(ids, landed, start);
          const data = { ...base, playlist_length: total, verification, inserted: landed };
          return stopped ? { data: { ...data, error: stopped }, isError: true } : { data };
        } catch (err) {
          return {
            data: {
              ...base,
              tracks_added: add.added,
              error:
                stopped ||
                `${add.added} tracks were added, but reading them back failed: ${errorMessage(err)} Check with get_playlist before retrying.`,
            },
            isError: true,
          };
        }
      }, "Nothing was added, so it's safe to retry."),
  );

  server.registerTool(
    "get_playlist",
    {
      title: "Get playlist",
      description: "Read back the tracks of a playlist this connector created, up to 500 at a time.",
      inputSchema: {
        playlist: z.string().min(1).describe("Playlist ID, URI or link"),
        offset: z.number().int().min(0).default(0).describe("Zero-based position to start reading from"),
        limit: z.number().int().min(1).max(500).default(500),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ playlist, offset, limit }) =>
      guard(async () => {
        const id = await requireOwnPlaylist(env, playlist);
        const meta = await spotify.getPlaylistName(id);
        const { tracks, total } = await spotify.getPlaylistTracks(id, offset, limit);
        return { data: { playlist_id: id, ...meta, playlist_length: total, offset, tracks } };
      }),
  );

  server.registerTool(
    "list_created_playlists",
    {
      title: "List created playlists",
      description: "List the playlists this connector has created, newest first.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guard(async () => ({
        data: {
          note: "Names are as created; they may have been renamed in Spotify since.",
          playlists: (await listCreated(env)).map((p) => ({
            ...p,
            link: `https://open.spotify.com/playlist/${p.playlist_id}`,
          })),
        },
      })),
  );

  return server;
}
