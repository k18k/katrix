---
"matrix-nodejs-homeserver": patch
---

Fix: two concurrent uploads to the same pending media ID (`PUT /_matrix/media/v3/upload/...`) could both succeed and store different content under one ID. The second now gets `409 M_CANNOT_OVERWRITE_MEDIA`. [#102](https://github.com/k18k/matrix-nodejs-homeserver/issues/102)
