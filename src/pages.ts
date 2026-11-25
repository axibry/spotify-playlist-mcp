// Minimal HTML pages: setup, Spotify sign-in, and the consent page Claude opens when it connects.
// No scripts, no external assets. Everything interpolated is escaped.

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function page(
  title: string,
  body: string,
  opts: { status?: number; headers?: Headers; formTargets?: string[] } = {},
): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
  code { background: #f2f2f2; padding: .1rem .3rem; border-radius: 4px; word-break: break-all; }
  input, button { font: inherit; padding: .6rem; width: 100%; box-sizing: border-box; margin-top: .5rem; }
  button { background: #1db954; color: #fff; border: 0; border-radius: 6px; }
  button.secondary { background: #e5e5e5; color: #111; }
  .muted { color: #555; font-size: .9rem; }
  .warn { background: #fff4d6; padding: .6rem; border-radius: 6px; }
</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  const headers = new Headers(opts.headers);
  const formAction = ["'self'", ...(opts.formTargets ?? [])].join(" ");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  );
  return new Response(html, { status: opts.status ?? 200, headers });
}

function suggestedKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(36));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

export function homePage(origin: string, missingSecrets: string[]): Response {
  const keyHelp = missingSecrets.some((s) => s.startsWith("CONNECTOR_KEY"))
    ? `<p class="muted">Need a connector key? Here's a random one, generated just now and not stored anywhere (reload for another). Save it in your password manager before using it:<br><code>${suggestedKey()}</code></p>`
    : "";
  const setup = missingSecrets.length
    ? `<p><strong>Not ready:</strong> add these secrets in the Cloudflare dashboard (Worker → Settings → Variables and Secrets): ${missingSecrets
        .map((s) => `<code>${escapeHtml(s)}</code>`)
        .join(", ")}.</p>${keyHelp}`
    : `<h2>Connect Spotify</h2>
<form method="post" action="/login">
  <label>Connector key<input type="password" name="key" autocomplete="current-password" required></label>
  <button type="submit">Sign in with Spotify</button>
</form>
<p class="muted">You only need to do this once, or again if you revoke access in Spotify.</p>`;
  return page(
    "Spotify Playlist MCP",
    `<p>Redirect URI to register in your Spotify app:<br><code>${escapeHtml(origin)}/callback</code></p>
<p>Connector URL to add in Claude:<br><code>${escapeHtml(origin)}/mcp</code></p>
${setup}`,
    { formTargets: ["https://accounts.spotify.com"] },
  );
}

export function messagePage(title: string, message: string, status = 200, headers?: Headers): Response {
  return page(title, `<p>${escapeHtml(message)}</p>`, { status, headers });
}

export function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
  const name = escapeHtml(details.clientName);
  const who = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  const target = new URL(details.redirectUri).origin;
  return page(
    `Allow ${details.clientName} to make Spotify playlists?`,
    `<p>${who} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p>${name} will be able to search Spotify, create private playlists, and add tracks to playlists it created. It can't delete anything or see your other playlists.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <label>Connector key<input type="password" name="key" autocomplete="current-password"></label>
  <button type="submit" name="decision" value="approve">Allow</button>
  <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</form>`,
    { headers, formTargets: [target] },
  );
}
