---
"matrix-nodejs-homeserver": patch
---

Faster writes with a cluster adapter: concurrent writes share the publish of their stream position instead of waiting for each other one by one ([#30](https://github.com/k18k/matrix-nodejs-homeserver/issues/30)).
