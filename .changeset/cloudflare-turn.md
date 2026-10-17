---
"matrix-nodejs-homeserver": patch
---

TURN credentials can come from a service: `rtc.turn.credentials(userId)`. `cloudflareTurn({ keyId, apiToken })` uses Cloudflare's managed TURN, so voice and video calls can relay media without running coturn or opening ports. `rtc.turn.uris` is optional when `credentials` is set.
