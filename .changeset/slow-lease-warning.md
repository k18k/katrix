---
"matrix-nodejs-homeserver": patch
---

The homeserver logs a warning, with where it was allocated, when a stream position is held for more than 5 seconds: until it is released, no `/sync` gets past it ([#48](https://github.com/k18k/matrix-nodejs-homeserver/issues/48)).
