---
"@katrix/client": patch
---

The client no longer passes unchecked sync fields on: room member counts, unread counts and one-time key counts that are not numbers are dropped. Breaking for TypeScript users: `MatrixHttpApi.request()` now returns `Record<string, unknown>` when no type argument is given, and decrypted to-device content is `Record<string, unknown>`; narrow the fields you read. ([#128](https://github.com/k18k/katrix/issues/128))
