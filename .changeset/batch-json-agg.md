---
"matrix-nodejs-homeserver": patch
---

Batched reads on Postgres return each read's rows as one JSON array. Such statements take half as long for Postgres to plan and are faster to run ([#45](https://github.com/k18k/matrix-nodejs-homeserver/issues/45)).
