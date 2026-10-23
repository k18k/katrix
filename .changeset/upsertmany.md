---
"matrix-nodejs-homeserver": patch
---

Faster writes of large batches (such as push notifications in big rooms) on the SQL adapters: rows were grouped in quadratic time. [#106](https://github.com/k18k/matrix-nodejs-homeserver/issues/106)
