---
"@katrix/client": patch
---

Push notifications on `client.push` (#117): pushers, push rules (add, remove, enable, change actions, mute and unmute rooms), and the server's notification list. The client also evaluates the push rules itself, on the plaintext of encrypted messages, which the server cannot read: the new `notification` event fires for messages that should notify (with `highlight` and `sound`), and `client.getUnreadCounts(roomId)` counts unread messages in encrypted rooms from the decrypted timeline.
