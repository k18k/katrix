---
"@katrix/client": patch
---

Sync improvements (#117):

- The client asks for the room state at the end of the timeline (`use_state_after`, Matrix 1.16), which avoids wrong room state after gaps. Servers that do not support it answer as before. It can be turned off with `sync.useStateAfter: false`.
- Unread counts per thread are in `room.threadNotifications`.
- Users' presence is in `client.getPresence(userId)`, and `client.presence.set()` now sticks: sync no longer resets it to online.
- `room.isDirect()` and `room.lastActivity()` help build room lists.

**Breaking:** `logout()` now deletes the device's stored state (rooms, sync token, keys), because they are useless once the device is logged out. Pass `{ clearStorage: false }` to keep it.
