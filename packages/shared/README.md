# @katrix/shared

What [`@katrix/server`](../server) and [`@katrix/client`](../client) both need. Not published: tsdown builds it into each package (`dist/shared/`, code and declarations), and both re-export its types.

- `ClientEndpoints` (`src/api/endpoints.ts`): the Client-Server API endpoints by `"METHOD /path"`, each with its request and response type. The client calls them through `MatrixHttpApi.endpoint()`; the server binds its routes to them with `procedure({ endpoint })`, so its handlers must return the response type, and a test checks that its body schemas accept every request the types allow.
- The spec's event types (`EventContentMap`, `ClientEvent`, …), error bodies and codes.
- Portable code: canonical JSON, unpadded Base64, strict UTF-8, identifier checks, the `m.*` identifiers (`M`, `UNSTABLE`).

Everything here follows the client's platform rules (plain ECMAScript, no Node.js or browser APIs), because it runs in React Native too; `packages/client/test/unit/portability.test.ts` checks this package as well.
