// A tiny stand-in for Spotify's accounts service and Web API, for local tests only.
// It mimics the 2026 API shapes: /playlists/{id}/items with entries under "item",
// search limit capped at 10, playlist-items limit capped at 50, add capped at 100.

import http from "node:http";

export const CLIENT_ID = "test-client-id";
export const CLIENT_SECRET = "test-client-secret";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function makeId(seed) {
  let x = seed * 2654435761;
  let s = "";
  for (let i = 0; i < 22; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += ALPHABET[x % 62];
  }
  return s;
}

function track(seed, name, artist, album, albumType, date, ms) {
  const id = makeId(seed);
  return {
    id,
    name,
    type: "track",
    uri: `spotify:track:${id}`,
    duration_ms: ms,
    explicit: false,
    artists: [{ name: artist }],
    album: { name: album, album_type: albumType, release_date: date, images: [{ url: "https://i.example/x.jpg" }] },
    external_ids: { isrc: `TEST${seed}` },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  };
}

export const CATALOG = [
  track(1, "Bohemian Rhapsody", "Queen", "A Night at the Opera", "album", "1975-11-21", 354320),
  track(2, "Bohemian Rhapsody - Live Aid", "Queen", "Live Aid", "compilation", "1985-07-13", 365000),
  track(3, "Hey Jude - Remastered 2015", "The Beatles", "1", "compilation", "2000-11-13", 425653),
  track(4, "Hey Jude", "The Beatles", "Hey Jude", "single", "1968-08-26", 431333),
  track(5, "Paranoid Android", "Radiohead", "OK Computer", "album", "1997-05-21", 387213),
  track(6, "Karma Police", "Radiohead", "OK Computer", "album", "1997-05-21", 264066),
  track(7, "Strobe", "deadmau5", "For Lack of a Better Name", "album", "2009-10-06", 637000),
];

export const UNKNOWN_ID = makeId(777);
export const RELINKED_ID = makeId(500);

export function startMock(port) {
  const state = {
    codes: new Set(),
    validTokens: new Set(),
    refreshToken: "rt-1",
    tokenCounter: 0,
    grants: [],
    playlists: new Map(),
    rateLimitNext: 0,
    requests: [],
  };
  // A track ID that Spotify relinks to another version when a market is given.
  state.relinks = { [makeId(500)]: CATALOG[1].id };
  // A playlist owned by the user that the connector did NOT create.
  state.playlists.set(makeId(999), { name: "Someone else's", items: [CATALOG[0].id] });

  const issueToken = () => {
    const t = `at-${++state.tokenCounter}`;
    state.validTokens.add(t);
    return t;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let body = "";
    for await (const chunk of req) body += chunk;
    state.requests.push(`${req.method} ${url.pathname}`);

    const send = (status, data, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };

    // ---- test controls
    if (url.pathname === "/__expire") {
      state.validTokens.clear();
      return send(200, { ok: true });
    }
    if (url.pathname === "/__ratelimit") {
      state.rateLimitNext = Number(url.searchParams.get("n") ?? "1");
      return send(200, { ok: true });
    }
    if (url.pathname === "/__rejectfields") {
      state.rejectFields = true;
      return send(200, { ok: true });
    }
    if (url.pathname === "/__state") {
      return send(200, { grants: state.grants, requests: state.requests });
    }

    // ---- accounts service
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") !== CLIENT_ID) return send(400, { error: "invalid_client" });
      const scopes = (p.get("scope") ?? "").split(" ");
      if (!scopes.includes("playlist-modify-private")) return send(400, { error: "bad scope" });
      const code = `code-${Math.random().toString(36).slice(2)}`;
      state.codes.add(code);
      const back = new URL(p.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state"));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/api/token" && req.method === "POST") {
      const expected = "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
      if (req.headers.authorization !== expected) return send(401, { error: "invalid_client" });
      const form = new URLSearchParams(body);
      state.grants.push(form.get("grant_type"));
      if (form.get("grant_type") === "authorization_code") {
        if (!state.codes.delete(form.get("code"))) return send(400, { error: "invalid_grant" });
        return send(200, {
          access_token: issueToken(),
          refresh_token: state.refreshToken,
          expires_in: 3600,
          token_type: "Bearer",
          scope: "playlist-read-private playlist-modify-private",
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== state.refreshToken) {
          return send(400, { error: "invalid_grant", error_description: "Refresh token revoked" });
        }
        return send(200, { access_token: issueToken(), expires_in: 3600, token_type: "Bearer" });
      }
      return send(400, { error: "unsupported_grant_type" });
    }

    // ---- Web API
    if (!url.pathname.startsWith("/v1/")) return send(404, { error: { message: "not found" } });
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!state.validTokens.has(token)) {
      return send(401, { error: { status: 401, message: "The access token expired" } });
    }
    const path = url.pathname.slice(3);

    if (path === "/me") return send(200, { id: "testuser", display_name: "Test User" });

    if (path === "/search") {
      if (state.rateLimitNext > 0) {
        state.rateLimitNext--;
        return send(429, { error: { message: "rate limited" } }, { "Retry-After": "1" });
      }
      const limit = Number(url.searchParams.get("limit") ?? "5");
      if (limit > 10) return send(400, { error: { message: "Invalid limit" } });
      if (url.searchParams.get("type") !== "track") return send(400, { error: { message: "bad type" } });
      const q = url.searchParams.get("q") ?? "";
      const filters = {};
      const free = q
        .replace(/(track|artist|album|year):"([^"]*)"|(track|artist|album|year):(\S+)/g, (_, k1, v1, k2, v2) => {
          filters[k1 ?? k2] = (v1 ?? v2).toLowerCase();
          return " ";
        })
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const items = CATALOG.filter((t) => {
        if (filters.track && !t.name.toLowerCase().includes(filters.track)) return false;
        if (filters.artist && !t.artists[0].name.toLowerCase().includes(filters.artist)) return false;
        if (filters.album && !t.album.name.toLowerCase().includes(filters.album)) return false;
        if (filters.year && !t.album.release_date.startsWith(filters.year)) return false;
        const hay = `${t.name} ${t.artists[0].name} ${t.album.name}`.toLowerCase();
        return free.every((w) => hay.includes(w));
      });
      return send(200, { tracks: { items: items.slice(0, limit), total: items.length } });
    }

    let m = /^\/tracks\/([0-9A-Za-z]{22})$/.exec(path);
    if (m) {
      const wanted = url.searchParams.get("market") ? (state.relinks[m[1]] ?? m[1]) : m[1];
      const t = CATALOG.find((x) => x.id === wanted);
      return t ? send(200, t) : send(404, { error: { message: "Non existing id" } });
    }

    if (path === "/me/playlists" && req.method === "POST") {
      const data = JSON.parse(body);
      if (data.public !== false) return send(400, { error: { message: "test expects private" } });
      const id = makeId(100 + state.playlists.size);
      state.playlists.set(id, { name: data.name, description: data.description, items: [] });
      return send(201, { id, name: data.name, external_urls: { spotify: `https://open.spotify.com/playlist/${id}` } });
    }

    m = /^\/playlists\/([0-9A-Za-z]{22})(\/items)?$/.exec(path);
    if (m) {
      const p = state.playlists.get(m[1]);
      if (!p) return send(404, { error: { message: "Not found" } });
      if (!m[2] && req.method === "GET") {
        return send(200, { name: p.name, external_urls: { spotify: `https://open.spotify.com/playlist/${m[1]}` } });
      }
      if (m[2] && req.method === "POST") {
        const data = JSON.parse(body);
        if (!Array.isArray(data.uris) || data.uris.length > 100) return send(400, { error: { message: "Too many" } });
        const ids = data.uris.map((u) => u.replace("spotify:track:", ""));
        if (ids.some((id) => !CATALOG.find((t) => t.id === id))) {
          return send(400, { error: { message: "Invalid track uri" } });
        }
        const pos = data.position ?? p.items.length;
        p.items.splice(pos, 0, ...ids);
        return send(201, { snapshot_id: "snap" });
      }
      if (m[2] && req.method === "GET") {
        if (state.rejectFields && url.searchParams.has("fields")) {
          return send(400, { error: { message: "Invalid fields" } });
        }
        const limit = Number(url.searchParams.get("limit") ?? "20");
        if (limit > 50) return send(400, { error: { message: "Invalid limit" } });
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const page = p.items.slice(offset, offset + limit).map((id) => ({
          added_at: "2026-11-24T00:00:00Z",
          item: CATALOG.find((t) => t.id === id),
        }));
        const next =
          offset + limit < p.items.length
            ? `http://127.0.0.1:${port}/v1/playlists/${m[1]}/items?offset=${offset + limit}&limit=${limit}`
            : null;
        return send(200, { items: page, next, total: p.items.length, limit, offset });
      }
    }
    return send(404, { error: { message: `mock has no ${req.method} ${path}` } });
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state })));
}
