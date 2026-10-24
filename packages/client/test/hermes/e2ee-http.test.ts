import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath, URL } from "node:url";
import { Auth } from "../../src/auth/login.ts";
import { MatrixClient } from "../../src/client.ts";
import { fetchHttpAdapter } from "../../src/http/adapter.ts";
import type { FetchLike } from "../../src/platform.ts";
import { decodeUtf8, encodeUtf8 } from "../../src/util/utf8.ts";

// The whole client — login, sync, an encrypted room, Olm and Megolm — in the simulated Hermes
// environment, over real HTTP, against packages/core in another (ordinary Node.js) process.
//
// The platform's fetch here is a small one on node:http: Node's own fetch (undici) needs the
// globals the simulation removes, while React Native brings a native fetch of its own.

const nodeFetch: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: init.method, headers: init.headers }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on("data", (c: Uint8Array) => chunks.push(c));
      res.on("end", () => {
        const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) {
          body.set(c, o);
          o += c.length;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: { get: (n: string) => (res.headers[n.toLowerCase()] as string | undefined) ?? null },
          text: async () => decodeUtf8(body),
          arrayBuffer: async () => body.buffer,
        });
      });
    });
    req.on("error", reject);
    init.signal?.addEventListener("abort", () => req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    if (init.body !== undefined) req.write(typeof init.body === "string" ? encodeUtf8(init.body) : init.body);
    req.end();
  });

async function startServer() {
  const child = spawn(process.execPath, ["--conditions=matrix-src", fileURLToPath(new URL("./server.ts", import.meta.url))], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = /PORT (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.once("exit", (code) => reject(new Error(`server exited (${code})`)));
  });
  return { baseUrl: `http://127.0.0.1:${port}`, stop: () => child.kill("SIGTERM") };
}

async function until<T>(check: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("an end-to-end encrypted conversation, entirely inside the Hermes-like environment", async () => {
  assert.equal((globalThis as Record<string, unknown>).__HERMES_SIMULATION__, true);
  const server = await startServer();
  const http = fetchHttpAdapter(nodeFetch);
  const clients: MatrixClient[] = [];
  try {
    const make = async (name: string) => {
      const credentials = await new Auth({ baseUrl: server.baseUrl, http }).register(name, `${name}-password`);
      const c = new MatrixClient({ baseUrl: server.baseUrl, http, credentials, sync: { pollTimeoutMs: 1000 } });
      clients.push(c);
      await c.start();
      await c.waitForPrepared();
      return c;
    };
    const alice = await make("alice");
    const bob = await make("bob");
    const roomId = await alice.createRoom({ encrypted: true, invite: [bob.userId] });
    await until(() => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    await until(() => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
    await alice.sendText(roomId, "z Hermesa: zażółć 🦀");
    const got = await until(() =>
      bob.getRoom(roomId)?.timeline.events.find((e) => e.decryptionStatus === "decrypted" && e.type === "m.room.message"),
    );
    assert.equal((got.content as { body: string }).body, "z Hermesa: zażółć 🦀");
    await bob.sendText(roomId, "odpowiedź");
    await until(() =>
      alice
        .getRoom(roomId)
        ?.timeline.events.find((e) => e.decryptionStatus === "decrypted" && (e.content as { body?: string }).body === "odpowiedź"),
    );
  } finally {
    for (const c of clients) await c.stop();
    server.stop();
  }
});
