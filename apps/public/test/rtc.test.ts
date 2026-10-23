import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect, type AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { startPublicServer } from "../src/server.ts";

test("calls: the LiveKit transport is advertised and /livekit/jwt/ reaches the authorization service", async () => {
  // A stand-in for lk-jwt-service that echoes what it got.
  const jwt = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, jwt: "token" }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => jwt.once("listening", r));
  const dataDir = mkdtempSync(`${tmpdir()}/public-rtc-`);
  const app = await startPublicServer(
    loadConfig({
      SERVER_NAME: "matrix.test",
      PORT: "0",
      DATA_DIR: dataDir,
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      LIVEKIT_JWT_URL: `http://127.0.0.1:${(jwt.address() as AddressInfo).port}`,
    }),
  );
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const client = (await (await fetch(`${base}/.well-known/matrix/client`)).json()) as Record<string, any>;
    assert.deepEqual(client["org.matrix.msc4143.rtc_foci"], [{ type: "livekit", livekit_service_url: "https://matrix.test/livekit/jwt" }]);
    // lk-jwt-service finds the homeserver for OpenID checks through the server delegation.
    assert.deepEqual(await (await fetch(`${base}/.well-known/matrix/server`)).json(), { "m.server": "matrix.test:443" });
    const res = await fetch(`${base}/livekit/jwt/get_token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"room_id":"!r"}',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await res.json(), { method: "POST", url: "/get_token", body: '{"room_id":"!r"}', jwt: "token" });
    // A client that aborts its upload does not take the server down (#99).
    await new Promise<void>((resolve) => {
      const sock = connect((app.server.address() as AddressInfo).port, "127.0.0.1", () => {
        sock.write("POST /livekit/jwt/get_token HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n0123456789");
        setTimeout(() => {
          sock.destroy();
          setTimeout(resolve, 50);
        }, 50);
      });
    });
    assert.equal((await fetch(`${base}/.well-known/matrix/server`)).status, 200);
    // Oversized bodies are refused, not buffered (#83).
    const big = await fetch(`${base}/livekit/jwt/get_token`, { method: "POST", body: "x".repeat(65 * 1024) });
    assert.equal(big.status, 413);
  } finally {
    await app.close();
    jwt.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
