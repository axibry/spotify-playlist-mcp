// End-to-end test: runs the Worker under `wrangler dev` against the mock Spotify,
// drives the sign-in flow over HTTP, and calls every tool through the official MCP client.
//
//   npm test

import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CATALOG, CLIENT_ID, CLIENT_SECRET, startMock } from "./mock-spotify.mjs";

const MOCK_PORT = 8790;
const WORKER_PORT = 8787;
const BASE = `http://127.0.0.1:${WORKER_PORT}`;
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

function text(result) {
  return result.content.map((c) => c.text).join("\n");
}
function data(result) {
  assert.ok(!result.isError, `tool returned an error: ${text(result)}`);
  return JSON.parse(text(result));
}

async function waitForWorker() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
}

async function connect(key = KEY) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  return client;
}

const { server: mock, state } = await startMock(MOCK_PORT);
rmSync(".wrangler/state", { recursive: true, force: true });
writeFileSync(
  ".dev.vars",
  [
    `SPOTIFY_CLIENT_ID=${CLIENT_ID}`,
    `SPOTIFY_CLIENT_SECRET=${CLIENT_SECRET}`,
    `CONNECTOR_KEY=${KEY}`,
    `SPOTIFY_ACCOUNTS_BASE=http://127.0.0.1:${MOCK_PORT}`,
    `SPOTIFY_API_BASE=http://127.0.0.1:${MOCK_PORT}/v1`,
  ].join("\n"),
);
const worker = spawn("npx", ["wrangler", "dev", "--port", String(WORKER_PORT), "--ip", "127.0.0.1"], {
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // own process group, so wrangler and workerd can be stopped together
});
let workerLog = "";
worker.stdout.on("data", (d) => (workerLog += d));
worker.stderr.on("data", (d) => (workerLog += d));

try {
  await waitForWorker();
  console.log("Worker running; testing:");

  await test("home page shows the redirect URI and MCP URL", async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert.match(html, new RegExp(`${BASE}/callback`));
    assert.match(html, new RegExp(`${BASE}/mcp`));
    assert.match(html, /Sign in with Spotify/);
  });

  await test("MCP endpoint rejects missing and wrong keys", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "ping" };
    const opts = (headers) => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(init),
    });
    assert.equal((await fetch(`${BASE}/mcp`, opts({}))).status, 401);
    assert.equal((await fetch(`${BASE}/mcp`, opts({ Authorization: "Bearer wrong" }))).status, 401);
    assert.equal((await fetch(`${BASE}/mcp`, opts({ Authorization: `Bearer ${KEY}x` }))).status, 401);
    assert.equal((await fetch(`${BASE}/mcp`, opts({ "X-API-Key": KEY.slice(0, -1) }))).status, 401);
  });

  await test("MCP endpoint rejects cross-site browser origins and GET", async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 403);
    const g = await fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${KEY}`, Accept: "text/event-stream" } });
    assert.equal(g.status, 405);
  });

  await test("tools report 'not connected' before Spotify sign-in", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "search_tracks", arguments: { requests: [{ title: "Strobe" }] } });
    assert.ok(r.isError);
    assert.match(text(r), /isn't connected/);
    await client.close();
  });

  await test("sign-in rejects a wrong connector key", async () => {
    const r = await fetch(`${BASE}/login`, {
      method: "POST",
      body: new URLSearchParams({ key: "nope" }),
      redirect: "manual",
    });
    assert.equal(r.status, 403);
  });

  let callbackUrl;
  await test("sign-in with the right key completes the Spotify flow", async () => {
    const r = await fetch(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ key: KEY }), redirect: "manual" });
    assert.equal(r.status, 303);
    const authorize = new URL(r.headers.get("Location"));
    assert.equal(authorize.origin, `http://127.0.0.1:${MOCK_PORT}`);
    assert.equal(authorize.searchParams.get("redirect_uri"), `${BASE}/callback`);
    assert.equal(authorize.searchParams.get("scope"), "playlist-modify-private playlist-read-private");
    const back = await fetch(authorize, { redirect: "manual" });
    callbackUrl = back.headers.get("Location");
    const done = await fetch(callbackUrl);
    const html = await done.text();
    assert.equal(done.status, 200, html);
    assert.match(html, /Signed in to Spotify as Test User \(testuser\)/);
  });

  await test("sign-in callback can't be replayed or forged", async () => {
    assert.equal((await fetch(callbackUrl)).status, 400);
    assert.equal((await fetch(`${BASE}/callback?code=x&state=${"a".repeat(64)}`)).status, 400);
    assert.equal((await fetch(`${BASE}/callback?code=x`)).status, 400);
  });

  const client = await connect();

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
    const search = tools.find((t) => t.name === "search_tracks");
    assert.equal(search.annotations.readOnlyHint, true);
  });

  await test("search_tracks returns candidates per request, with fallback and no-match", async () => {
    const out = data(
      await client.callTool({
        name: "search_tracks",
        arguments: {
          requests: [
            { title: "Bohemian Rhapsody", artist: "Queen" },
            { title: "Paranoid Android", artist: "Radiohead" },
            { title: "Does Not Exist", artist: "Nobody" },
            { query: "karma police" },
          ],
        },
      }),
    );
    assert.equal(out.results.length, 4);
    assert.deepEqual(out.results[0].candidates.map((c) => c.id), [id(0), id(1)]);
    assert.equal(out.results[0].candidates[0].album, "A Night at the Opera");
    assert.equal(out.results[0].candidates[0].duration, "5:54");
    assert.equal(out.results[0].query_used, 'track:"Bohemian Rhapsody" artist:"Queen"');
    assert.equal(out.results[1].candidates[0].id, id(4));
    assert.equal(out.results[2].candidates.length, 0);
    assert.equal(out.results[3].candidates[0].id, id(5));
  });

  await test("search falls back to plain text when field filters find nothing", async () => {
    // "Hey Jude Remastered" isn't a substring of any title, but every word appears.
    const out = data(
      await client.callTool({
        name: "search_tracks",
        arguments: { requests: [{ title: "Hey Jude Remastered", artist: "Beatles" }] },
      }),
    );
    assert.equal(out.results[0].query_used, "Hey Jude Remastered Beatles");
    assert.equal(out.results[0].candidates[0].id, id(2));
  });

  await test("get_track accepts IDs, URIs and links", async () => {
    const out = data(
      await client.callTool({
        name: "get_track",
        arguments: {
          tracks: [id(6), `spotify:track:${id(3)}`, `https://open.spotify.com/intl-de/track/${id(4)}?si=abc`],
        },
      }),
    );
    assert.deepEqual(out.tracks.map((t) => t.name), ["Strobe", "Hey Jude", "Paranoid Android"]);
  });

  await test("get_track rejects junk", async () => {
    const r = await client.callTool({ name: "get_track", arguments: { tracks: ["not a track"] } });
    assert.ok(r.isError);
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
    assert.match(out.link, /open\.spotify\.com\/playlist\//);
  });

  await test("add_tracks_to_playlist appends and inserts, with verification", async () => {
    let out = data(
      await client.callTool({ name: "add_tracks_to_playlist", arguments: { playlist: playlistId, tracks: [id(5)] } }),
    );
    assert.equal(out.verification.ok, true);
    assert.deepEqual(out.tracks.map((t) => t.id), [id(0), id(4), id(6), id(5)]);
    out = data(
      await client.callTool({
        name: "add_tracks_to_playlist",
        arguments: { playlist: `https://open.spotify.com/playlist/${playlistId}`, tracks: [id(3)], position: 1 },
      }),
    );
    assert.equal(out.verification.ok, true);
    assert.deepEqual(out.tracks.map((t) => t.id), [id(0), id(3), id(4), id(6), id(5)]);
  });

  await test("get_playlist and list_created_playlists see only this connector's playlists", async () => {
    const got = data(await client.callTool({ name: "get_playlist", arguments: { playlist: playlistId } }));
    assert.equal(got.tracks.length, 5);
    assert.equal(got.name, "Test mix");
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

  await test("refreshes an expired access token transparently", async () => {
    await fetch(`http://127.0.0.1:${MOCK_PORT}/__expire`);
    const before = state.grants.filter((g) => g === "refresh_token").length;
    const out = data(await client.callTool({ name: "get_playlist", arguments: { playlist: playlistId } }));
    assert.equal(out.tracks.length, 5);
    assert.equal(state.grants.filter((g) => g === "refresh_token").length, before + 1);
  });

  await test("waits and retries when Spotify rate-limits", async () => {
    await fetch(`http://127.0.0.1:${MOCK_PORT}/__ratelimit?n=1`);
    const out = data(
      await client.callTool({ name: "search_tracks", arguments: { requests: [{ title: "Strobe" }] } }),
    );
    assert.equal(out.results[0].candidates[0].id, id(6));
  });

  await test("reads playlists without the fields filter if Spotify rejects it", async () => {
    await fetch(`http://127.0.0.1:${MOCK_PORT}/__rejectfields`);
    const out = data(await client.callTool({ name: "get_playlist", arguments: { playlist: playlistId } }));
    assert.deepEqual(out.tracks.map((t) => t.id), [id(0), id(3), id(4), id(6), id(5)]);
  });

  await test("revoked sign-in produces a clear message", async () => {
    await fetch(`http://127.0.0.1:${MOCK_PORT}/__expire`);
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
  rmSync(".dev.vars", { force: true });
  process.exit(process.exitCode ?? 0);
}
