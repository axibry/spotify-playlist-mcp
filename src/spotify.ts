// Spotify Web API client: token handling, track search, and playlist writes.
// Only the endpoints this connector needs are wrapped here.

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  KV: KVNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  CONNECTOR_KEY?: string;
  // Local testing only: point these at a mock server. Ignored unless they are loopback URLs,
  // so a stray production setting can't send credentials elsewhere.
  SPOTIFY_ACCOUNTS_BASE?: string;
  SPOTIFY_API_BASE?: string;
}

// The only permissions requested from Spotify: create/edit private playlists and read them back.
export const SCOPES = ["playlist-modify-private", "playlist-read-private"];

export const KV_KEYS = {
  refreshToken: "spotify:refresh_token",
  accessToken: "spotify:access_token",
  user: "spotify:user",
  playlistPrefix: "playlist:",
} as const;

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class NotConnectedError extends SpotifyError {}

export interface TrackSummary {
  id: string;
  name: string;
  artists: string[];
  album: string;
  album_id?: string;
  album_type?: string;
  release_date?: string;
  disc_number?: number;
  track_number?: number;
  duration: string;
  explicit: boolean;
  isrc?: string;
  link: string;
}

export interface PlaylistTrack {
  position: number;
  id: string | null;
  name: string;
  artists: string[];
  type: string;
}

const BASE62_ID = /^[0-9A-Za-z]{22}$/;

function parseSpotifyId(input: string, kind: "track" | "playlist" | "album"): string {
  const s = input.trim();
  if (BASE62_ID.test(s)) return s;
  const uri = new RegExp(`^spotify:${kind}:([0-9A-Za-z]{22})$`).exec(s);
  if (uri) return uri[1];
  try {
    const url = new URL(s);
    if (url.hostname === "open.spotify.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const i = parts.indexOf(kind);
      if (i !== -1 && BASE62_ID.test(parts[i + 1] ?? "")) return parts[i + 1];
    }
  } catch {
    // not a URL
  }
  throw new SpotifyError(`Not a Spotify ${kind} ID, URI or link: "${input}"`);
}

/** Accepts a bare ID, a spotify:track: URI, or an open.spotify.com track link. */
export const parseTrackId = (input: string) => parseSpotifyId(input, "track");
/** Accepts a bare ID, a spotify:playlist: URI, or an open.spotify.com playlist link. */
export const parsePlaylistId = (input: string) => parseSpotifyId(input, "playlist");
/** Accepts a bare ID, a spotify:album: URI, or an open.spotify.com album link. */
export const parseAlbumId = (input: string) => parseSpotifyId(input, "album");

export interface AlbumTrack {
  disc_number: number;
  track_number: number;
  id: string;
  name: string;
  artists: string[];
  duration: string;
  link: string;
}

export interface AlbumListing {
  album_id: string;
  name: string;
  artists: string[];
  album_type?: string;
  release_date?: string;
  total_tracks: number;
  link: string;
  offset: number;
  tracks: AlbumTrack[];
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== "number") return "?";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function summarizeTrack(t: any): TrackSummary {
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists ?? []).map((a: { name: string }) => a.name),
    album: t.album?.name ?? "",
    album_id: t.album?.id,
    album_type: t.album?.album_type,
    release_date: t.album?.release_date,
    disc_number: t.disc_number,
    track_number: t.track_number,
    duration: formatDuration(t.duration_ms),
    explicit: Boolean(t.explicit),
    isrc: t.external_ids?.isrc,
    link: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
  };
}

function cleanTerm(s: string): string {
  return s.replace(/"/g, " ").replace(/\s+/g, " ").trim();
}

export interface TrackQuery {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  query?: string;
}

/** Builds a field-filtered query, plus a looser plain-text fallback. */
export function buildSearchQueries(q: TrackQuery): { strict: string; loose?: string } {
  if (q.query?.trim()) return { strict: q.query.trim() };
  const parts: string[] = [];
  if (q.title?.trim()) parts.push(`track:"${cleanTerm(q.title)}"`);
  if (q.artist?.trim()) parts.push(`artist:"${cleanTerm(q.artist)}"`);
  if (q.album?.trim()) parts.push(`album:"${cleanTerm(q.album)}"`);
  if (q.year?.trim()) parts.push(`year:${cleanTerm(q.year)}`);
  if (parts.length === 0) throw new SpotifyError("Give at least a title, artist, album or query.");
  const loose = [q.title, q.artist, q.album]
    .filter((x): x is string => Boolean(x?.trim()))
    .map(cleanTerm)
    .join(" ");
  return { strict: parts.join(" "), loose: loose || undefined };
}

function loopbackOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" ? value.replace(/\/$/, "") : undefined;
  } catch {
    return undefined;
  }
}

interface PlaylistItemsPage {
  next?: string | null;
  total?: number;
  items?: Array<{ item?: RawItem | null; track?: RawItem | null }>;
}

interface RawItem {
  id?: string | null;
  name?: string;
  type?: string;
  artists?: Array<{ name: string }>;
}

const ITEM_FIELDS = "next,total,items(item(id,name,type,artists(name)),track(id,name,type,artists(name)))";

export class Spotify {
  private readonly accountsBase: string;
  private readonly apiBase: string;
  private cachedToken?: string;
  private refreshing?: Promise<string>;
  // Trimming playlist reads with `fields` keeps them small. Spotify renamed the per-entry
  // field from "track" to "item" in 2026, so ask for both; if Spotify rejects the filter,
  // fall back to full responses for the rest of this request.
  private useFieldsFilter = true;

  constructor(private readonly env: Env) {
    this.accountsBase = loopbackOnly(env.SPOTIFY_ACCOUNTS_BASE) ?? "https://accounts.spotify.com";
    this.apiBase = loopbackOnly(env.SPOTIFY_API_BASE) ?? "https://api.spotify.com/v1";
  }

  authorizeUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.env.SPOTIFY_CLIENT_ID ?? "",
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES.join(" "),
      state,
      show_dialog: "true",
    });
    return `${this.accountsBase}/authorize?${params}`;
  }

  private async tokenRequest(body: URLSearchParams): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  }> {
    const res = await fetch(`${this.accountsBase}/api/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${this.env.SPOTIFY_CLIENT_ID}:${this.env.SPOTIFY_CLIENT_SECRET}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const detail = String(data.error_description ?? data.error ?? res.statusText);
      if (data.error === "invalid_grant") {
        throw new NotConnectedError(
          `Spotify rejected the saved sign-in (${detail}). Sign in again on the connector's home page.`,
          res.status,
        );
      }
      throw new SpotifyError(`Spotify token request failed: ${detail}`, res.status);
    }
    return data as never;
  }

  private async cacheAccessToken(token: string, expiresIn: number): Promise<void> {
    this.cachedToken = token;
    // Expire the shared copy two minutes early (KV's minimum TTL is 60 s). Caching is an
    // optimisation, so a failed write (e.g. KV's one-write-per-second-per-key limit) is ignored.
    const ttl = Math.max(60, Math.floor(expiresIn) - 120);
    try {
      await this.env.KV.put(KV_KEYS.accessToken, token, { expirationTtl: ttl });
    } catch (err) {
      console.warn("Could not cache access token", err);
    }
  }

  /** Exchanges the one-time sign-in code for tokens and stores them. */
  async completeSignIn(code: string, redirectUri: string): Promise<{ id: string; display_name?: string }> {
    const tokens = await this.tokenRequest(
      new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    );
    if (!tokens.refresh_token) throw new SpotifyError("Spotify did not return a refresh token.");
    const granted = new Set((tokens.scope ?? "").split(" ").filter(Boolean));
    const missing = SCOPES.filter((s) => !granted.has(s));
    if (missing.length) throw new SpotifyError(`Spotify did not grant: ${missing.join(", ")}`);

    await this.env.KV.put(KV_KEYS.refreshToken, tokens.refresh_token);
    await this.cacheAccessToken(tokens.access_token, tokens.expires_in);
    const me = (await this.request("GET", "/me")) as { id: string; display_name?: string };
    await this.env.KV.put(KV_KEYS.user, JSON.stringify({ id: me.id, display_name: me.display_name }));
    return me;
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      if (this.cachedToken) return this.cachedToken;
      const shared = await this.env.KV.get(KV_KEYS.accessToken);
      if (shared) return (this.cachedToken = shared);
    }
    // One refresh at a time per request, however many calls are waiting on it.
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    this.cachedToken = undefined;
    const saved = await this.env.KV.get(KV_KEYS.refreshToken);
    if (!saved) {
      throw new NotConnectedError(
        "Spotify isn't connected yet. Sign in on the connector's home page first (if you just did, wait a minute and try again).",
      );
    }
    const tokens = await this.tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved }));
    // Spotify may rotate the refresh token; keep the newest one.
    if (tokens.refresh_token && tokens.refresh_token !== saved) {
      await this.env.KV.put(KV_KEYS.refreshToken, tokens.refresh_token);
    }
    await this.cacheAccessToken(tokens.access_token, tokens.expires_in);
    return tokens.access_token;
  }

  async request(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<unknown> {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let token = await this.accessToken();
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.accessToken(true);
        continue;
      }
      if (res.status === 429 && attempt < 2) {
        const wait = Number(res.headers.get("Retry-After") ?? "1");
        if (wait <= 10) {
          await new Promise((r) => setTimeout(r, Math.max(1, wait) * 1000));
          continue;
        }
      }
      // Retry server errors once, but only for reads: repeating a POST could add tracks twice.
      if (res.status >= 500 && method === "GET" && attempt === 0) continue;

      if (res.status === 204) return {};
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) {
        const msg = data.error?.message ?? res.statusText;
        throw new SpotifyError(`Spotify ${method} ${path} failed (${res.status}): ${msg}`, res.status);
      }
      return data;
    }
    throw new SpotifyError(`Spotify ${method} ${path} failed after retries.`);
  }

  async searchTracks(q: string, limit: number): Promise<TrackSummary[]> {
    // No market parameter: with a user token, Spotify applies the account's country itself,
    // and the old market=from_token form now needs an extra scope.
    const data = (await this.request("GET", "/search", {
      query: { q, type: "track", limit: String(limit) },
    })) as { tracks?: { items?: unknown[] } };
    return (data.tracks?.items ?? []).filter(Boolean).map(summarizeTrack);
  }

  async getTrack(id: string): Promise<TrackSummary & { requested_id?: string; note?: string }> {
    const t = summarizeTrack(await this.request("GET", `/tracks/${id}`));
    if (t.id !== id) {
      return {
        ...t,
        requested_id: id,
        note: "Spotify substituted the playable version of this track in your country; use the returned id.",
      };
    }
    return t;
  }

  /** An album's details and its tracks in order (`count` tracks from `start`, 50 per request). */
  async getAlbum(id: string, start: number, count: number): Promise<AlbumListing> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (await this.request("GET", `/albums/${id}`)) as any;
    const tracks: AlbumTrack[] = [];
    let offset = start;
    while (tracks.length < count) {
      const limit = Math.min(50, count - tracks.length);
      const page = (await this.request("GET", `/albums/${id}/tracks`, {
        query: { limit: String(limit), offset: String(offset) },
      })) as { items?: any[]; next?: string | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const items = (page.items ?? []).filter(Boolean);
      for (const t of items) {
        tracks.push({
          disc_number: t.disc_number,
          track_number: t.track_number,
          id: t.id,
          name: t.name,
          artists: (t.artists ?? []).map((x: { name: string }) => x.name),
          duration: formatDuration(t.duration_ms),
          link: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
        });
      }
      offset += items.length;
      if (!page.next || items.length === 0) break;
    }
    return {
      album_id: id,
      name: a.name,
      artists: (a.artists ?? []).map((x: { name: string }) => x.name),
      album_type: a.album_type,
      release_date: a.release_date,
      total_tracks: a.total_tracks ?? tracks.length,
      link: a.external_urls?.spotify ?? `https://open.spotify.com/album/${id}`,
      offset: start,
      tracks,
    };
  }

  async createPlaylist(name: string, description: string | undefined): Promise<{ id: string; link: string }> {
    const body: Record<string, unknown> = { name, public: false };
    if (description) body.description = description;
    const p = (await this.request("POST", "/me/playlists", { body })) as {
      id: string;
      external_urls?: { spotify?: string };
    };
    return { id: p.id, link: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}` };
  }

  /**
   * Adds tracks in order, 100 per request (Spotify's limit). Returns how many were added
   * before any failure, so callers can report a partial result instead of hiding it.
   */
  async addTracks(
    playlistId: string,
    trackIds: string[],
    position?: number,
  ): Promise<{ added: number; error?: string }> {
    let added = 0;
    try {
      for (let i = 0; i < trackIds.length; i += 100) {
        const chunk = trackIds.slice(i, i + 100);
        const body: Record<string, unknown> = { uris: chunk.map((id) => `spotify:track:${id}`) };
        if (position !== undefined) body.position = position + i;
        await this.request("POST", `/playlists/${playlistId}/items`, { body });
        added += chunk.length;
      }
      return { added };
    } catch (err) {
      return { added, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getPlaylistName(playlistId: string): Promise<{ name: string; link: string }> {
    const p = (await this.request("GET", `/playlists/${playlistId}`, {
      query: { fields: "name,external_urls" },
    })) as { name: string; external_urls?: { spotify?: string } };
    return { name: p.name, link: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlistId}` };
  }

  private async itemsPage(playlistId: string, offset: number, limit: number): Promise<PlaylistItemsPage> {
    const query: Record<string, string> = { limit: String(limit), offset: String(offset) };
    if (this.useFieldsFilter) {
      try {
        return (await this.request("GET", `/playlists/${playlistId}/items`, {
          query: { ...query, fields: ITEM_FIELDS },
        })) as PlaylistItemsPage;
      } catch (err) {
        if (!(err instanceof SpotifyError && err.status === 400)) throw err;
        this.useFieldsFilter = false;
      }
    }
    return (await this.request("GET", `/playlists/${playlistId}/items`, { query })) as PlaylistItemsPage;
  }

  /** The number of items in a playlist, in one small request. */
  async playlistLength(playlistId: string): Promise<number> {
    const page = await this.itemsPage(playlistId, 0, 1);
    if (typeof page.total === "number") return page.total;
    throw new SpotifyError("Spotify didn't report the playlist's length.");
  }

  /** Reads `count` items starting at `start` (or to the end), in order. */
  async getPlaylistTracks(playlistId: string, start = 0, count = Infinity): Promise<{ tracks: PlaylistTrack[]; total?: number }> {
    const out: PlaylistTrack[] = [];
    let total: number | undefined;
    let offset = start;
    while (out.length < count) {
      const limit = Math.min(50, count - out.length);
      const page = await this.itemsPage(playlistId, offset, limit);
      if (typeof page.total === "number") total = page.total;
      const items = page.items ?? [];
      for (const entry of items) {
        const t = entry.item ?? entry.track ?? null;
        out.push({
          position: start + out.length,
          id: t?.id ?? null,
          name: t?.name ?? "(unavailable)",
          artists: (t?.artists ?? []).map((a) => a.name),
          type: t?.type ?? "unknown",
        });
      }
      offset += items.length;
      if (!page.next || items.length === 0) break;
    }
    return { tracks: out, total };
  }
}
