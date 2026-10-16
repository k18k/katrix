---
"matrix-nodejs-homeserver": minor
---

Federation is now off by default. A server joins the Matrix network only with `federation: { enabled: true }`; without it, local users can only talk to each other. Servers that federate today must add that option.
