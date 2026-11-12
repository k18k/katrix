import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath, URL } from "node:url";
import { Auth } from "../../src/auth/login.ts";
import { MatrixClient } from "../../src/client.ts";
import { fetchHttpAdapter } from "../../src/http/adapter.ts";
import type { FetchLike } from "../../src/platform.ts";
import { concatBytes, decodeUtf8, encodeUtf8 } from "@katrix/shared";

// The whole client — login, sync, an encrypted room, Olm and Megolm — in the simulated Hermes
// environment, over real HTTP, against packages/server in another (ordinary Node.js) process.
//
// The platform's fetch here is a small one on node:net: Node's fetch and node:http (undici) need
// the globals the simulation removes, while React Native brings a native fetch of its own.

/**
 * HTTP/1.1 over a plain socket, one connection per request (Connection: close): enough for the
 * client's JSON requests and long-polling /sync.
 */
const socketFetch: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const m = /^http:\/\/([^/:]+):(\d+)(\/.*)$/.exec(url);
    if (!m) return reject(new Error("only http://host:port/… URLs"));
    const body = init.body === undefined ? new Uint8Array(0) : typeof init.body === "string" ? encodeUtf8(init.body) : init.body;
    const socket = connect(Number(m[2]), m[1]);
    const chunks: Uint8Array[] = [];
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const onAbort = () => {
      socket.destroy();
      fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    init.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("connect", () => {
      const headers = { ...init.headers, host: `${m[1]}:${m[2]}`, connection: "close", "content-length": String(body.length) };
      socket.write(
        encodeUtf8(
          `${init.method} ${m[3]} HTTP/1.1\r\n${Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n")}\r\n\r\n`,
        ),
      );
      socket.write(body);
    });
    socket.on("data", (c: Uint8Array) => chunks.push(c));
    socket.on("error", fail);
    socket.on("end", () => {
      const raw = concatBytes(...chunks);
      let split = 0;
      while (split + 3 < raw.length && !(raw[split] === 13 && raw[split + 1] === 10 && raw[split + 2] === 13 && raw[split + 3] === 10))
        split++;
      const head = decodeUtf8(raw.subarray(0, split)).split("\r\n");
      const status = Number(head[0].split(" ")[1]);
      const headers = new Map(
        head.slice(1).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()] as [string, string]),
      );
      let rest = raw.subarray(split + 4);
      if (headers.get("transfer-encoding") === "chunked") {
        const parts: Uint8Array[] = [];
        for (;;) {
          let eol = 0;
          while (rest[eol] !== 13) eol++;
          const size = parseInt(decodeUtf8(rest.subarray(0, eol)), 16);
          if (!size) break;
          parts.push(rest.subarray(eol + 2, eol + 2 + size));
          rest = rest.subarray(eol + 2 + size + 2);
        }
        rest = concatBytes(...parts);
      }
      settled = true;
      const bytes = rest.slice();
      resolve({
        status,
        headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
        text: async () => decodeUtf8(bytes),
        arrayBuffer: async () => bytes.buffer,
      });
    });
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
  const http = fetchHttpAdapter(socketFetch);
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
