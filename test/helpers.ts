import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHomeserver, getFetchHandler, memoryAdapter, type HomeserverOptions } from "#index.ts";

/** A homeserver on the in-memory adapter, called through its fetch handler (no port is opened). */
export async function testServer(options: Partial<HomeserverOptions> = {}) {
  const hs = createHomeserver({
    homeserver: "localhost",
    databaseAdapter: memoryAdapter(),
    userAuthAdapter: { registrationEnabled: true },
    cleanupIntervalMs: 0,
    // Tests check responses; expected server errors would only clutter the output.
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...options,
  });
  await hs.ready;
  const handler = getFetchHandler(hs);

  /** Send a request; `body` is sent as JSON. Redirects are not followed. */
  async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
    const res = await handler(
      new Request(`http://localhost${path}`, {
        method,
        redirect: "manual",
        headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  /** Create a user (optionally an admin) and return an access token for it. */
  async function user(localpart: string, opts: { admin?: boolean } = {}): Promise<string> {
    await hs.admin.createUser(localpart, { password: "password", admin: opts.admin });
    const res = await call("POST", "/_matrix/client/v3/login", {
      body: { type: "m.login.password", identifier: { type: "m.id.user", user: localpart }, password: "password" },
    });
    return res.json.access_token;
  }

  return { hs, handler, call, user, close: () => hs.close() };
}

/** A plain HTTP server on a random local port; returns its base URL. */
export async function localServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
