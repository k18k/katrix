// Local development in one process, without Docker: the development identity provider (sign in by
// picking a user) and the public server on SQLite.
//
//   npm run dev -w @katrix/public     # or `npm run dev` in apps/public
//
// The homeserver is at http://localhost:8008, the provider at http://localhost:3001; data is kept
// in apps/public/.dev-data (delete it to start over). Ports: PORT and DEV_IDP_PORT.
import { startDevIdp } from "@katrix/dev-idp";
import { loadConfig } from "./config.ts";
import { startPublicServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8008);
const idpPort = Number(process.env.DEV_IDP_PORT ?? 3001);
const publicBaseUrl = `http://localhost:${port}`;

const idp = await startDevIdp({
  baseUrl: `http://localhost:${idpPort}`,
  port: idpPort,
  redirectUris: [`${publicBaseUrl}/_matrix/client/v3/login/sso/callback/dev`],
});
const config = loadConfig({
  SERVER_NAME: "localhost",
  PUBLIC_BASE_URL: publicBaseUrl,
  PORT: String(port),
  DATA_DIR: process.env.DATA_DIR ?? new URL("../.dev-data", import.meta.url).pathname,
  LOGIN_PROVIDER: "dev",
  DEV_IDP_ISSUER: idp.issuer,
  DEV_IDP_CLIENT_ID: idp.clientId,
  DEV_IDP_CLIENT_SECRET: idp.clientSecret,
  ADMINS: process.env.ADMINS ?? "@alice:localhost",
});
const app = await startPublicServer(config);

console.log(`Homeserver:  ${publicBaseUrl}  (SQLite in ${config.dataDir})`);
console.log(`Dev login:   ${idp.baseUrl}  (Alice, Bob, Carol; @alice:localhost is an admin)`);
console.log(`Point a client at ${publicBaseUrl}, for example https://app.element.io`);

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void Promise.all([app.close(), idp.close()]).then(() => process.exit(0));
  });
