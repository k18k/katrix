# Development identity provider

[Better Auth](https://www.better-auth.com) as an OpenID Connect provider, where you sign in by
clicking one of a few made-up users (Alice, Bob, Carol). The [public server](../public) uses it
locally in place of GitHub, so the whole OAuth login can be tried without a GitHub app.

**Development only.** Anyone who reaches it can sign in as any of its users. Everything is kept
in memory and created again at each start. The local compose file binds it to 127.0.0.1.

```sh
npm start -w @matrix-nodejs-homeserver/dev-idp
```

| Variable | Default |
|---|---|
| `DEV_IDP_BASE_URL` | `http://dev-idp.localhost:3001`: the URL browsers and the homeserver both use. |
| `DEV_IDP_REDIRECT_URIS` | `http://localhost:8008/_matrix/client/v3/login/sso/callback/dev` |
| `PORT`, `HOST` | `3001`, `0.0.0.0` |

The client it registers is `matrix-dev` / `matrix-dev-secret`. Tests import `startDevIdp()`
from this package and run it on a random port.
