---
"matrix-nodejs-homeserver": patch
---

Incremental `/sync` finds presence and device-list changes through a new index on `presence.stream`, instead of looking up every user who shares a room. This takes load off the database ([#44](https://github.com/k18k/matrix-nodejs-homeserver/issues/44)).
