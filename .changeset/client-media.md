---
"@katrix/client": patch
---

Media on `client.media` (#117): uploads (including asynchronous uploads to a reserved mxc:// URI), authenticated downloads and thumbnails, URL previews, and the server's upload limit. `client.sendFile` uploads and sends a file; in an encrypted room it encrypts the file first (AES-256-CTR, with its SHA-256 checked on download), so the server never sees it. `encryptAttachment` and `decryptAttachment` are exported for apps that handle files themselves.
