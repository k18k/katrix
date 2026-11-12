---
"@katrix/server": patch
---

`postgresCluster`: closing the homeserver while the cluster was reconnecting to Postgres (after a restart or a dropped connection) left one connection checked out of the pool, so `pool.end()` never finished and the process could not shut down. The connection is now released (#116).
