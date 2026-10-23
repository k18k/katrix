// matrix-nodejs-homeserver/auditbot: records the server's rooms, end-to-end encrypted ones
// decrypted. Needs the optional peer dependency @matrix-org/matrix-sdk-crypto-nodejs.
export { startAuditBot, type AuditBot, type AuditBotOptions } from "./bot.ts";
export { fileSink, memorySink, type AuditRecord, type AuditSink } from "./sinks.ts";
export { CryptoClient } from "./client.ts";
