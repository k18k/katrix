---
"matrix-nodejs-homeserver": patch
---

Fix: a Postgres restart, or a dropped connection, crashed the process (`pg` emits an `error` event that nothing handled). `postgresAdapter` and `postgresCluster` now handle it; requests fail while the database is away and work again when it is back. [#91](https://github.com/k18k/matrix-nodejs-homeserver/issues/91)
