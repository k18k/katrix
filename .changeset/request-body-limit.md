---
"matrix-nodejs-homeserver": patch
---

Security fix: request bodies were read into memory in full before the upload limit was checked, so one oversized request could exhaust the server's memory; with the Node and Express handlers even without an access token. Bodies are now refused as soon as they pass the limit (`413 M_TOO_LARGE`), and the Node handler no longer reads a body before a handler asks for it. The limit (the media adapter's `maxUploadSize`, 50 MiB by default) now applies to every request body, not only uploads. [#77](https://github.com/k18k/matrix-nodejs-homeserver/issues/77)
