---
"matrix-nodejs-homeserver": patch
---

New: the guarantees a `DatabaseAdapter` must keep are documented on the interface, and `adapterConformance` (with `CONFORMANCE_SCHEMA`) lets you check a custom adapter against them with any test framework. The server now warns at startup when the adapter has no `transaction()`. [#58](https://github.com/k18k/matrix-nodejs-homeserver/issues/58)
