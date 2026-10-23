---
"matrix-nodejs-homeserver": patch
---

Security fix: a remote server's verify key that had expired was still accepted for signatures made after its expiry, when no newer key could be fetched. Expired keys now count only for events created while they were valid. [#98](https://github.com/k18k/matrix-nodejs-homeserver/issues/98)
