---
"matrix-nodejs-homeserver": patch
---

Incremental `/sync` reads only the membership and device-list changes that concern the user, instead of every change on the server since the token, and a new message loads the pushers of all notified members in one query ([#31](https://github.com/k18k/matrix-nodejs-homeserver/issues/31)).
