---
"matrix-nodejs-homeserver": patch
---

Fix (`memoryAdapter`): rolling back a transaction could overwrite a write made outside it in the meantime. Operations now wait while a transaction is open, as on SQLite. [#101](https://github.com/k18k/matrix-nodejs-homeserver/issues/101)
