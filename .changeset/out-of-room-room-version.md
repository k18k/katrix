---
"matrix-nodejs-homeserver": patch
---

Fix: after a knock was rejected or an invite rescinded in a remote room, the next membership change for that user (a second rejection, an invite) was dropped in rooms of version 3 and later. [#84](https://github.com/k18k/matrix-nodejs-homeserver/issues/84)
