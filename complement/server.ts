// Entrypoint used by the Complement test image. Runs the TypeScript sources
// directly (Node 26 type stripping) on plain HTTP :8008 and HTTPS :8448.
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHomeserver, filesystemMedia, getNodeHandler, loadAppServiceRegistrations, sqliteAdapter } from "../src/index.ts";

const serverName = process.env.SERVER_NAME ?? "localhost";
const dataDir = process.env.DATA_DIR ?? "/data";

// Complement mounts application service registrations here.
const appservices = await loadAppServiceRegistrations("/complement/appservice");

const homeserver = createHomeserver({
  appservices,
  homeserver: serverName,
  federation: { enabled: true },
  // Complement's servers, push gateways and identity servers are on the private Docker network.
  allowPrivateAddresses: true,
  databaseAdapter: sqliteAdapter(new DatabaseSync(`${dataDir}/homeserver.db`)),
  mediaAdapter: filesystemMedia(`${dataDir}/media`),
  userAuthAdapter: { registrationEnabled: true },
  // Complement registers many users and sends bursts of events from the same IP.
  rateLimits: false,
  registrationSharedSecret: "complement",
  // Complement's Synapse configuration names the notices user @_server.
  serverNotices: { localpart: "_server" },
  // Complement serves preview pages from the Docker host, which is a private address.
  urlPreviews: { allowPrivateAddresses: true },
  logger: {
    debug: (...a) => {
      if (process.env.MATRIX_DEBUG) console.log("[debug]", ...a);
    },
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
  },
});

const handler = getNodeHandler(homeserver);
createServer(handler).listen(8008, () => console.log(`[${serverName}] client API on :8008`));

const cert = `${dataDir}/tls/server.crt`;
const key = `${dataDir}/tls/server.key`;
if (existsSync(cert) && existsSync(key)) {
  createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, handler).listen(8448, () =>
    console.log(`[${serverName}] federation port on :8448 (TLS)`),
  );
}

// Complement restarts containers: shut down promptly instead of waiting to be killed.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void homeserver.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
