---
"matrix-nodejs-homeserver": patch
---

Incremental `/sync` sends its independent database reads together: one round trip per group on Postgres instead of one per read ([#34](https://github.com/k18k/matrix-nodejs-homeserver/issues/34)). Database adapters can implement the new optional `findManyBatch` for this.
