---
"matrix-nodejs-homeserver": patch
---

Fix: `timestamp_to_event` over federation answered by arrival order instead of timestamp, so other servers could be given a later event than the nearest one. [#105](https://github.com/k18k/matrix-nodejs-homeserver/issues/105)
