---
"@katrix/server": patch
---

The Fastify plugin streams in both directions, like the Node adapter. Responses are no longer copied into memory first, so a media download does not hold the whole file, and it stops when the client disconnects. Request bodies are no longer read by Fastify before the request is routed and authenticated: a handler reads the body only when it needs it, under the server's upload limit (`maxUploadSize`, 50 MiB by default) rather than Fastify's own 1 MiB default, which refused larger uploads (#109).
