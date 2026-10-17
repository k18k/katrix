---
"matrix-nodejs-homeserver": patch
---

A waiting `/sync` (and sliding sync) no longer rebuilds its response whenever anything changes on the server, only when something changes for its user. Under load, most rebuilds used to find nothing new. Presence changes of local users and room state rebuilt after state resolution now wake the users concerned ([#50](https://github.com/k18k/matrix-nodejs-homeserver/issues/50)).
