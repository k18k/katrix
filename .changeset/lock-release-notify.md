---
"matrix-nodejs-homeserver": patch
---

With `postgresCluster`, a lock released on one node wakes the nodes waiting for it at once, instead of them noticing on their next retry ([#32](https://github.com/k18k/matrix-nodejs-homeserver/issues/32)).
