---
"matrix-nodejs-homeserver": patch
---

Security fix: `GET /rooms/{roomId}/members?at=…` let a user who had left or been banned from a room read its member list at any later point, including the current one. `at` now has to point to a moment the user may see under the room's history visibility; otherwise the answer is `403`. [#78](https://github.com/k18k/matrix-nodejs-homeserver/issues/78)
