// Entry point: routes requests to the sign-in pages or the MCP endpoint.
//
//   GET  /          setup page (shows the URLs to register; sign-in form)
//   POST /login     checks the connector key, then sends you to Spotify
//   GET  /callback  Spotify returns here; the refresh token is saved to KV
//   POST /mcp       the MCP endpoint Claude talks to (needs the connector key)

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./mcp";
import { homePage, messagePage } from "./pages";
import { type Env, KV_KEYS, Spotify } from "./spotify";

const MIN_KEY_LENGTH = 32;

function missingSecrets(env: Env): string[] {
  const missing: string[] = [];
  if (!env.SPOTIFY_CLIENT_ID) missing.push("SPOTIFY_CLIENT_ID");
  if (!env.SPOTIFY_CLIENT_SECRET) missing.push("SPOTIFY_CLIENT_SECRET");
  if (!env.CONNECTOR_KEY || env.CONNECTOR_KEY.length < MIN_KEY_LENGTH) {
    missing.push(`CONNECTOR_KEY (at least ${MIN_KEY_LENGTH} characters)`);
  }
  return missing;
}

/** Constant-time comparison of a presented key against CONNECTOR_KEY. Fails closed. */
async function keyMatches(env: Env, presented: string | null | undefined): Promise<boolean> {
  const expected = env.CONNECTOR_KEY;
  if (!expected || expected.length < MIN_KEY_LENGTH || !presented) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function presentedKey(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("X-API-Key");
}

function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleMcp(request: Request, env: Env, url: URL): Promise<Response> {
  // Browsers send Origin; Claude's servers do not. Reject cross-site browser calls.
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return jsonError(403, "Forbidden origin");

  if (missingSecrets(env).length) return jsonError(503, "Server is not configured yet");
  if (!(await keyMatches(env, presentedKey(request)))) return jsonError(401, "Missing or wrong connector key");

  // Stateless JSON mode: every POST is self-contained, so no server-to-client stream is offered.
  if (request.method !== "POST") return jsonError(405, "Method not allowed", { Allow: "POST" });

  const server = buildServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
  if (missingSecrets(env).length) return homePage(url.origin, missingSecrets(env));
  const form = await request.formData().catch(() => null);
  const key = form?.get("key");
  if (typeof key !== "string" || !(await keyMatches(env, key))) {
    return messagePage("Wrong key", "That connector key doesn't match. Go back and try again.", 403);
  }
  const state = randomState();
  await env.KV.put(KV_KEYS.statePrefix + state, "1", { expirationTtl: 600 });
  const target = new Spotify(env).authorizeUrl(`${url.origin}/callback`, state);
  return new Response(null, { status: 303, headers: { Location: target, "Cache-Control": "no-store" } });
}

async function handleCallback(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get("state");
  // The state must be one we issued after a correct connector key, in the last 10 minutes.
  if (!state || !/^[0-9a-f]{64}$/.test(state) || !(await env.KV.get(KV_KEYS.statePrefix + state))) {
    return messagePage("Sign-in expired", "This sign-in link is invalid or expired. Start again from the home page.", 400);
  }
  await env.KV.delete(KV_KEYS.statePrefix + state);

  const error = url.searchParams.get("error");
  if (error) return messagePage("Not connected", `Spotify sign-in was cancelled or failed: ${error}`, 400);
  const code = url.searchParams.get("code");
  if (!code) return messagePage("Not connected", "Spotify didn't return a sign-in code.", 400);

  try {
    const me = await new Spotify(env).completeSignIn(code, `${url.origin}/callback`);
    const who = me.display_name ? `${me.display_name} (${me.id})` : me.id;
    return messagePage("Connected", `Signed in to Spotify as ${who}. You can close this page.`);
  } catch (err) {
    return messagePage("Not connected", err instanceof Error ? err.message : String(err), 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/":
          if (request.method !== "GET") return jsonError(405, "Method not allowed", { Allow: "GET" });
          return homePage(url.origin, missingSecrets(env));
        case "/login":
          if (request.method !== "POST") return Response.redirect(`${url.origin}/`, 303);
          return await handleLogin(request, env, url);
        case "/callback":
          return await handleCallback(env, url);
        case "/mcp":
          return await handleMcp(request, env, url);
        default:
          return jsonError(404, "Not found");
      }
    } catch (err) {
      console.error(err);
      return jsonError(500, "Internal error");
    }
  },
} satisfies ExportedHandler<Env>;
