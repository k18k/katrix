---
"matrix-nodejs-homeserver": minor
---

Export `M`, a readonly object with the Matrix identifiers the server uses (event types, login types, capabilities, push rule IDs, ...), so code can write `M.ROOM.MEMBER` or `M.LOGIN.PASSWORD` instead of the strings `"m.room.member"` and `"m.login.password"`. `UNSTABLE` does the same for identifiers outside the `m.` namespace, such as `UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET` for `"org.matrix.cross_signing_reset"`.
