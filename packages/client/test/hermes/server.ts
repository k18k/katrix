// A homeserver (packages/server) on a local port, for clients that run in the simulated Hermes
// environment in another process. Prints "PORT <n>" once it listens.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHomeserver, getNodeHandler, memoryAdapter } from "@katrix/server";

const hs = createHomeserver({
  homeserver: "localhost",
  databaseAdapter: memoryAdapter(),
  userAuthAdapter: { registrationEnabled: true },
  // Both test users register from 127.0.0.1 within milliseconds.
  rateLimits: false,
  cleanupIntervalMs: 0,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
await hs.ready;
const server = createServer(getNodeHandler(hs)).listen(0, "127.0.0.1", () => {
  process.stdout.write(`PORT ${(server.address() as AddressInfo).port}\n`);
});
process.on("SIGTERM", () => {
  server.close();
  void hs.close().then(() => process.exit(0));
});
