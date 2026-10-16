---
"matrix-nodejs-homeserver": patch
---

`/sync` deletes acknowledged to-device messages only when the previous response delivered some, rather than on every sync. Sync tokens of responses with to-device messages end in `_a` ([#42](https://github.com/k18k/matrix-nodejs-homeserver/issues/42)).
