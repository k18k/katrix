---
"@katrix/client": patch
---

Key verification on `client.e2ee.verification` (#117). To verify another user, `requestUserVerification(roomId, userId)` sends the request in a room. To verify one of your own devices, `requestOwnDeviceVerification()` sends it to-device. Incoming requests arrive as the `request` event, and you accept or cancel them.

Two methods are supported:

- **SAS**, where both users compare emoji or numbers (`confirmSas` or `mismatchSas`).
- **QR codes**: `qrCode()` returns the bytes to draw, and `scanQrCode(bytes)` reads the other side's code.

Verifying another user signs their master key, so all their devices are trusted. Verifying your own new device makes it trust your identity and fetch the cross-signing and backup keys from the device that verified it.
