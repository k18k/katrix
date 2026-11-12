---
"@katrix/client": patch
---

Restoring from key backup checks every field of each decrypted session and rejects a malformed one with a clear error. `BackedUpSession` now marks `forwarding_curve25519_key_chain` and `sender_claimed_keys` optional, as backups from other clients may leave them out; code that reads them must handle `undefined`. OAuth client registration reports a non-JSON error response as a `MatrixError` instead of throwing a `SyntaxError`. ([#127](https://github.com/k18k/katrix/issues/127))
