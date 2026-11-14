---
"@katrix/server": patch
---

Security: a server's key response (`/_matrix/key/v2/server`) is accepted only when it has at least one current key and every current key signed it, and the key notary (`/_matrix/key/v2/query`) countersigns only responses it accepted. Before, a response without a usable current key had its old keys stored unverified, and the notary vouched for responses that had failed the check. ([#136](https://github.com/k18k/katrix/issues/136))
