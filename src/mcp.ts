// MCP server definition: the tools Claude sees, and nothing else.
// Deliberately omitted: deleting playlists, removing tracks, touching the library,
// playback, or reading playlists this connector did not create.

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
1. Call search_tracks for every requested track (up to 20 per call). If the user gave Spotify links or IDs, use get_track instead.
2. For each request, choose the candidate whose title and primary artist match what the user asked for. Prefer the original studio album or single over live, remix, remaster, acoustic, karaoke, cover, sped-up or compilation versions unless the user asked for one of those. If nothing matches, or several versions differ in a way that matters, ask the user rather than guessing.
3. Call create_playlist with the chosen track IDs in the user's order.
4. Check the "verification" field of the result. Report the playlist link, any request you could not match, and any mismatch the verification shows.`;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof NotConnectedError) message += " (Open the connector's home page in a browser to sign in.)";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function guard<T>(fn: () => Promise<T>) {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof SpotifyError) return fail(err);
    console.error(err);
    return fail(err);
  }
}

/** Runs tasks with limited concurrency so a big batch doesn't trip Spotify's rate limit. */
async function pool<I, O>(items: I[], size: number, fn: (item: I, i: number) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
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

function verify(expected: string[], actual: PlaylistTrack[], start: number) {
  const slice = actual.slice(start, start + expected.length);
  const mismatches = expected.flatMap((id, i) => {
    const got = slice[i];
    return got?.id === id ? [] : [{ position: start + i, expected: id, found: got?.id ?? null }];
  });
  return {
    ok: mismatches.length === 0 && slice.length === expected.length,
    expected_count: expected.length,
    playlist_total: actual.length,
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
    { name: "spotify-playlist-mcp", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "search_tracks",
    {
      title: "Search tracks",
      description:
        "Look up one or more tracks on Spotify. Each request returns candidate tracks with ID, title, artists, album, release date, duration and a link, so you can pick the exact version. Only tracks playable in the signed-in account's country are returned. Searches with field filters first and falls back to a plain-text search if that finds nothing.",
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
          .max(20)
          .describe("Up to 20 track lookups, in the user's order"),
        candidates: z.number().int().min(1).max(10).default(5).describe("Candidates per request (max 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ requests, candidates }) =>
      guard(async () => {
        const results = await pool(requests, 3, async (req, i) => {
          const { strict, loose } = buildSearchQueries(req);
          let used = strict;
          let tracks: TrackSummary[] = await spotify.searchTracks(strict, candidates);
          if (tracks.length === 0 && loose) {
            used = loose;
            tracks = await spotify.searchTracks(loose, candidates);
          }
          return { request: i + 1, asked_for: req, query_used: used, candidates: tracks };
        });
        return { results };
      }),
  );

  server.registerTool(
    "get_track",
    {
      title: "Get track",
      description: "Look up specific tracks by Spotify ID, URI or link, to confirm exactly what they are.",
      inputSchema: { tracks: z.array(trackRef).min(1).max(20) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ tracks }) =>
      guard(async () => {
        const ids = tracks.map(parseTrackId);
        return { tracks: await pool(ids, 3, (id) => spotify.getTrack(id)) };
      }),
  );

  server.registerTool(
    "create_playlist",
    {
      title: "Create playlist",
      description:
        "Create a new private playlist containing exactly the given tracks, in order, then read it back and report whether it matches. Only pass track IDs you have confirmed with search_tracks or get_track.",
      inputSchema: {
        name: z.string().trim().min(1).max(100),
        description: z.string().max(300).optional(),
        tracks: z.array(trackRef).min(1).max(500).describe("Track IDs, URIs or links, in playlist order"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ name, description, tracks }) =>
      guard(async () => {
        const ids = tracks.map(parseTrackId);
        const cleanDescription = description?.replace(/\s+/g, " ").trim() || undefined;
        const playlist = await spotify.createPlaylist(name, cleanDescription);
        const record: PlaylistRecord = { name, created_at: new Date().toISOString() };
        await env.KV.put(KV_KEYS.playlistPrefix + playlist.id, JSON.stringify(record), { metadata: record });
        await spotify.addTracks(playlist.id, ids);
        const actual = await spotify.getPlaylistTracks(playlist.id);
        return {
          playlist_id: playlist.id,
          name,
          link: playlist.link,
          visibility: "private",
          verification: verify(ids, actual, 0),
          tracks: actual,
        };
      }),
  );

  server.registerTool(
    "add_tracks_to_playlist",
    {
      title: "Add tracks to playlist",
      description:
        "Add tracks to a playlist this connector created earlier, then read it back and report whether they landed where expected. Appends to the end unless a position is given.",
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
        const before = position === undefined ? (await spotify.getPlaylistTracks(id)).length : position;
        await spotify.addTracks(id, ids, position);
        const actual = await spotify.getPlaylistTracks(id);
        const meta = await spotify.getPlaylistName(id);
        return { playlist_id: id, ...meta, verification: verify(ids, actual, before), tracks: actual };
      }),
  );

  server.registerTool(
    "get_playlist",
    {
      title: "Get playlist",
      description: "Read back the tracks of a playlist this connector created.",
      inputSchema: { playlist: z.string().min(1).describe("Playlist ID, URI or link") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ playlist }) =>
      guard(async () => {
        const id = await requireOwnPlaylist(env, playlist);
        const meta = await spotify.getPlaylistName(id);
        return { playlist_id: id, ...meta, tracks: await spotify.getPlaylistTracks(id) };
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
        return { note: "Names are as created; they may have been renamed in Spotify since.", playlists: out };
      }),
  );

  return server;
}
