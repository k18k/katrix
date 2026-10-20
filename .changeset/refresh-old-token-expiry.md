---
"matrix-nodejs-homeserver": patch
---

Security fix: after a token refresh, the old access token was still accepted for the rest of that millisecond, on every node of a cluster. It is now rejected at once. [#55](https://github.com/k18k/matrix-nodejs-homeserver/issues/55)
