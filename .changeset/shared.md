---
"@katrix/server": patch
"@katrix/client": patch
---

Both packages now export the spec's types for the Client-Server API endpoints they use: request and response types (`LoginRequest`, `LoginResponse`, `SyncResponse`, `KeysQueryResponse`, …) and the map of endpoints, `ClientEndpoints`. `@katrix/client` builds its requests from that map (`MatrixHttpApi.endpoint()`), and `@katrix/server` checks its responses against it. The client's `RawEvent` type is now `ClientEvent`, and `UserIdentifier` and `AuthMetadata` come from the shared types; **code that imports `RawEvent` must use `ClientEvent`.**

`@katrix/server`'s canonical JSON now refuses integers outside the spec's range (±(2^53 − 1)), as the client's did: such numbers do not survive a JSON round trip in JavaScript, and from 1e21 on they were written in exponent notation, which is not canonical JSON.
