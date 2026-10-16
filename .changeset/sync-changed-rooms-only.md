---
"matrix-nodejs-homeserver": patch
---

Incremental `/sync` finds the rooms that changed with a few queries for all of the user's rooms and builds only those, instead of querying every joined room each time ([#33](https://github.com/k18k/matrix-nodejs-homeserver/issues/33)). Custom database adapters may receive a new `fields` option in `findMany`; returning whole rows remains correct.
