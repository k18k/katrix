---
"matrix-nodejs-homeserver": patch
---

Incremental `/sync` no longer scans every membership on the server: the memberships table gets an index on its stream position ([#28](https://github.com/k18k/matrix-nodejs-homeserver/issues/28)).
