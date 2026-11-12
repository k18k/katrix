---
"@katrix/server": patch
---

Sending push notifications for a message in a large room is cheaper: the pushers are grouped by user once instead of being searched for every notified user, and unread counts read the events of a user's read receipts in one query instead of one per receipt (#108).
