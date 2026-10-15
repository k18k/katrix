import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHomeserver, filesystemMedia, getNodeHandler, sqliteAdapter } from "../src/index.ts";

const homeserver = createHomeserver({
  homeserver: process.env.SERVER_NAME ?? "localhost",
  databaseAdapter: sqliteAdapter(new DatabaseSync(process.env.DB_PATH ?? "homeserver.db")),
  mediaAdapter: filesystemMedia(".media"),
  // Registration stays closed, but the very first account may register: it becomes a
  // server admin and is placed in the admin room (#admins:<server>), where it can type
  // commands such as `users create alice`, `tokens create 5` or `registration open`.
  userAuthAdapter: { registrationEnabled: false },
  adminRoom: { firstUserIsAdmin: true },
  audit: { enabled: true },
});

// Log failed requests (a 401 is also the normal first step of interactive authentication).
homeserver.on("request", (r: { method: string; path: string; status: number; durationMs: number; error?: { errcode?: string; error?: string } }) => {
  if (r.status >= 400) console.warn(`${r.method} ${r.path} -> ${r.status} ${r.error?.errcode ?? ""} ${r.error?.error ?? ""} (${Math.round(r.durationMs)} ms)`);
});

const server = createServer(getNodeHandler(homeserver));
server.listen(Number(process.env.PORT ?? 8008), () => console.log("Matrix homeserver listening on", server.address()));

process.on("SIGTERM", async () => {
  await homeserver.close();
  server.close();
});
