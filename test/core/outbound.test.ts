import { test } from "node:test";
import assert from "node:assert/strict";
import { addressPolicy, isPrivateAddress, policyFetch, publicGet } from "#core/outbound.ts";
import { localServer } from "../helpers.ts";

test("private and public addresses", () => {
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(isPrivateAddress(a), true, a);
  // https://github.com/k18k/matrix-nodejs-homeserver/issues/21: IPv4 hosts counted as private.
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(a), false, a);
});

test("the default policy refuses private addresses, by literal and by name", async () => {
  const srv = await localServer((_req, res) => res.end("internal"));
  const get = policyFetch(addressPolicy(undefined));
  try {
    await assert.rejects(get(`${srv.url}/`), { errcode: "M_FORBIDDEN" });
    await assert.rejects(get(`http://localhost:${srv.port}/`), { errcode: "M_FORBIDDEN" });
    await assert.rejects(get(`http://2130706433:${srv.port}/`), { errcode: "M_FORBIDDEN" });
    await assert.rejects(get("file:///etc/passwd"), { errcode: "M_FORBIDDEN" });
  } finally {
    await srv.close();
  }
});

test("allowPrivateAddresses ranges admit those addresses only, also after redirects", async () => {
  const srv = await localServer((req, res) => {
    if (req.url === "/away") {
      res.writeHead(302, { location: `http://127.0.0.2:${srv.port}/` });
      return res.end();
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => res.end(`posted ${body}`));
    }
    res.end("internal");
  });
  const get = policyFetch(addressPolicy(["127.0.0.1/32"]));
  try {
    assert.equal(await (await get(`${srv.url}/`)).text(), "internal");
    assert.equal(await (await get(`${srv.url}/`, { method: "POST", body: "x" })).text(), "posted x");
    // policyFetch itself never follows a redirect...
    assert.equal((await get(`${srv.url}/away`)).status, 302);
    // ...and publicGet checks the target of each one.
    await assert.rejects(publicGet(get, `${srv.url}/away`, { maxBytes: 1000 }), { errcode: "M_FORBIDDEN" });
    assert.throws(() => addressPolicy(["localhost"]), /not an IP address/);
  } finally {
    await srv.close();
  }
});

test("publicGet caps the body", async () => {
  const srv = await localServer((_req, res) => res.end(Buffer.alloc(5000, 97)));
  const get = policyFetch(addressPolicy(true));
  try {
    await assert.rejects(publicGet(get, `${srv.url}/`, { maxBytes: 1000 }), { errcode: "M_TOO_LARGE" });
    assert.equal((await publicGet(get, `${srv.url}/`, { maxBytes: 1000, truncate: true })).body.length, 1000);
  } finally {
    await srv.close();
  }
});

test("a custom fetch gets the host checked first", async () => {
  let called = false;
  const custom = (async () => {
    called = true;
    return new Response("x");
  }) as typeof fetch;
  await assert.rejects(policyFetch(addressPolicy(undefined), custom)("http://localhost/"), { errcode: "M_FORBIDDEN" });
  assert.equal(called, false);
});
