# spotify-playlist-mcp

A small MCP server on Cloudflare Workers that lets Claude build **private Spotify playlists from exact tracks**. Claude looks up each track, checks it's the version you asked for, creates the playlist, then reads it back to confirm it matches.

## What Claude can and can't do with it

| Tool | What it does |
| --- | --- |
| `search_tracks` | Look up to 10 tracks per call; returns candidates with title, artists, album, release date, duration and link |
| `get_track` | Confirm up to 10 tracks from IDs or Spotify links |
| `create_playlist` | Create a **private** playlist with exactly the given tracks (up to 500), then verify it |
| `add_tracks_to_playlist` | Add tracks to a playlist **this connector created**, then verify the inserted range |
| `get_playlist` | Read back a playlist **this connector created** |
| `list_created_playlists` | List the playlists this connector created |

Deliberately missing: deleting playlists, removing tracks, touching your library, playback, and reading or changing any playlist the connector didn't create. The Spotify sign-in only requests `playlist-modify-private` and `playlist-read-private`.

## How access works

- **Your connector key** is a password you create. It's needed for the two one-time steps below: signing the Worker in to Spotify, and approving Claude's connection.
- **Claude** connects with OAuth: when you add the connector, Claude opens a consent page on your Worker, you enter the connector key, and Claude receives its own token. The key isn't stored in Claude. Tokens can only be sent to Claude's own callback (`claude.ai` / `claude.com`) or an app on your computer, so a look-alike app can't get one.
- **Spotify** tokens stay inside your Cloudflare account (Workers KV). Neither Claude nor this repo ever sees them.

## Setup (once)

You need a Spotify Premium account and a Spotify developer app (Development mode is fine).

### 1. Deploy to Cloudflare

1. In the Cloudflare dashboard, go to **Workers & Pages → Create application → Import a repository**.
2. Connect GitHub. When GitHub asks which repositories Cloudflare can access, choose **Only select repositories → spotify-playlist-mcp**.
3. Select this repository and keep the defaults (project name `spotify-playlist-mcp`, deploy command `npx wrangler deploy`). Select **Deploy**.
4. Open the Worker's URL, `https://spotify-playlist-mcp.<your-subdomain>.workers.dev`. The page shows the exact redirect URI and connector URL you need below. Until the key is set, it also offers a freshly generated connector key.

Every push to `main` redeploys automatically.

### 2. Add the secrets

In the Worker, go to **Settings → Variables and Secrets → Add**, choose type **Secret**, and add:

| Name | Value |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | From your Spotify app's settings |
| `SPOTIFY_CLIENT_SECRET` | From your Spotify app's settings |
| `CONNECTOR_KEY` | A random string of at least 32 characters. Save it in your password manager first |

Secrets are encrypted and can't be viewed again after saving. They never go in this repo.

### 3. Register the redirect URI with Spotify

In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), open your app → **Settings → Edit → Redirect URIs**, add `https://spotify-playlist-mcp.<your-subdomain>.workers.dev/callback` (copy it from the Worker's home page), and save.

### 4. Sign in to Spotify (once)

Open the Worker's home page, enter your connector key, select **Sign in with Spotify**, and approve. The page confirms which Spotify account is connected.

If Spotify says the user isn't registered, add your Spotify account under your app's **User Management** in the developer dashboard and try again.

### 5. Add the connector to Claude

In Claude, go to **Customize → Connectors → + Add → Add custom connector**:

- **Name:** Spotify Playlists
- **URL:** `https://spotify-playlist-mcp.<your-subdomain>.workers.dev/mcp`
- **Authentication:** keep what Claude detects (sign in). For the OAuth client, either **Use Claude's published identity** or **Register automatically** works.

Claude then opens your Worker's consent page. Check it says access goes to **claude.ai**, enter your connector key, and select **Allow**.

Then try: *"Make a playlist called Test with Bohemian Rhapsody by Queen and Strobe by deadmau5."*

Authentication settings can't be edited after a connector is added. To change them, remove the connector and add it again.

**Clients that can send a fixed header** (for example Claude Code with `--header`) can skip OAuth and send `Authorization: Bearer <connector key>` instead.

## Revoking access

- **Claude:** remove the connector in Claude. To cut off every issued token at once, change `CONNECTOR_KEY` and delete the contents of the `OAUTH_KV` namespace in Cloudflare.
- **Spotify:** remove the app from your Spotify account's app access settings. The Worker will then ask you to sign in again.
- **Everything:** delete the Worker in Cloudflare.

## Things to know

- **Right after signing in**, Cloudflare's KV storage can take up to a minute to reach every location, so a tool may briefly say Spotify isn't connected. Wait a minute and retry.
- **Cloudflare free plan:** 100,000 requests a day and 50 outbound requests per call. Batch sizes are capped (10 lookups per search, 500 tracks per playlist call) to stay under the latter. Free Workers also get 10 ms of CPU per request; if you ever see error 1102, the $5/month Workers Paid plan removes these limits.
- **Spotify Development mode:** the app owner needs Premium; search returns at most 10 results per query.
- **Recreating the Worker:** the two KV namespaces Wrangler created (their names start with `spotify-playlist-mcp`) outlive a deleted Worker. Delete them too before deploying a new Worker with the same name.

## Development

```sh
npm install
npm run typecheck
npm test     # runs the Worker locally against a mock Spotify and exercises sign-in, OAuth and every tool
```

`npm test` doesn't touch `.dev.vars` or `.wrangler/state`.

For local runs against real Spotify, put the three secrets in `.dev.vars` (ignored by git), run `npm run dev`, and open `http://127.0.0.1:8787` rather than `localhost`: Spotify only accepts loopback redirect URIs written as `127.0.0.1`, so register `http://127.0.0.1:8787/callback` in your Spotify app.
