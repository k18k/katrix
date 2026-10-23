---
"matrix-nodejs-homeserver": patch
---

Fix (Node and Express handlers): when a request was answered without reading its whole body (such as a 401 for an upload with an expired token), the response waited until the client had sent the rest, so a client that stopped sending got no answer for minutes. The response now goes out at once; the rest of the body is dropped for up to 5 seconds, then the connection is closed. [#103](https://github.com/k18k/matrix-nodejs-homeserver/issues/103)
