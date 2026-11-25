# spotify-playlist-mcp

A small MCP server on Cloudflare Workers that lets Claude build **private Spotify playlists from exact tracks**. Claude looks up each track, checks it's the version you asked for, creates the playlist, then reads it back to confirm it matches.

## What Claude can and can't do with it

| Tool | What it does |
| --- | --- |
| `search_tracks` | Look up to 20 tracks at once; returns candidates with title, artists, album, release date, duration and link |
| `get_track` | Confirm tracks from IDs or Spotify links |
| `create_playlist` | Create a **private** playlist with exactly the given tracks, then verify it |
| `add_tracks_to_playlist` | Add tracks to a playlist **this connector created**, then verify |
| `get_playlist` | Read back a playlist **this connector created** |
| `list_created_playlists` | List the playlists this connector created |

Deliberately missing: deleting playlists, removing tracks, touching your library, playback, and reading or changing any playlist the connector didn't create. The Spotify sign-in only requests `playlist-modify-private` and `playlist-read-private`.

## Setup (once)

You need a Spotify Premium account and a Spotify developer app (Development mode is fine).

### 1. Deploy to Cloudflare

1. In the Cloudflare dashboard, go to **Workers & Pages → Create application → Import a repository**.
2. Connect GitHub. When GitHub asks which repositories Cloudflare can access, choose **Only select repositories → spotify-playlist-mcp**.
3. Select this repository and keep the defaults (project name `spotify-playlist-mcp`, deploy command `npx wrangler deploy`). Select **Deploy**.
4. Open the Worker's URL, `https://spotify-playlist-mcp.<your-subdomain>.workers.dev`. The page shows the exact redirect URI and MCP URL you need below, and offers a freshly generated connector key.

Every push to `main` redeploys automatically.

### 2. Add the secrets

In the Worker, go to **Settings → Variables and Secrets → Add**, choose type **Secret**, and add:

| Name | Value |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | From your Spotify app's settings |
| `SPOTIFY_CLIENT_SECRET` | From your Spotify app's settings |
| `CONNECTOR_KEY` | A random string of at least 32 characters. Save it in your password manager; you'll paste it into Claude too |

Secrets are encrypted and can't be viewed again after saving. They never go in this repo.

### 3. Register the redirect URI with Spotify

In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), open your app → **Settings → Edit → Redirect URIs**, add `https://spotify-playlist-mcp.<your-subdomain>.workers.dev/callback` (copy it from the Worker's home page), and save.

### 4. Sign in to Spotify (once)

Open the Worker's home page, enter your connector key, select **Sign in with Spotify**, and approve. The page confirms which Spotify account is connected. The refresh token is stored in the Worker's KV storage; you never handle it.

If Spotify says the user isn't registered, add your Spotify account under your app's **User Management** in the developer dashboard and try again.

### 5. Add the connector to Claude

In Claude, go to **Customize → Connectors → + Add → Add custom connector**:

- **Name:** Spotify Playlists
- **URL:** `https://spotify-playlist-mcp.<your-subdomain>.workers.dev/mcp`
- **Authentication:** No sign in
- **Request headers:** `Authorization` = `Bearer <your connector key>` (the server also accepts the key in an `X-API-Key` header)

Then try: *"Make a playlist called Test with Bohemian Rhapsody by Queen and Strobe by deadmau5."*

## Revoking access

- **Spotify:** remove the app from your Spotify account's app access page. The Worker will then ask you to sign in again.
- **Claude:** change `CONNECTOR_KEY` in Cloudflare; the old key stops working immediately. Update the header in Claude's connector settings.
- **Everything:** delete the Worker in Cloudflare.

## Limits

- Cloudflare's free plan allows 100,000 requests a day, far more than this needs. Free Workers get 10 ms of CPU per request; very large playlists may occasionally hit that (error 1102). The $5/month Workers Paid plan removes it.
- Spotify Development mode: the app owner needs Premium; search returns at most 10 results per query.

## Development

```sh
npm install
npm run typecheck
npm test     # runs the Worker locally against a mock Spotify and calls every tool through the MCP client
```

For local runs against real Spotify, put the three secrets in `.dev.vars` (ignored by git) and run `npm run dev`.
