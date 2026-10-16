---
"matrix-nodejs-homeserver": patch
---

Canonical JSON orders keys by Unicode code point, as the spec requires. Keys with characters outside the Basic Multilingual Plane (such as emoji) were ordered differently, so hashes and signatures of such events did not match other servers' ([#25](https://github.com/k18k/matrix-nodejs-homeserver/issues/25)).
