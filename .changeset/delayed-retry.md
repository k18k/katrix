---
"matrix-nodejs-homeserver": patch
---

Fix: a delayed event (MSC4140, used by MatrixRTC to end the call membership of a client that went away) was lost when sending it failed once, or when its instance stopped at that moment. It is now kept until it is sent, retried after 10 seconds, and never sent twice; only a send the room refuses drops it. [#100](https://github.com/k18k/matrix-nodejs-homeserver/issues/100)
