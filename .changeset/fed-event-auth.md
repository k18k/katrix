---
"matrix-nodejs-homeserver": patch
---

Security fix: over federation, `event_auth` returned the auth chain (power levels, memberships, join rules) of events in other rooms than the one asked about, also rooms whose server ACL denies the asking server. [#97](https://github.com/k18k/matrix-nodejs-homeserver/issues/97)
