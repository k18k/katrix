---
"@katrix/server": patch
---

`/keys/query` passes on the device and cross-signing keys of remote users only when they are well-formed, and only for the users that were asked for; the rest of a remote server's answer is dropped instead of being cached and handed to clients. ([#128](https://github.com/k18k/katrix/issues/128))
