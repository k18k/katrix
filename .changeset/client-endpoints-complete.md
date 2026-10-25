---
"@katrix/client": patch
---

The client now calls every endpoint of the Client-Server API (Matrix v1.19, except the deprecated ones), and a test keeps it that way (#117). New in this release:

- Key backup management: `backup.versionInfo()`, `backup.signWithMasterKey()` and `backup.deleteKeys()`. Uploads of a single session or room use their own endpoints.
- Device list changes between two sync tokens: `e2ee.devices.changesBetween()`.
- `push.rules({ scope: "global" })`.
- Joining by room ID without servers uses `/rooms/{roomId}/join`.
