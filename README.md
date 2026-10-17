# matrix-nodejs-homeserver

A [Matrix](https://matrix.org) homeserver as an importable Node.js library, and a public server built on it.

| Directory | What | Published |
|---|---|---|
| [`packages/core`](packages/core) | The library: Client-Server and Server-Server API, E2EE, sliding sync, the OAuth 2.0 API, adapters for SQLite, Postgres and MySQL. [Documentation](packages/core/README.md). | npm: [`matrix-nodejs-homeserver`](https://www.npmjs.com/package/matrix-nodejs-homeserver) |
| [`apps/public`](apps/public) | The public test server (v0) at [matrix.mwdapis.stream](https://matrix.mwdapis.stream): GitHub is the only login, Postgres on PlanetScale, no federation, a Cloudflare tunnel. | no |
| [`apps/dev-idp`](apps/dev-idp) | A development OpenID Connect provider (Better Auth) where you sign in by picking a user. The public server uses it locally in place of GitHub. | no |

```sh
npm install          # every workspace; builds packages/core/dist
npm test             # tests of every workspace
npm run smoke        # a few seconds: does the homeserver work (and the public app's login)?
npm run typecheck
npm run lint && npm run format:check
```

Changes to the library come with a changeset (`npx changeset`, see [packages/core](packages/core/README.md#releasing)). The apps are private and are not versioned.

[PolyForm Noncommercial 1.0.0](LICENSE).
