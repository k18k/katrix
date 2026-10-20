---
"matrix-nodejs-homeserver": patch
---

Invite blocking from spec v1.18: with `m.invite_permission_config` set to `{ "default_action": "block" }` in a user's account data, every invite to them is refused with `403 M_INVITE_BLOCKED` (client invites, member state, federation), `createRoom` leaves them out of its invites, and pending invites are hidden from `/sync`. Blocked invites now use the error code `M_INVITE_BLOCKED` instead of `M_FORBIDDEN`, also for the unstable MSC4155 rules. [#88](https://github.com/k18k/matrix-nodejs-homeserver/issues/88)
