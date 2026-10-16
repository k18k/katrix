---
"matrix-nodejs-homeserver": patch
---

On Postgres, reads that concurrent requests make at the same moment are sent to the database as one statement, which cuts the per-query overhead under load. In the load test, messages reached other users' `/sync` about 30% sooner. Nothing is cached ([#43](https://github.com/k18k/matrix-nodejs-homeserver/issues/43)).

`DatabaseAdapter.findManyBatch` takes an optional second argument, `{ prepare }`, and `SqlExecutor.query` takes a third. Custom adapters that implement them can ignore these.
