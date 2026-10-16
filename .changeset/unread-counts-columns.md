---
"matrix-nodejs-homeserver": patch
---

Unread counts in `/sync` read three columns of the unread notifications through an index on (user, room, position), instead of whole rows with their actions ([#36](https://github.com/k18k/matrix-nodejs-homeserver/issues/36)).
