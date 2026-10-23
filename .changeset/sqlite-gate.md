---
"matrix-nodejs-homeserver": patch
---

Fix (SQLite): a write that ran at the same moment as another request's transaction could end up inside that transaction, and was lost when it rolled back, although it had reported success. [#95](https://github.com/k18k/matrix-nodejs-homeserver/issues/95)
