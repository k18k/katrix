---
"@katrix/server": patch
---

Membership methods moved from `hs.rooms` to `hs.membership`: `join`, `invite`, `setMembership`, `resolveRoom`, `resolveRoomIdOrAlias`, `removeGuests` and `propagateProfile`. Breaking for code that calls them on `hs.rooms`. ([#131](https://github.com/k18k/katrix/issues/131))
