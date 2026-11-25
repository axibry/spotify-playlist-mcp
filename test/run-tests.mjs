// End-to-end test: runs the Worker under `wrangler dev` against the mock Spotify,
// drives both sign-in flows over HTTP, and calls every tool through the official MCP client.
// It never touches your .dev.vars or .wrangler/state: settings are passed as --var flags and
// local storage goes to a temporary folder.
//
//   npm test

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CATALOG, CLIENT_ID, CLIENT_SECRET, RELINKED_ID, UNKNOWN_ID, startMock } from "./mock-spotify.mjs";

const MOCK_PORT = 8790;
const WORKER_PORT = 8787;
const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = "k".repeat(20) + "-test-connector-key-0123456789";
const id = (i) => CATALOG[i].id;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n${err.stack}`);
    process.exitCode = 1;
    throw err;
  }
}

const text = (result) => result.content.map((c) => c.text).join("\n");
function data(result) {
  assert.ok(!result.isError, `tool returned an error: ${text(result)}`);
  return JSON.parse(text(result));
}
const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function waitForWorker() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/`)).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
}

async function connect(token) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function rawMcp(body, headers = {}) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Registers an OAuth client and walks the consent page the way Claude's connect flow does.
async function oauthAuthorize({ redirect = "http://127.0.0.1:9999/cb", key = KEY, decision = "approve" } = {}) {
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(reg.status, 201, await reg.clone().text());
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id,
    redirect_uri: redirect,
    scope: "playlists",
    state: "st-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  })) {
    auth.searchParams.set(k, v);
  }
  const pageRes = await fetch(auth, { redirect: "manual" });
  const html = await pageRes.text();
  assert.equal(pageRes.status, 200, html);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(handle, "consent page has a handle");
  const post = () =>
    fetch(`${BASE}/authorize`, {
      method: "POST",
      headers: { Cookie: cookiesFrom(pageRes) },
      body: new URLSearchParams({ handle, key, decision }),
      redirect: "manual",
    });
  return { client_id, verifier, redirect, html, post, handle, cookie: cookiesFrom(pageRes) };
}

async function exchangeCode({ client_id, verifier, redirect }, location) {
  const code = new URL(location).searchParams.get("code");
  const res = await fetch(`${BASE}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

const { server: mock, state } = await startMock(MOCK_PORT);
const persistDir = mkdtempSync(join(tmpdir(), "spotify-mcp-test-"));
const vars = {
  SPOTIFY_CLIENT_ID: CLIENT_ID,
  SPOTIFY_CLIENT_SECRET: CLIENT_SECRET,
  CONNECTOR_KEY: KEY,
  SPOTIFY_ACCOUNTS_BASE: MOCK,
  SPOTIFY_API_BASE: `${MOCK}/v1`,
};
const worker = spawn(
  "npx",
  [
    "wrangler", "dev", "--port", String(WORKER_PORT), "--ip", "127.0.0.1", "--persist-to", persistDir,
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ],
  {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so wrangler and workerd can be stopped together
  },
);
let workerLog = "";
worker.stdout.on("data", (d) => (workerLog += d));
worker.stderr.on("data", (d) => (workerLog += d));

try {
  await waitForWorker();
  console.log("Worker running; testing:");

  // ------------------------------------------------------------ access control

  await test("home page shows the redirect URI and connector URL", async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert.match(html, new RegExp(`${BASE}/callback`));
    assert.match(html, new RegExp(`${BASE}/mcp`));
    assert.match(html, /Sign in with Spotify/);
  });

  await test("MCP endpoint rejects missing and wrong credentials with an OAuth challenge", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const none = await rawMcp(ping);
    assert.equal(none.status, 401);
    assert.match(none.headers.get("WWW-Authenticate"), /resource_metadata=/);
    for (const auth of ["Bearer wrong", `Bearer ${KEY}x`, `Bearer ${KEY.slice(0, -1)}`, KEY]) {
      assert.equal((await rawMcp(ping, { Authorization: auth })).status, 401, auth);
    }
  });

  await test("publishes OAuth discovery for this Worker's own URL", async () => {
    const meta = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(meta.resource, `${BASE}/mcp`);
    const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.authorization_endpoint, `${BASE}/authorize`);
    assert.equal(as.registration_endpoint, `${BASE}/register`);
  });

  // ------------------------------------------------------------ Claude's OAuth connection

  await test("client registration only accepts Claude's callback or loopback", async () => {
    for (const [uri, ok] of [
      ["https://claude.ai/api/mcp/auth_callback", true],
      ["http://localhost:3333/callback", true],
      ["https://evil.example/cb", false],
      ["https://claude.ai/somewhere-else", false],
    ]) {
      const r = await fetch(`${BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris: [uri], token_endpoint_auth_method: "none" }),
      });
      assert.equal(r.status === 201, ok, `${uri} -> ${r.status}`);
    }
  });

  await test("consent page names the app and where access goes", async () => {
    const { html } = await oauthAuthorize();
    assert.match(html, /Allow Test Client to make Spotify playlists\?/);
    assert.match(html, /isn&#39;t verified|isn't verified/);
    assert.match(html, /<strong>127\.0\.0\.1<\/strong>/);
    assert.match(html, /app on your computer/);
  });

  await test("consent with a wrong key is refused, and the same page then works with the right key", async () => {
    const flow = await oauthAuthorize();
    const bad = await fetch(`${BASE}/authorize`, {
      method: "POST",
      headers: { Cookie: flow.cookie },
      body: new URLSearchParams({ handle: flow.handle, key: "wrong", decision: "approve" }),
      redirect: "manual",
    });
    assert.equal(bad.status, 403);
    const res = await flow.post();
    assert.equal(res.status, 302);
    const location = res.headers.get("Location");
    assert.match(location, /^http:\/\/127\.0\.0\.1:9999\/cb\?/);
    assert.equal(new URL(location).searchParams.get("state"), "st-123");
  });

  await test("denying consent sends access_denied back to the app", async () => {
    const res = await (await oauthAuthorize({ decision: "deny" })).post();
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("Location")).searchParams.get("error"), "access_denied");
  });

  await test("a consent form can't be submitted without the browser's binding cookie", async () => {
    const flow = await oauthAuthorize();
    const handle = /name="handle" value="([^"]+)"/.exec(flow.html)[1];
    const res = await fetch(`${BASE}/authorize`, {
      method: "POST",
      body: new URLSearchParams({ handle, key: KEY, decision: "approve" }),
      redirect: "manual",
    });
    assert.notEqual(res.status, 302);
  });

  let oauthToken;
  await test("the OAuth token works for MCP calls", async () => {
    const flow = await oauthAuthorize();
    const res = await flow.post();
    const tokens = await exchangeCode(flow, res.headers.get("Location"));
    assert.ok(tokens.access_token && tokens.refresh_token);
    oauthToken = tokens.access_token;
    const client = await connect(oauthToken);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    await client.close();
  });

  await test("the connector key itself is never accepted as a token", async () => {
    const r = await rawMcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: `Bearer ${KEY}` });
    assert.equal(r.status, 401);
  });

  await test("MCP endpoint refuses GET and JSON-RPC batches", async () => {
    const g = await fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${oauthToken}`, Accept: "text/event-stream" } });
    assert.equal(g.status, 405);
    const b = await rawMcp([{ jsonrpc: "2.0", id: 1, method: "ping" }], { Authorization: `Bearer ${oauthToken}` });
    assert.equal(b.status, 400);
  });

  // ------------------------------------------------------------ Spotify sign-in

  await test("tools report 'not connected' before Spotify sign-in", async () => {
    const client = await connect(oauthToken);
    const r = await client.callTool({ name: "search_tracks", arguments: { requests: [{ title: "Strobe" }] } });
    assert.ok(r.isError);
    assert.match(text(r), /isn't connected/);
    await client.close();
  });

  await test("Spotify sign-in rejects a wrong connector key", async () => {
    const r = await fetch(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ key: "nope" }), redirect: "manual" });
    assert.equal(r.status, 403);
  });

  let signin;
  await test("Spotify sign-in with the right key completes and stores the account", async () => {
    const r = await fetch(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ key: KEY }), redirect: "manual" });
    assert.equal(r.status, 303);
    const authorize = new URL(r.headers.get("Location"));
    assert.equal(authorize.origin, MOCK);
    assert.equal(authorize.searchParams.get("redirect_uri"), `${BASE}/callback`);
    assert.equal(authorize.searchParams.get("scope"), "playlist-modify-private playlist-read-private");
    const back = await fetch(authorize, { redirect: "manual" });
    signin = { url: back.headers.get("Location"), cookie: cookiesFrom(r) };
    const done = await fetch(signin.url, { headers: { Cookie: signin.cookie } });
    const html = await done.text();
    assert.equal(done.status, 200, html);
    assert.match(html, /Signed in to Spotify as Test User \(testuser\)/);
  });

  await test("Spotify callback rejects missing, forged or mismatched sign-in cookies", async () => {
    assert.equal((await fetch(signin.url)).status, 400);
    const [state, exp] = signin.cookie.split("=")[1].split(".");
    const forged = `__Host-spotify-signin=${state}.${exp}.${"0".repeat(64)}`;
    assert.equal((await fetch(signin.url, { headers: { Cookie: forged } })).status, 400);
    const other = new URL(signin.url);
    other.searchParams.set("state", "f".repeat(64));
    assert.equal((await fetch(other, { headers: { Cookie: signin.cookie } })).status, 400);
    // A replayed code is refused by Spotify itself.
    assert.notEqual((await fetch(signin.url, { headers: { Cookie: signin.cookie } })).status, 200);
  });

  // ------------------------------------------------------------ tools

  const client = await connect(oauthToken);

  await test("lists exactly the six intended tools, with workflow instructions", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "add_tracks_to_playlist",
      "create_playlist",
      "get_playlist",
      "get_track",
      "list_created_playlists",
      "search_tracks",
    ]);
    assert.match(client.getInstructions() ?? "", /Never add a track the user did not ask for/);
    assert.equal(tools.find((t) => t.name === "search_tracks").annotations.readOnlyHint, true);
  });

  await test("search_tracks returns candidates per request, with no-match and per-item errors", async () => {
    const out = data(
      await client.callTool({
        name: "search_tracks",
        arguments: {
          requests: [
            { title: "Bohemian Rhapsody", artist: "Queen" },
            { title: "Paranoid Android", artist: "Radiohead" },
            { title: "Does Not Exist", artist: "Nobody" },
            { query: "karma police" },
            {},
          ],
        },
      }),
    );
    assert.equal(out.results.length, 5);
    assert.deepEqual(out.results[0].candidates.map((c) => c.id), [id(0), id(1)]);
    assert.equal(out.results[0].candidates[0].album, "A Night at the Opera");
    assert.equal(out.results[0].candidates[0].duration, "5:54");
    assert.equal(out.results[0].query_used, 'track:"Bohemian Rhapsody" artist:"Queen"');
    assert.equal(out.results[1].candidates[0].id, id(4));
    assert.equal(out.results[2].candidates.length, 0);
    assert.equal(out.results[3].candidates[0].id, id(5));
    assert.match(out.results[4].error, /at least a title/);
  });

  await test("search_tracks caps a call at 10 requests", async () => {
    const r = await client.callTool({
      name: "search_tracks",
      arguments: { requests: Array.from({ length: 11 }, () => ({ title: "Strobe" })) },
    });
    assert.ok(r.isError);
  });

  await test("search falls back to plain text when field filters find nothing", async () => {
    const out = data(
      await client.callTool({ name: "search_tracks", arguments: { requests: [{ title: "Hey Jude Remastered", artist: "Beatles" }] } }),
    );
    assert.equal(out.results[0].query_used, "Hey Jude Remastered Beatles");
    assert.equal(out.results[0].candidates[0].id, id(2));
  });

  await test("get_track accepts IDs, URIs and links, and reports bad items without losing the rest", async () => {
    const out = data(
      await client.callTool({
        name: "get_track",
        arguments: {
          tracks: [id(6), `spotify:track:${id(3)}`, `https://open.spotify.com/intl-de/track/${id(4)}?si=abc`, UNKNOWN_ID, "junk"],
        },
      }),
    );
    assert.deepEqual(out.tracks.slice(0, 3).map((t) => t.name), ["Strobe", "Hey Jude", "Paranoid Android"]);
    assert.match(out.tracks[3].error, /404/);
    assert.match(out.tracks[4].error, /Not a Spotify track/);
  });

  await test("get_track flags a track Spotify relinks to another version", async () => {
    const out = data(await client.callTool({ name: "get_track", arguments: { tracks: [RELINKED_ID] } }));
    assert.equal(out.tracks[0].id, id(1));
    assert.equal(out.tracks[0].requested_id, RELINKED_ID);
  });

  let playlistId;
  await test("create_playlist creates a private playlist and verifies it", async () => {
    const out = data(
      await client.callTool({
        name: "create_playlist",
        arguments: { name: "Test mix", description: "line one\nline two", tracks: [id(0), id(4), id(6)] },
      }),
    );
    playlistId = out.playlist_id;
    assert.equal(out.visibility, "private");
    assert.equal(out.verification.ok, true);
    assert.deepEqual(out.tracks.map((t) => t.id), [id(0), id(4), id(6)]);
    assert.deepEqual(out.tracks.map((t) => t.position), [0, 1, 2]);
    assert.match(out.link, /open\.spotify\.com\/playlist\//);
  });

  await test("add_tracks_to_playlist appends and inserts, verifying only the inserted range", async () => {
    const before = state.requests.length;
    let out = data(await client.callTool({ name: "add_tracks_to_playlist", arguments: { playlist: playlistId, tracks: [id(5)] } }));
    assert.equal(out.verification.ok, true);
    assert.equal(out.playlist_length, 4);
    assert.deepEqual(out.inserted.map((t) => [t.position, t.id]), [[3, id(5)]]);
    // length (1) + add (1) + read back the one inserted item (1)
    assert.equal(state.requests.slice(before).filter((r) => r.includes("/playlists/")).length, 3);
    out = data(
      await client.callTool({
        name: "add_tracks_to_playlist",
        arguments: { playlist: `https://open.spotify.com/playlist/${playlistId}`, tracks: [id(3)], position: 1 },
      }),
    );
    assert.equal(out.verification.ok, true);
    assert.deepEqual(out.inserted.map((t) => [t.position, t.id]), [[1, id(3)]]);
  });

  await test("get_playlist reads all or part, and list_created_playlists lists it", async () => {
    const got = data(await client.callTool({ name: "get_playlist", arguments: { playlist: playlistId } }));
    assert.deepEqual(got.tracks.map((t) => t.id), [id(0), id(3), id(4), id(6), id(5)]);
    assert.equal(got.name, "Test mix");
    const part = data(await client.callTool({ name: "get_playlist", arguments: { playlist: playlistId, offset: 2, limit: 2 } }));
    assert.deepEqual(part.tracks.map((t) => [t.position, t.id]), [[2, id(4)], [3, id(6)]]);
    const list = data(await client.callTool({ name: "list_created_playlists", arguments: {} }));
    assert.equal(list.playlists.length, 1);
    assert.equal(list.playlists[0].playlist_id, playlistId);
  });

  await test("refuses to read or change playlists it didn't create", async () => {
    const foreign = [...state.playlists.keys()][0];
    for (const [name, args] of [
      ["get_playlist", { playlist: foreign }],
      ["add_tracks_to_playlist", { playlist: foreign, tracks: [id(0)] }],
    ]) {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(r.isError, `${name} should refuse`);
      assert.match(text(r), /only reads or changes playlists it created/);
    }
    assert.deepEqual(state.playlists.get(foreign).items, [id(0)]);
  });

  await test("large playlists are added in chunks of 100 and read back across pages", async () => {
    const tracks = Array.from({ length: 160 }, (_, i) => id(i % CATALOG.length));
    const out = data(await client.callTool({ name: "create_playlist", arguments: { name: "Big", tracks } }));
    assert.equal(out.verification.ok, true);
    assert.equal(out.tracks.length, 160);
  });

  await test("a failure part-way through create_playlist reports the playlist and what landed", async () => {
    const tracks = Array.from({ length: 150 }, (_, i) => (i === 120 ? UNKNOWN_ID : id(i % CATALOG.length)));
    const r = await client.callTool({ name: "create_playlist", arguments: { name: "Half", tracks } });
    assert.ok(r.isError);
    const out = JSON.parse(text(r));
    assert.ok(out.playlist_id);
    assert.match(out.error, /stopped after 100 of 150/);
    assert.equal(out.verification.ok, false);
    assert.equal(out.tracks.length, 100);
    // The half-built playlist is still the connector's, so it can be fixed with add_tracks_to_playlist.
    const fix = data(
      await client.callTool({ name: "add_tracks_to_playlist", arguments: { playlist: out.playlist_id, tracks: [id(0)] } }),
    );
    assert.equal(fix.verification.ok, true);
  });

  await test("refreshes an expired access token once, even with parallel calls", async () => {
    await fetch(`${MOCK}/__expire`);
    const before = state.grants.filter((g) => g === "refresh_token").length;
    const out = data(
      await client.callTool({
        name: "search_tracks",
        arguments: { requests: [{ title: "Strobe" }, { title: "Karma Police" }, { title: "Hey Jude" }] },
      }),
    );
    assert.equal(out.results[0].candidates[0].id, id(6));
    assert.equal(state.grants.filter((g) => g === "refresh_token").length, before + 1);
  });

  await test("waits and retries when Spotify rate-limits", async () => {
    await fetch(`${MOCK}/__ratelimit?n=1`);
    const out = data(await client.callTool({ name: "search_tracks", arguments: { requests: [{ title: "Strobe" }] } }));
    assert.equal(out.results[0].candidates[0].id, id(6));
  });

  await test("reads playlists without the fields filter if Spotify rejects it", async () => {
    await fetch(`${MOCK}/__rejectfields`);
    const out = data(await client.callTool({ name: "get_playlist", arguments: { playlist: playlistId } }));
    assert.deepEqual(out.tracks.map((t) => t.id), [id(0), id(3), id(4), id(6), id(5)]);
  });

  await test("revoked Spotify sign-in produces a clear message", async () => {
    await fetch(`${MOCK}/__expire`);
    state.refreshToken = "rt-rotated-elsewhere";
    const r = await client.callTool({ name: "search_tracks", arguments: { requests: [{ title: "Strobe" }] } });
    assert.ok(r.isError);
    assert.match(text(r), /Sign in again/);
  });

  await client.close();
  console.log(`\nAll ${passed} tests passed.`);
} catch {
  console.error("\n--- wrangler output ---\n" + workerLog.slice(-4000));
} finally {
  try {
    process.kill(-worker.pid, "SIGTERM");
  } catch {}
  mock.closeAllConnections();
  mock.close();
  rmSync(persistDir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
