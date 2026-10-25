---
"@katrix/client": patch
---

End-to-end encryption key management (#117):

- **Cross-signing** (`client.e2ee.crossSigning`): create the user's keys, sign their own devices, verify other users, and ask whether a user or device is verified. A user whose identity changed is flagged with `identityChanged` until the change is accepted. The master key's private half is never stored on the device.
- **Secret storage** (`client.e2ee.secretStorage`): secrets kept in account data, encrypted with a recovery key or passphrase. Recovery keys are compatible with Element.
- **Key backup** (`client.e2ee.backup`): room keys are uploaded to a trusted backup automatically. A missing key is looked up there first.
- **Recovery** (`client.e2ee.recovery`): `setUp({ passphrase })` returns a recovery key. `recover(recoveryKeyOrPassphrase)` gives a new device the user's identity and message history.
- **Sharing between the user's own verified devices** (`client.e2ee.sharing`): room key requests and forwarded keys, secret requests, and withheld notices (`event.withheld`). Keys and secrets are only given to, and only taken from, the user's own verified devices.
