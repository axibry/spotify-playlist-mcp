// Minimal HTML pages for the one-time Spotify sign-in. No scripts, no external assets.

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function page(title: string, body: string, status = 200): Response {
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
  .muted { color: #555; font-size: .9rem; }
</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.spotify.com; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

function suggestedKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(36));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

export function homePage(origin: string, missingSecrets: string[]): Response {
  const keyHelp = missingSecrets.some((s) => s.startsWith("CONNECTOR_KEY"))
    ? `<p class="muted">Need a connector key? Here's a random one, generated just now and not stored anywhere (reload for another):<br><code>${suggestedKey()}</code></p>`
    : "";
  const setup = missingSecrets.length
    ? `<p><strong>Not ready:</strong> add these secrets in the Cloudflare dashboard (Worker → Settings → Variables and Secrets): ${missingSecrets
        .map((s) => `<code>${escapeHtml(s)}</code>`)
        .join(", ")}.</p>${keyHelp}`
    : `<form method="post" action="/login">
  <label>Connector key<input type="password" name="key" autocomplete="current-password" required></label>
  <button type="submit">Sign in with Spotify</button>
</form>
<p class="muted">You only need to do this once, or again if you revoke access in Spotify.</p>`;
  return page(
    "Spotify Playlist MCP",
    `<p>Redirect URI to register in your Spotify app:<br><code>${escapeHtml(origin)}/callback</code></p>
<p>MCP server URL for Claude:<br><code>${escapeHtml(origin)}/mcp</code></p>
${setup}`,
  );
}

export function messagePage(title: string, message: string, status = 200): Response {
  return page(title, `<p>${escapeHtml(message)}</p>`, status);
}
