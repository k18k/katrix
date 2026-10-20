---
"matrix-nodejs-homeserver": patch
---

Security fix: with guest access enabled, guests could join any room, also rooms whose `m.room.guest_access` does not allow them. Guests now join only rooms with `guest_access: can_join`, and leave a room when that setting is turned off, as the spec requires. [#87](https://github.com/k18k/matrix-nodejs-homeserver/issues/87)
