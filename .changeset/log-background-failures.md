---
"@katrix/server": patch
---

Background work that fails (cluster cache invalidation, wake-ups to other instances, federation updates, the room-upgrade steps after the tombstone, admin-room reports) is now logged as a warning through the `logger` option instead of being dropped silently. ([#125](https://github.com/k18k/katrix/issues/125))
