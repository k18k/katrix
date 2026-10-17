---
"matrix-nodejs-homeserver": patch
---

New: an audit bot, `matrix-nodejs-homeserver/auditbot` (`startAuditBot(hs, { sink, dataDir, storePassphrase })`). It records every room of the server to an archive, one JSON line per event, like the Auditing of Element Server Suite Pro. End-to-end encrypted rooms are recorded decrypted: the bot is a room member with its own device, visible in member lists as "Audit log (this room is recorded)". `rooms: "groups"` leaves direct messages out. It needs the optional peer dependency `@matrix-org/matrix-sdk-crypto-nodejs`; the main entry point does not load it. See AUDITBOT.md.
