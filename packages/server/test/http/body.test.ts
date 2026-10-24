import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { getNodeHandler, memoryMedia } from "#index.ts";
import { testServer } from "../helpers.ts";

// Request bodies are refused once they pass the upload limit, before they are held in memory (#77).

const LIMIT = 64 * 1024;

async function server() {
  return testServer({ mediaAdapter: { ...memoryMedia(), maxUploadSize: LIMIT } });
}

/** A body stream of `size` bytes without a Content-Length. */
function stream(size: number) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= size) return c.close();
      const n = Math.min(16 * 1024, size - sent);
      sent += n;
      c.enqueue(new Uint8Array(n));
    },
  });
}

test("the fetch handler refuses bodies over the limit, declared or streamed", async () => {
  const t = await server();
  try {
    const token = await t.user("alice");
    const upload = (body: RequestInit["body"], headers: Record<string, string> = {}) =>
      t.handler(
        new Request("http://localhost/_matrix/media/v3/upload", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", ...headers },
          body,
          duplex: "half",
        } as RequestInit),
      );
    assert.equal((await upload(new Uint8Array(LIMIT))).status, 200);
    const declared = await upload(new Uint8Array(LIMIT + 1));
    assert.equal(declared.status, 413);
    assert.equal(((await declared.json()) as any).errcode, "M_TOO_LARGE");
    assert.equal((await upload(stream(LIMIT * 4))).status, 413);
    // JSON endpoints share the limit.
    const json = await t.handler(
      new Request("http://localhost/_matrix/client/v3/user/@alice:localhost/account_data/x", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: stream(LIMIT * 4),
        duplex: "half",
      } as RequestInit),
    );
    assert.equal(json.status, 413);
  } finally {
    await t.close();
  }
});

test("the Node handler answers before reading a body it does not need or will not take", async () => {
  const t = await server();
  const http = createServer(getNodeHandler(t.hs)).listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  const { port } = http.address() as AddressInfo;
  try {
    const token = await t.user("alice");
    /**
     * Send headers, then body chunks until the response arrives or the server closes the connection.
     * Resolves with the status (0 when the connection was reset) and the bytes sent.
     */
    const send = (headers: Record<string, string>, total: number) =>
      new Promise<{ status: number; sent: number }>((resolve) => {
        let sent = 0;
        let answered = false;
        const req = request({ port, host: "127.0.0.1", method: "POST", path: "/_matrix/media/v3/upload", headers }, (res) => {
          answered = true;
          res.resume();
          resolve({ status: res.statusCode!, sent });
          req.destroy();
        });
        req.on("error", () => {
          if (!answered) resolve({ status: 0, sent });
          answered = true;
        });
        const chunk = Buffer.alloc(16 * 1024);
        const pump = () => {
          while (!answered && sent < total) {
            sent += chunk.length;
            if (!req.write(chunk)) return void req.once("drain", pump);
          }
          if (!answered) req.end();
        };
        req.flushHeaders();
        pump();
      });
    // Not authenticated: the body is never read into memory, and the client still gets the 401.
    const anonymous = await send({ "content-length": String(LIMIT / 2) }, LIMIT / 2);
    assert.equal(anonymous.status, 401);
    // Declared over the limit: refused at once, before any of it is sent.
    const declared = await send({ authorization: `Bearer ${token}`, "content-length": String(LIMIT * 1024) }, 0);
    assert.equal(declared.status, 413);
    // Streamed without a length: the server stops reading long before the 64 MiB are sent. It answers 413, or,
    // as the client keeps sending past what it is willing to drop, closes the connection.
    const streamed = await send({ authorization: `Bearer ${token}`, "transfer-encoding": "chunked" }, 1024 * LIMIT);
    assert.ok(streamed.status === 413 || streamed.status === 0, `status ${streamed.status}`);
    assert.ok(streamed.sent < 1024 * LIMIT, `sent ${streamed.sent} bytes`);
    // An upload within the limit still works on the Node handler.
    const ok = await send({ authorization: `Bearer ${token}`, "content-length": String(LIMIT) }, LIMIT);
    assert.equal(ok.status, 200);
  } finally {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    await t.close();
  }
});

test("CORS preflights allow the methods the spec lists (#86)", async () => {
  const t = await testServer();
  try {
    const res = await t.call("OPTIONS", "/_matrix/client/v3/sync");
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-methods"), "GET, HEAD, POST, PUT, DELETE, OPTIONS");
  } finally {
    await t.close();
  }
});

test("a client that stops sending its body still gets the response at once (#103)", async () => {
  const t = await server();
  const http = createServer(getNodeHandler(t.hs)).listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  try {
    const { port } = http.address() as AddressInfo;
    const started = Date.now();
    const head = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () =>
        sock.write("POST /_matrix/media/v3/upload HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nx"),
      );
      sock.once("data", (d) => {
        resolve(d.toString().split("\r\n")[0]);
        sock.destroy();
      });
      sock.once("error", reject);
    });
    assert.match(head, /^HTTP\/1\.1 401/);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  } finally {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    await t.close();
  }
});
