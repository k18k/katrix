import { createHomeserver, getFetchHandler, memoryAdapter, type HomeserverOptions } from "@katrix/server";
import { Auth } from "../../src/auth/login.ts";
import { MatrixClient, type ClientOptions } from "../../src/client.ts";
import { fetchHttpAdapter, type HttpAdapter } from "../../src/http/adapter.ts";
import type { MatrixEvent } from "../../src/models/event.ts";
import type { Logger } from "../../src/util/logger.ts";

/** A homeserver from packages/server, in memory, reached through its fetch handler (no port). */
export async function homeserver(options: Partial<HomeserverOptions> = {}) {
  const hs = createHomeserver({
    homeserver: "localhost",
    databaseAdapter: memoryAdapter(),
    userAuthAdapter: { registrationEnabled: true },
    // The client waits out 429s on its own (test/unit/http.test.ts); here they would only slow
    // the tests down.
    rateLimits: false,
    cleanupIntervalMs: 0,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...options,
  });
  await hs.ready;
  const handler = getFetchHandler(hs);
  const http: HttpAdapter = fetchHttpAdapter((url, init) => handler(new Request(url, init as RequestInit)) as never);
  const baseUrl = "http://localhost";
  const clients: MatrixClient[] = [];

  /** Create a user and log a new device in with a password. */
  async function login(localpart: string, opts: Partial<ClientOptions> & { password?: string; create?: boolean; admin?: boolean } = {}) {
    if (opts.create !== false)
      await hs.admin.createUser(localpart, { password: opts.password ?? "password", admin: opts.admin }).catch(() => {});
    const credentials = await new Auth({ baseUrl, http }).loginWithPassword(localpart, opts.password ?? "password");
    const client = new MatrixClient({ baseUrl, http, credentials, sync: { pollTimeoutMs: 1000 }, ...opts });
    clients.push(client);
    return client;
  }

  return {
    hs,
    http,
    baseUrl,
    login,
    async close() {
      for (const c of clients) await c.stop().catch(() => {});
      await hs.close();
    },
  };
}

export async function until<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The first timeline event in the room that matches, once it has arrived (and is decrypted). */
export function findEvent(client: MatrixClient, roomId: string, match: (e: MatrixEvent) => boolean): MatrixEvent | undefined {
  return client.getRoom(roomId)?.timeline.events.find(match);
}

export const body = (e: MatrixEvent) => (e.content as { body?: string }).body;

/** A logger that keeps every line, to check that no secret is ever logged. */
export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const rec = (level: string) => (m: string, d?: Record<string, unknown>) => {
    lines.push(`${level} ${m} ${d ? JSON.stringify(d) : ""}`);
  };
  return { lines, debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") };
}
