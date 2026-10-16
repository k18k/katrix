---
"matrix-nodejs-homeserver": patch
---

Push evaluation no longer copies every room member's push rules for each message, which cut the homeserver's CPU use when messages are sent in large rooms ([#41](https://github.com/k18k/matrix-nodejs-homeserver/issues/41)).
