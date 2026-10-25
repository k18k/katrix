---
"@katrix/client": patch
---

The client can share room keys only with verified devices (#117), like Element's "never send encrypted messages to unverified sessions". Set it everywhere with `e2ee: { onlyVerifiedDevices: true }`, or per room with `client.e2ee.setOnlyVerifiedDevices(true, roomId)`. Refused devices are told why (`m.room_key.withheld` with `m.unverified`, which the recipient sees as `event.withheld`), and they get the key from the next message on once they are verified.
