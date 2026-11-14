---
"@katrix/server": patch
---

Answers from identity servers are checked: a stored third-party invite needs a token, a display name and at least one public key with its validity URL, and only well-formed keys go into the room's `m.room.third_party_invite` event. Before, whatever the identity server returned was written into room state. ([#128](https://github.com/k18k/katrix/issues/128))
