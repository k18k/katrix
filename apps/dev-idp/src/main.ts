// Runs the development identity provider (see server.ts). Configured through the environment:
//   DEV_IDP_BASE_URL       the URL browsers and the homeserver reach it at
//   DEV_IDP_REDIRECT_URIS  comma-separated callback URLs of the homeserver
//   PORT, HOST             where it listens (default 3001, 0.0.0.0)
import { startDevIdp } from "./server.ts";

const baseUrl = process.env.DEV_IDP_BASE_URL ?? "http://dev-idp.localhost:3001";
const idp = await startDevIdp({
  baseUrl,
  redirectUris: (process.env.DEV_IDP_REDIRECT_URIS ?? "http://localhost:8008/_matrix/client/v3/login/sso/callback/dev").split(","),
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "0.0.0.0",
});
console.log(`Dev identity provider at ${baseUrl} (issuer ${idp.issuer}, client ${idp.clientId})`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void idp.close().then(() => process.exit(0)));
