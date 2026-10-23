---
"matrix-nodejs-homeserver": patch
---

Security fix: every URL preview request fetched the page and its image again and stored a new copy of the image, so one account could make the server download and keep any amount of data. Previews are now reused for an hour, built once for concurrent requests, and rate limited per user (new rate-limit action `preview`, 0.5/s with a burst of 10 by default). [#104](https://github.com/k18k/matrix-nodejs-homeserver/issues/104)
