# Public server (v0)

A public Matrix homeserver built on [`matrix-nodejs-homeserver`](../../packages/core), served at
**https://matrix.mwdapis.stream**:

- **GitHub is the only login** (the OAuth 2.0 API of the spec, with GitHub as the identity
  provider). No passwords; the first login creates the account. Clients sign in through the
  server's pages, and older clients through `m.login.sso`, which goes to the same pages.
- **Postgres**; media on a volume.
- **No federation.**
- **Reachable through a Cloudflare tunnel**: the host opens no port.
- **Version 0**: for testing. The landing page says so. Data is meant to survive updates, but
  may have to be reset.

## Local development

```sh
cd apps/public
docker compose up --build
```

This starts Postgres, the homeserver at http://localhost:8008 and, in place of GitHub, the
[development identity provider](../dev-idp) at http://dev-idp.localhost:3001. There you sign in
by picking Alice, Bob or Carol. `@alice:localhost` is a server admin. Point a client at
`http://localhost:8008`, for example https://app.element.io (Chrome and Firefox allow it to
talk to localhost).

Without Docker, the app also runs on SQLite:

```sh
npm start -w @matrix-nodejs-homeserver/dev-idp &
SERVER_NAME=localhost PUBLIC_BASE_URL=http://localhost:8008 LOGIN_PROVIDER=dev \
  DEV_IDP_ISSUER=http://dev-idp.localhost:3001/api/auth DEV_IDP_CLIENT_ID=matrix-dev \
  DEV_IDP_CLIENT_SECRET=matrix-dev-secret npm start -w @matrix-nodejs-homeserver/public
```

`npm test` runs the whole login (dev provider → consent → token → `/whoami`) against a real
server on SQLite.

## Production

Secrets live encrypted in [`msecrets.json`](msecrets.json) ([msecrets](https://github.com/k18k/msecrets)),
environment `production`. `npx msecrets ls` shows which ones still need a value.

| Secret | Value |
|---|---|
| `POSTGRES_PASSWORD` | Generated already. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From a GitHub OAuth app (below). |
| `CLOUDFLARE_TUNNEL_TOKEN` | Written by `npm run tunnel`. |

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
3. **The host** decrypts the secrets with its own key. Give it one, read-only, for production:
   ```sh
   npx msecrets recipient add matrix-host --generate --env production   # prints the key once
   ```
   On the host, keep it in `MSECRETS_IDENTITY` (or `~/.config/msecrets/identity.txt`).
4. **Deploy** (on the host, from `apps/public`):
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
| `DATA_DIR` | Media (and SQLite). Default `./data`, `/data` in the image. |
| `LOGIN_PROVIDER` | `github` or `dev` (default: whichever is configured). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub login. |
| `DEV_IDP_ISSUER`, `DEV_IDP_CLIENT_ID`, `DEV_IDP_CLIENT_SECRET` | The development provider. |
| `ADMINS`, `TERMS_URL`, `POLICY_URL`, `PORT` | See above. Port default 8008. |
