---
"matrix-nodejs-homeserver": patch
---

Much less database load from online users: `/sync` refreshes a user's last-active time at most once a minute instead of on every request, which took about half of the server's time under load ([#26](https://github.com/k18k/matrix-nodejs-homeserver/issues/26)).
