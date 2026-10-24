# Development identity provider

[Better Auth](https://www.better-auth.com) as an OpenID Connect provider, where you sign in by
clicking one of a few made-up users (Alice, Bob, Carol). The [public server](../public) uses it
locally in place of GitHub, so the whole OAuth login can be tried without a GitHub app.

**Development only.** Anyone who reaches it can sign in as any of its users. Everything is kept
in memory and created again at each start. It listens on 127.0.0.1.

It is a library: `npm run dev` in [apps/public](../public) starts it in the same process as the
homeserver, and tests start it on a random port.

```ts
import { startDevIdp } from "@katrix/dev-idp";

const idp = await startDevIdp({ port: 3001, baseUrl: "http://localhost:3001",
  redirectUris: ["http://localhost:8008/_matrix/client/v3/login/sso/callback/dev"] });
// idp.issuer, idp.clientId ("matrix-dev"), idp.clientSecret ("matrix-dev-secret"), idp.close()
```

The client is registered as a native client when its redirect URIs use http: Better Auth allows
http redirect URIs (on localhost) only for those.
