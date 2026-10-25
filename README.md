# Katrix

A [Matrix](https://matrix.org) homeserver as an importable Node.js library, a client SDK, and a public server built on them. (Until 0.4.0 the project was `matrix-nodejs-homeserver`.)

| Directory | What | Published |
|---|---|---|
| [`packages/server`](packages/server) | The library: Client-Server and Server-Server API, E2EE, sliding sync, the OAuth 2.0 API, adapters for SQLite, Postgres and MySQL, an [audit bot](packages/server/AUDITBOT.md). [Documentation](packages/server/README.md). | npm: [`@katrix/server`](https://www.npmjs.com/package/@katrix/server) |
| [`packages/client`](packages/client) | A client SDK: sync, rooms, timelines, end-to-end encryption (Olm and Megolm on `@noble/*`), for Node.js, browsers and React Native. [Documentation](packages/client/README.md). | npm: [`@katrix/client`](https://www.npmjs.com/package/@katrix/client) |
| [`packages/shared`](packages/shared) | What both packages share: the spec's event and endpoint types (one map of Client-Server API requests and responses that the client builds its requests from and the server checks its responses against), canonical JSON, Base64 and UTF-8, identifier checks, `m.*` constants. Built into both packages. | no (bundled) |
| [`apps/public`](apps/public) | The public test server (v0) at [matrix.mwdapis.stream](https://matrix.mwdapis.stream): GitHub is the only login, Postgres, no federation, a Cloudflare tunnel. | no |
| [`apps/dev-idp`](apps/dev-idp) | A development OpenID Connect provider (Better Auth) where you sign in by picking a user. The public server uses it locally in place of GitHub. | no |

```sh
npm install          # every workspace; builds packages/server/dist
npm test             # tests of every workspace
npm run smoke        # a few seconds: does the homeserver work (and the public app's login)?
npm run typecheck
npm run lint && npm run format:check
```

Changes to the packages come with a changeset (`npx changeset`, see [packages/server](packages/server/README.md#releasing)). The apps are private and are not versioned.

[PolyForm Noncommercial 1.0.0](LICENSE).
