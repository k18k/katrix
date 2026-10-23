---
"matrix-nodejs-homeserver": patch
---

Security fix: when `postgresCluster`'s connection for cluster messages dropped (a Postgres restart), it was not opened again, so the instance missed every later logout, token revocation and cache invalidation from the other instances, and kept accepting revoked tokens. It now reconnects, and drops its caches of shared state afterwards, since messages sent meanwhile are lost. [#92](https://github.com/k18k/matrix-nodejs-homeserver/issues/92)
