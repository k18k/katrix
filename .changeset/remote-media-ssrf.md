---
"matrix-nodejs-homeserver": patch
---

Security ([#20](https://github.com/k18k/matrix-nodejs-homeserver/issues/20)): when a remote server answers a media download with a link to the file, the server fetches that link only from public addresses, over http(s), with the media size limit. Before, a remote server could make it read internal addresses and pass the responses to a local user.
