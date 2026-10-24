# Public server (v0)

A public Matrix homeserver built on [`@katrix/server`](../../packages/server), served at
**https://matrix.mwdapis.stream**:

- **GitHub is the only login** (the OAuth 2.0 API of the spec, with GitHub as the identity
  provider). No passwords; the first login creates the account. Clients sign in through the
  server's pages, and older clients through `m.login.sso`, which goes to the same pages.
- **Postgres 18** in a container on the host (one instance, no cluster adapter); media on a volume.
- **No federation.**
- **Calls:** Element Call and Element X through LiveKit Cloud, which also relays media for
  clients behind strict NATs. Media never goes through the host or the tunnel.
- **Reachable through a Cloudflare tunnel**: the host opens no port.
- **Version 0**: for testing. The landing page says so. Data is meant to survive updates, but
  may have to be reset.

## Local development

No Docker: one process runs the homeserver on SQLite and, in place of GitHub, the
[development identity provider](../dev-idp), where you sign in by picking Alice, Bob or Carol.

```sh
cd apps/public
npm run dev
```

- Homeserver: http://localhost:8008 (data in `apps/public/.dev-data`; delete it to start over)
- Dev login: http://localhost:3001
- `@alice:localhost` is a server admin. Point a client at `http://localhost:8008`, for example
  https://app.element.io (Chrome and Firefox allow it to talk to localhost).
- Other ports: `PORT=8009 DEV_IDP_PORT=3002 npm run dev`.

`npm test` runs the whole login (dev provider → consent → token → `/whoami`) against a real
server on SQLite.

## Production

Secrets live encrypted in [`msecrets.json`](msecrets.json) ([msecrets](https://github.com/k18k/msecrets)),
environment `production`. `npx msecrets ls` shows which ones still need a value.

| Secret | Value |
|---|---|
| `POSTGRES_PASSWORD` | Generated. Handed to the homeserver as `PGPASSWORD`, so any characters work. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From a GitHub OAuth app (below). |
| `CLOUDFLARE_TUNNEL_TOKEN` | Written by `npm run tunnel`. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | From a LiveKit Cloud project (below). |

1. **GitHub OAuth app** (GitHub → Settings → Developer settings → OAuth Apps → New): homepage
   `https://matrix.mwdapis.stream`, callback URL
   `https://matrix.mwdapis.stream/_matrix/client/v3/login/sso/callback/github`. Then:
   ```sh
   npx msecrets set GITHUB_CLIENT_ID -e production
   npx msecrets set GITHUB_CLIENT_SECRET -e production
   ```
2. **Tunnel**: `npm run tunnel`. It logs `cloudflared` in to the `mwdapis.stream` zone (in a
   browser, once), creates the tunnel `matrix-public`, routes `matrix.mwdapis.stream` to it, and
   stores the token in `msecrets.json`. The route to the homeserver is in
   [`cloudflared/config.yml`](cloudflared/config.yml).
3. **Calls.** The tunnel carries only HTTP, so media (WebRTC) goes to hosted services:
   - **Element Call and Element X** use MatrixRTC: media goes through an SFU, and LiveKit is the
     only one clients support. Create a project on [LiveKit Cloud](https://cloud.livekit.io), then
     `npx msecrets set LIVEKIT_URL -e production` (its `wss://….livekit.cloud` URL), and the same
     for `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. In the project's settings, add the webhook
     `https://matrix.mwdapis.stream/livekit/jwt/sfu_webhook`; it lets lk-jwt-service end a call
     membership when someone drops off.
   - **Legacy 1:1 calls** (`m.call.*` in Element Web, FluffyChat, Nheko) connect the two
     clients directly; there is no TURN server for them, so they need a direct path.

   lk-jwt-service runs next to the homeserver, which passes `/livekit/jwt/*` on to it, so the
   tunnel still has one route. It checks Element Call's OpenID tokens at
   `/.well-known/matrix/server`, which the server answers for this even without federation.
4. **The host** decrypts the secrets with its own key. Give it one, read-only, for production:
   ```sh
   npx msecrets recipient add matrix-host --generate --env production   # prints the key once
   ```
   On the host, keep it in `MSECRETS_IDENTITY` (or `~/.config/msecrets/identity.txt`).
5. **Deploy** (on the host, from `apps/public`):
   ```sh
   npm run deploy      # msecrets run -e production -- docker compose -f compose.prod.yaml up -d --build
   ```
   `msecrets run` refuses to start while a secret has no value.

Admins: `ADMINS` (comma-separated user IDs, default `@k18k:matrix.mwdapis.stream`). They become
admins when their account is created and at every start. `TERMS_URL` and `POLICY_URL` add links
to the login pages and the landing page.

## Configuration

| Variable | |
|---|---|
| `SERVER_NAME` | The server name (`matrix.mwdapis.stream`). Required. |
| `PUBLIC_BASE_URL` | Default `https://{SERVER_NAME}`. |
| `DATABASE_URL` | Postgres. Without it, SQLite in `DATA_DIR`. |
| `DB_POOL` | Postgres connections. Default 10. |
| `DATA_DIR` | Media (and SQLite). Default `./data`, `/data` in the image. |
| `LOGIN_PROVIDER` | `github` or `dev` (default: whichever is configured). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub login. |
| `DEV_IDP_ISSUER`, `DEV_IDP_CLIENT_ID`, `DEV_IDP_CLIENT_SECRET` | The development provider. |
| `LIVEKIT_JWT_URL` | lk-jwt-service as the server reaches it; advertises the LiveKit transport. |
| `ADMINS`, `TERMS_URL`, `POLICY_URL`, `PORT` | See above. Port default 8008. |
