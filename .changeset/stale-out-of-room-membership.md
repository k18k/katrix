---
"matrix-nodejs-homeserver": patch
---

Fix: when a user knocked again on a remote room right after their knock was rejected, the rejection could arrive over federation after the new knock and replace it, so the new knock never showed up in `/sync`. Membership events for rooms the server is not in no longer replace newer ones. [#48](https://github.com/k18k/matrix-nodejs-homeserver/issues/48)
