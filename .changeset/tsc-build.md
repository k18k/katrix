---
"matrix-nodejs-homeserver": patch
---

The package is built with TypeScript itself instead of tsdown, and declares no dependencies (the audit bot's crypto module stays an optional peer dependency). The published files keep the same layout: one `.js` and one `.d.ts` per module under `dist/`.
