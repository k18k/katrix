---
"matrix-nodejs-homeserver": patch
---

Security fix: the OAuth 2.0 token endpoint answered `500` to `Authorization: Basic` credentials with a malformed percent-escape, which any anonymous client could trigger. It now answers `401 invalid_client`. [#76](https://github.com/k18k/matrix-nodejs-homeserver/issues/76)
