---
"matrix-nodejs-homeserver": patch
---

Admins can make a local user join a room: `hs.admin.joinUser(userId, roomIdOrAlias)` and Synapse's `POST /_synapse/admin/v1/join/{roomIdOrAlias}` with `{ "user_id" }`. Public rooms are joined directly. In other rooms, a local member who may invite invites the user first, so the room's members see who added them.
