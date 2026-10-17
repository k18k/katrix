import { loadConfig } from "./config.ts";
import { startPublicServer } from "./server.ts";

const config = loadConfig();
const { close } = await startPublicServer(config);
console.log(
  `${config.serverName} listening on :${config.port} (login: ${config.provider.name}, database: ${config.databaseUrl ? "Postgres" : "SQLite"})`,
);

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
