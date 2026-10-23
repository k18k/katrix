---
"matrix-nodejs-homeserver": patch
---

Request bodies are checked by a small built-in validator (vpm) instead of a bundled copy of zod: the published package is smaller and still has no runtime dependencies. Error responses for invalid bodies keep their Matrix error codes; the wording of some generic messages changed.
