---
"matrix-nodejs-homeserver": patch
---

Faster message sending in busy rooms: the push notifications for a new event are stored together in one transaction instead of one write per member ([#27](https://github.com/k18k/matrix-nodejs-homeserver/issues/27)).
