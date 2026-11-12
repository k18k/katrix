---
"@katrix/client": patch
---

The room model understands relations (#117). Edits are applied: `event.latestContent` is the newest valid edit, checked against the spec's rules, so only the sender can edit their message, and the server's bundled edit is used too. Reactions are grouped per key with `room.reactions(eventId)`, and threads are summarised with `room.threadSummary(rootId)` and `room.mainTimeline()`. A `room.relation` event fires when any of these change. To send them there are `sendEdit`, `sendReply` (it mentions the person replied to and stays in their thread), `sendThreadMessage` and `removeReaction`.

Direct chats: `createDirectRoom`, `findDirectRoom` and `markDirect`. Accepting a direct invite records it in `m.direct`. Spaces on `client.spaces`: create a space, add and remove children and parents (in the spec's order), and read the hierarchy. Upgraded rooms: `room.successor()`, `room.predecessor()` and `client.followUpgrade()`.
