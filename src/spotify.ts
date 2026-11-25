// Spotify Web API client: token handling, track search, and playlist writes.
// Only the endpoints this connector needs are wrapped here.

export interface Env {
  KV: KVNamespace;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  CONNECTOR_KEY?: string;
  // Local testing only (point at a mock server in .dev.vars). Leave unset in production.
  SPOTIFY_ACCOUNTS_BASE?: string;
  SPOTIFY_API_BASE?: string;
}

// The only permissions requested from Spotify: create/edit private playlists and read them back.
export const SCOPES = ["playlist-modify-private", "playlist-read-private"];

export const KV_KEYS = {
  refreshToken: "spotify:refresh_token",
  accessToken: "spotify:access_token",
  user: "spotify:user",
  statePrefix: "oauth_state:",
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
  album_type?: string;
  release_date?: string;
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

const TRACK_ID = /^[0-9A-Za-z]{22}$/;

/** Accepts a bare track ID, a spotify:track: URI, or an open.spotify.com track link. */
export function parseTrackId(input: string): string {
  const s = input.trim();
  if (TRACK_ID.test(s)) return s;
  const uri = /^spotify:track:([0-9A-Za-z]{22})$/.exec(s);
  if (uri) return uri[1];
  try {
    const url = new URL(s);
    if (url.hostname === "open.spotify.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const i = parts.indexOf("track");
      if (i !== -1 && TRACK_ID.test(parts[i + 1] ?? "")) return parts[i + 1];
    }
  } catch {
    // not a URL
  }
  throw new SpotifyError(`Not a Spotify track ID, URI or link: "${input}"`);
}

/** Same as parseTrackId, but for playlists. */
export function parsePlaylistId(input: string): string {
  const s = input.trim();
  if (TRACK_ID.test(s)) return s;
  const uri = /^spotify:playlist:([0-9A-Za-z]{22})$/.exec(s);
  if (uri) return uri[1];
  try {
    const url = new URL(s);
    if (url.hostname === "open.spotify.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const i = parts.indexOf("playlist");
      if (i !== -1 && TRACK_ID.test(parts[i + 1] ?? "")) return parts[i + 1];
    }
  } catch {
    // not a URL
  }
  throw new SpotifyError(`Not a Spotify playlist ID, URI or link: "${input}"`);
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
    album_type: t.album?.album_type,
    release_date: t.album?.release_date,
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

export class Spotify {
  constructor(private readonly env: Env) {}

  private get accountsBase(): string {
    return this.env.SPOTIFY_ACCOUNTS_BASE ?? "https://accounts.spotify.com";
  }

  private get apiBase(): string {
    return this.env.SPOTIFY_API_BASE ?? "https://api.spotify.com/v1";
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
      const detail = (data.error_description ?? data.error ?? res.statusText) as string;
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
    // Expire the cached copy two minutes early; KV's minimum TTL is 60 seconds.
    const ttl = Math.max(60, Math.floor(expiresIn) - 120);
    await this.env.KV.put(KV_KEYS.accessToken, token, { expirationTtl: ttl });
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
      const cached = await this.env.KV.get(KV_KEYS.accessToken);
      if (cached) return cached;
    }
    const refresh = await this.env.KV.get(KV_KEYS.refreshToken);
    if (!refresh) {
      throw new NotConnectedError("Spotify isn't connected yet. Sign in on the connector's home page first.");
    }
    const tokens = await this.tokenRequest(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    );
    // Spotify may rotate the refresh token; keep the newest one.
    if (tokens.refresh_token && tokens.refresh_token !== refresh) {
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
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });

      if (res.status === 401 && attempt === 0) {
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

  async searchTracks(q: string, limit: number, offset = 0): Promise<TrackSummary[]> {
    const data = (await this.request("GET", "/search", {
      // market=from_token keeps results to tracks playable in the signed-in account's country.
      query: { q, type: "track", limit: String(limit), offset: String(offset), market: "from_token" },
    })) as { tracks?: { items?: unknown[] } };
    return (data.tracks?.items ?? []).filter(Boolean).map(summarizeTrack);
  }

  async getTrack(id: string): Promise<TrackSummary> {
    return summarizeTrack(await this.request("GET", `/tracks/${id}`, { query: { market: "from_token" } }));
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

  /** Adds tracks in order, 100 per request (Spotify's limit). */
  async addTracks(playlistId: string, trackIds: string[], position?: number): Promise<void> {
    for (let i = 0; i < trackIds.length; i += 100) {
      const chunk = trackIds.slice(i, i + 100);
      const body: Record<string, unknown> = { uris: chunk.map((id) => `spotify:track:${id}`) };
      if (position !== undefined) body.position = position + i;
      await this.request("POST", `/playlists/${playlistId}/items`, { body });
    }
  }

  async getPlaylistName(playlistId: string): Promise<{ name: string; link: string }> {
    const p = (await this.request("GET", `/playlists/${playlistId}`, {
      query: { fields: "name,external_urls" },
    })) as { name: string; external_urls?: { spotify?: string } };
    return { name: p.name, link: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlistId}` };
  }

  /** Reads every item of a playlist back, in order. */
  async getPlaylistTracks(playlistId: string): Promise<PlaylistTrack[]> {
    const out: PlaylistTrack[] = [];
    for (let offset = 0; offset < 10000; offset += 50) {
      const page = await this.playlistItemsPage(playlistId, offset);
      const items = page.items ?? [];
      for (const entry of items) {
        const t = entry.item ?? entry.track ?? null;
        out.push({
          position: out.length,
          id: t?.id ?? null,
          name: t?.name ?? "(unavailable)",
          artists: (t?.artists ?? []).map((a) => a.name),
          type: t?.type ?? "unknown",
        });
      }
      if (!page.next || items.length === 0) break;
    }
    return out;
  }

  // Trimming the response with `fields` keeps each read small. Spotify renamed the per-entry
  // field from "track" to "item" in 2026, so ask for both; if Spotify rejects the filter,
  // fall back to the full response.
  private static fieldsFilterRejected = false;

  private async playlistItemsPage(playlistId: string, offset: number): Promise<PlaylistItemsPage> {
    const query: Record<string, string> = { limit: "50", offset: String(offset) };
    if (!Spotify.fieldsFilterRejected) {
      try {
        return (await this.request("GET", `/playlists/${playlistId}/items`, {
          query: { ...query, fields: "next,items(item(id,name,type,artists(name)),track(id,name,type,artists(name)))" },
        })) as PlaylistItemsPage;
      } catch (err) {
        if (!(err instanceof SpotifyError && err.status === 400)) throw err;
        Spotify.fieldsFilterRejected = true;
      }
    }
    return (await this.request("GET", `/playlists/${playlistId}/items`, { query })) as PlaylistItemsPage;
  }
}

interface PlaylistItemsPage {
  next?: string | null;
  items?: Array<{ item?: RawItem | null; track?: RawItem | null }>;
}

interface RawItem {
  id?: string | null;
  name?: string;
  type?: string;
  artists?: Array<{ name: string }>;
}
