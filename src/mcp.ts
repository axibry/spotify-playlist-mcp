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
  parsePlaylistId,
  parseTrackId,
  Spotify,
  SpotifyError,
  buildSearchQueries,
  type PlaylistTrack,
  type TrackSummary,
} from "./spotify";

const INSTRUCTIONS = `Builds private Spotify playlists from exact tracks the user names. Never add a track the user did not ask for.

Workflow:
1. Call search_tracks for every requested track (up to 10 per call; make several calls for longer lists). If the user gave Spotify links or IDs, use get_track instead.
2. For each request, choose the candidate whose title and primary artist match what the user asked for. Prefer the original studio album or single over live, remix, remaster, acoustic, karaoke, cover, sped-up or compilation versions unless the user asked for one of those. If nothing matches, or several versions differ in a way that matters, ask the user rather than guessing.
3. Call create_playlist once with all the chosen track IDs in the user's order.
4. Check the "verification" field of the result. Report the playlist link, any request you could not match, and any mismatch the verification shows.
5. If a write fails part-way, the result says which playlist exists and what landed. Fix it with add_tracks_to_playlist; never create a second playlist to retry.`;

function json(data: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], ...(isError ? { isError } : {}) };
}

function errorMessage(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof NotConnectedError) message += " (Open the connector's home page in a browser to sign in.)";
  return message;
}

async function guard(fn: () => Promise<{ data: unknown; isError?: boolean }>) {
  try {
    const { data, isError } = await fn();
    return json(data, isError);
  } catch (err) {
    if (!(err instanceof SpotifyError)) console.error(err);
    return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true };
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

interface PlaylistRecord {
  name: string;
  created_at: string;
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

export function buildServer(env: Env): McpServer {
  const spotify = new Spotify(env);
  const server = new McpServer(
    { name: "spotify-playlist-mcp", version: "1.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "search_tracks",
    {
      title: "Search tracks",
      description:
        "Look up to 10 tracks on Spotify per call. Each request returns candidate tracks with ID, title, artists, album, release date, duration and a link, so you can pick the exact version. Results follow the signed-in account's country. Searches with field filters first and falls back to a plain-text search if that finds nothing.",
      inputSchema: {
        requests: z
          .array(
            z.object({
              title: z.string().optional().describe("Track title"),
              artist: z.string().optional().describe("Artist name"),
              album: z.string().optional().describe("Album name, to narrow to one release"),
              year: z.string().optional().describe("Release year or range, e.g. 1997 or 1990-1999"),
              query: z
                .string()
                .optional()
                .describe("Raw Spotify search query; overrides the other fields when given"),
            }),
          )
          .min(1)
          .max(10)
          .describe("Up to 10 track lookups, in the user's order"),
        candidates: z.number().int().min(1).max(10).default(5).describe("Candidates per request (max 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ requests, candidates }) =>
      guard(async () => {
        const results = await pool(requests, 3, async (req) => {
          const { strict, loose } = buildSearchQueries(req);
          let used = strict;
          let tracks: TrackSummary[] = await spotify.searchTracks(strict, candidates);
          if (tracks.length === 0 && loose) {
            used = loose;
            tracks = await spotify.searchTracks(loose, candidates);
          }
          return { query_used: used, candidates: tracks };
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
    "create_playlist",
    {
      title: "Create playlist",
      description:
        "Create one new private playlist containing exactly the given tracks, in order, then read it back and report whether it matches. Only pass track IDs you have confirmed with search_tracks or get_track. Call once per playlist; if it fails part-way, fix the result with add_tracks_to_playlist rather than calling this again.",
      inputSchema: {
        name: z.string().trim().min(1).max(100),
        description: z.string().max(300).optional(),
        tracks: z.array(trackRef).min(1).max(500).describe("Track IDs, URIs or links, in playlist order"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ name, description, tracks }) =>
      guard(async () => {
        const ids = tracks.map(parseTrackId); // validate everything before creating anything
        const cleanDescription = description?.replace(/\s+/g, " ").trim() || undefined;
        const playlist = await spotify.createPlaylist(name, cleanDescription);
        const record: PlaylistRecord = { name, created_at: new Date().toISOString() };
        await env.KV.put(KV_KEYS.playlistPrefix + playlist.id, JSON.stringify(record), { metadata: record });

        // From here on the playlist exists: report what happened rather than throwing.
        const base = { playlist_id: playlist.id, name, link: playlist.link, visibility: "private" };
        const add = await spotify.addTracks(playlist.id, ids);
        try {
          const { tracks: landed } = await spotify.getPlaylistTracks(playlist.id);
          const verification = verify(ids, landed, 0);
          if (add.error) {
            return {
              data: { ...base, error: `Adding tracks stopped after ${add.added} of ${ids.length}: ${add.error}`, verification, tracks: landed },
              isError: true,
            };
          }
          return { data: { ...base, verification, tracks: landed } };
        } catch (err) {
          return {
            data: {
              ...base,
              tracks_added: add.added,
              error: add.error ?? `Tracks were added but reading the playlist back failed: ${errorMessage(err)}`,
            },
            isError: true,
          };
        }
      }),
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
        try {
          const { tracks: landed, total } = await spotify.getPlaylistTracks(id, start, ids.length);
          const verification = verify(ids, landed, start);
          const data = { ...base, playlist_length: total, verification, inserted: landed };
          if (add.error) {
            return { data: { ...data, error: `Adding stopped after ${add.added} of ${ids.length}: ${add.error}` }, isError: true };
          }
          return { data };
        } catch (err) {
          return {
            data: {
              ...base,
              tracks_added: add.added,
              error: add.error ?? `Tracks were added but reading them back failed: ${errorMessage(err)}`,
            },
            isError: true,
          };
        }
      }),
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
      guard(async () => {
        const out: Array<{ playlist_id: string; name: string; created_at: string; link: string }> = [];
        let cursor: string | undefined;
        do {
          const page = await env.KV.list<PlaylistRecord>({ prefix: KV_KEYS.playlistPrefix, cursor });
          for (const key of page.keys) {
            const id = key.name.slice(KV_KEYS.playlistPrefix.length);
            out.push({
              playlist_id: id,
              name: key.metadata?.name ?? "",
              created_at: key.metadata?.created_at ?? "",
              link: `https://open.spotify.com/playlist/${id}`,
            });
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        out.sort((a, b) => b.created_at.localeCompare(a.created_at));
        return { data: { note: "Names are as created; they may have been renamed in Spotify since.", playlists: out } };
      }),
  );

  return server;
}
