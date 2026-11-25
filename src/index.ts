// Entry point.
//
//   GET  /            setup page (shows the URLs to register; Spotify sign-in form)
//   POST /login       checks the connector key, then sends you to Spotify
//   GET  /callback    Spotify returns here; the refresh token is saved to KV
//   GET  /authorize   consent page Claude opens when it connects (asks for the connector key)
//   POST /authorize   approves or denies Claude's request
//   POST /mcp         the MCP endpoint (needs an OAuth token from the flow above,
//                     or the connector key as a Bearer token for clients that can send headers)
//
// OAuth discovery, client registration and the token endpoint are served by
// @cloudflare/workers-oauth-provider, which stores only hashes of tokens in OAUTH_KV.

import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type ClientRegistrationCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./mcp";
import { consentPage, homePage, messagePage } from "./pages";
import { type Env, Spotify } from "./spotify";

const MIN_KEY_LENGTH = 32;
const SIGNIN_COOKIE = "__Host-spotify-signin";
const encoder = new TextEncoder();

// ---------------------------------------------------------------- helpers

function missingSecrets(env: Env): string[] {
  const missing: string[] = [];
  if (!env.SPOTIFY_CLIENT_ID) missing.push("SPOTIFY_CLIENT_ID");
  if (!env.SPOTIFY_CLIENT_SECRET) missing.push("SPOTIFY_CLIENT_SECRET");
  if (!env.CONNECTOR_KEY || env.CONNECTOR_KEY.length < MIN_KEY_LENGTH) {
    missing.push(`CONNECTOR_KEY (at least ${MIN_KEY_LENGTH} characters)`);
  }
  return missing;
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/** Checks a presented key against CONNECTOR_KEY. Fails closed if the secret is missing or short. */
async function keyMatches(env: Env, presented: string | null | undefined): Promise<boolean> {
  const expected = env.CONNECTOR_KEY;
  if (!expected || expected.length < MIN_KEY_LENGTH || !presented) return false;
  return safeEqual(presented, expected);
}

function hex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", k, encoder.encode(data)));
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Only Claude's own callback, or an app on this computer (Claude Code, desktop clients), may
 * receive tokens. This stops a look-alike app from tricking you into approving it.
 */
function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:" && (u.hostname === "claude.ai" || u.hostname === "claude.com")) {
      return u.pathname === "/api/mcp/auth_callback";
    }
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- MCP endpoint

async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Stateless JSON mode: every POST is self-contained, so no server-to-client stream is offered.
  if (request.method !== "POST") return jsonError(405, "Method not allowed", { Allow: "POST" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  // JSON-RPC batches were dropped from MCP in 2025-06-18; refusing them also caps work per request.
  if (Array.isArray(body)) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } },
      { status: 400 },
    );
  }

  const server = buildServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request, { parsedBody: body });
}

// ---------------------------------------------------------------- Spotify sign-in (owner only)

async function handleLogin(request: Request, env: Env, url: URL): Promise<Response> {
  if (missingSecrets(env).length) return homePage(url.origin, missingSecrets(env));
  const form = await request.formData().catch(() => null);
  const key = form?.get("key");
  if (typeof key !== "string" || !(await keyMatches(env, key))) {
    return messagePage("Wrong key", "That connector key doesn't match. Go back and try again.", 403);
  }
  // The state travels in a signed, short-lived cookie bound to this browser.
  const state = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = Date.now() + 10 * 60 * 1000;
  const sig = await hmac(env.CONNECTOR_KEY!, `${state}.${expires}`);
  const target = new Spotify(env).authorizeUrl(`${url.origin}/callback`, state);
  return new Response(null, {
    status: 303,
    headers: {
      Location: target,
      "Cache-Control": "no-store",
      "Set-Cookie": `${SIGNIN_COOKIE}=${state}.${expires}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

async function handleCallback(request: Request, env: Env, url: URL): Promise<Response> {
  const clear = new Headers({ "Set-Cookie": `${SIGNIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  const expired = () =>
    messagePage("Sign-in expired", "This sign-in link is invalid or expired. Start again from the home page.", 400, clear);

  if (missingSecrets(env).length) return expired();
  const [state, expires, sig] = (readCookie(request, SIGNIN_COOKIE) ?? "").split(".");
  if (!state || !expires || !sig || Number(expires) < Date.now() || url.searchParams.get("state") !== state) {
    return expired();
  }
  if (!(await safeEqual(sig, await hmac(env.CONNECTOR_KEY!, `${state}.${expires}`)))) return expired();

  const error = url.searchParams.get("error");
  if (error) return messagePage("Not connected", `Spotify sign-in was cancelled or failed: ${error}`, 400, clear);
  const code = url.searchParams.get("code");
  if (!code) return messagePage("Not connected", "Spotify didn't return a sign-in code.", 400, clear);

  try {
    const me = await new Spotify(env).completeSignIn(code, `${url.origin}/callback`);
    const who = me.display_name ? `${me.display_name} (${me.id})` : me.id;
    return messagePage("Connected", `Signed in to Spotify as ${who}. You can close this page.`, 200, clear);
  } catch (err) {
    return messagePage("Not connected", err instanceof Error ? err.message : String(err), 502, clear);
  }
}

// ---------------------------------------------------------------- Claude's connection consent

function authorizationFailure(err: unknown): Response {
  // Even error redirects only go to the allowed destinations.
  if (err instanceof AuthorizationError && err.redirectTo && redirectAllowed(err.redirectTo)) {
    return Response.redirect(err.redirectTo, 302);
  }
  if (err instanceof AuthorizationError) return messagePage("Can't connect", err.description, 400);
  if (err instanceof CimdFetchError) return messagePage("Can't connect", "The connecting app couldn't be verified.", 400);
  throw err;
}

async function handleAuthorize(request: Request, env: Env, url: URL): Promise<Response> {
  if (missingSecrets(env).length) return homePage(url.origin, missingSecrets(env));
  const oauth = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    try {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!redirectAllowed(authRequest.redirectUri)) {
        return messagePage(
          "Can't connect",
          `This connector only sends access to Claude or to an app on this computer, not to ${new URL(authRequest.redirectUri).host}.`,
          400,
        );
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return consentPage(details, consent.handle, consent.headers);
    } catch (err) {
      return authorizationFailure(err);
    }
  }

  if (request.method !== "POST") return jsonError(405, "Method not allowed", { Allow: "GET, POST" });
  const form = await request.formData().catch(() => null);
  const handle = String(form?.get("handle") ?? "");
  try {
    if (form?.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // Check the key before touching the handle, so a typo can be retried with the Back button.
    if (!(await keyMatches(env, String(form.get("key") ?? "")))) {
      return messagePage("Wrong key", "That connector key doesn't match. Go back and try again.", 403);
    }
    const approved = await oauth.approveConsent(request, handle);
    if (!redirectAllowed(approved.request.redirectUri)) {
      return messagePage("Can't connect", "This connector only sends access to Claude or to an app on this computer.", 400);
    }
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: { approved_at: new Date().toISOString() },
      scope: approved.request.scope,
      props: { owner: true },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    return authorizationFailure(err);
  }
}

// ---------------------------------------------------------------- routing

async function handleDefault(request: Request, env: Env): Promise<Response> {
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
        return await handleCallback(request, env, url);
      case "/authorize":
        return await handleAuthorize(request, env, url);
      default:
        return jsonError(404, "Not found");
    }
  } catch (err) {
    console.error(err);
    return jsonError(500, "Internal error");
  }
}

function rejectForeignRedirects({ clientMetadata }: ClientRegistrationCallbackOptions) {
  const uris = clientMetadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string" && redirectAllowed(u))) {
    return {
      code: "invalid_redirect_uri",
      description: "Only Claude's callback or a loopback address can be registered.",
    };
  }
}

// The provider needs this Worker's public URL; it's taken from the first request so the
// code works on any workers.dev subdomain or custom domain without configuration.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: { fetch: (request: Request, env: Env) => handleMcp(request, env) },
      defaultHandler: { fetch: (request: Request, env: Env) => handleDefault(request, env) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientRegistrationCallback: rejectForeignRedirects,
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["playlists", "offline_access"],
      requiredScopes: ["playlists"],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Spotify Playlists" },
      // Claude stays connected while it keeps using the connector; 30 idle days ends the grant.
      refreshTokenTTL: 30 * 24 * 3600,
      refreshTokenIdleTTL: 30 * 24 * 3600,
      // Clients that can send a fixed header may use the connector key itself as a Bearer token.
      resolveExternalToken: async ({ token, env }) =>
        (await keyMatches(env, token)) ? { props: { owner: true }, audience: `${origin}/mcp` } : null,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
