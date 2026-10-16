---
"matrix-nodejs-homeserver": patch
---

Servers using `postgresCluster` no longer hang under load: cluster locks are leases in the database instead of advisory locks that kept a pool connection busy, which could take every connection and stop the server ([#29](https://github.com/k18k/matrix-nodejs-homeserver/issues/29)).
