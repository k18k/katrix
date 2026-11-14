import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testServer } from "../helpers.ts";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("federation is off by default", async () => {
  const t = await testServer();
  try {
    const res = await t.call("GET", "/_matrix/federation/v1/version");
    assert.equal(res.json.errcode, "M_UNRECOGNIZED");
  } finally {
    await t.close();
  }
});

// https://github.com/k18k/katrix/issues/16
test("the federation version is the package's", async () => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    const res = await t.call("GET", "/_matrix/federation/v1/version");
    assert.deepEqual(res.json, { server: { name: pkg.name, version: pkg.version } });
  } finally {
    await t.close();
  }
});

// https://github.com/k18k/katrix/issues/22
test("federation requests do not reach private addresses unless allowed", async () => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    await assert.rejects(t.hs.federation.client.requestRaw("127.0.0.1:1", "GET", "/x"), { errcode: "M_FORBIDDEN" });
    await assert.rejects(t.hs.federation.client.requestRaw("localhost:1", "GET", "/x"), /private address/);
  } finally {
    await t.close();
  }
});

test("get_missing_events and event_auth answer only with events of the room asked about (#96, #97)", async () => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    // Requests signed as the server itself: its key is known, and it is in every room with a local member.
    const fed = async (method: string, path: string, body?: unknown) => {
      const authorization = t.hs.federation.client.authHeader("localhost", method, path, body);
      const res = await t.handler(
        new Request(`http://localhost${path}`, {
          method,
          headers: { authorization, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      return { status: res.status, json: (await res.json()) as any };
    };
    const alice = await t.user("alice");
    const bob = await t.user("bob");
    const a = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: { preset: "public_chat" } })).json.room_id;
    const b = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: bob, body: { preset: "private_chat" } })).json.room_id;
    const secret = (
      await t.call("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(b)}/send/m.room.message/s1`, {
        token: bob,
        body: { msgtype: "m.text", body: "secret" },
      })
    ).json.event_id;

    const missing = await fed("POST", `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(a)}`, {
      earliest_events: [],
      latest_events: [secret],
      limit: 10,
    });
    assert.equal(missing.status, 200, JSON.stringify(missing.json));
    assert.deepEqual(
      missing.json.events.filter((e: any) => e.room_id === b),
      [],
    );
    const auth = await fed("GET", `/_matrix/federation/v1/event_auth/${encodeURIComponent(a)}/${encodeURIComponent(secret)}`);
    assert.equal(auth.status, 404, JSON.stringify(auth.json));
  } finally {
    await t.close();
  }
});

test("an expired verify key counts only for times before its expiry (#98)", async () => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    const key = t.hs.signingKey.publicKeyBase64;
    await t.hs.db.upsert("remote_server_keys", { server_name: "remote.test", key_id: "ed25519:old", key, valid_until_ts: 1000 });
    // Refreshing fails (remote.test does not exist), so only the stored key is known.
    assert.ok(await t.hs.federation.keyring.getKey("remote.test", "ed25519:old", 500));
    assert.equal(await t.hs.federation.keyring.getKey("remote.test", "ed25519:old", 2000), null);
  } finally {
    await t.close();
  }
});

test("timestamp_to_event over federation goes by timestamp, not arrival order (#105)", async () => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    const alice = await t.user("alice");
    const room = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: {} })).json.room_id;
    const send = async (txn: string) =>
      (
        await t.call("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`, {
          token: alice,
          body: { msgtype: "m.text", body: txn },
        })
      ).json.event_id;
    // Stored in this order, with timestamps out of order (as federated events can be).
    const late = await send("late");
    const early = await send("early");
    for (const [id, ts] of [
      [late, 3_000_000_000_300],
      [early, 3_000_000_000_200],
    ] as const) {
      const row = await t.hs.db.findOne("events", [{ field: "event_id", value: id }]);
      await t.hs.db.update("events", [{ field: "event_id", value: id }], { json: { ...row!.json, origin_server_ts: ts } });
    }
    const path = `/_matrix/federation/v1/timestamp_to_event/${encodeURIComponent(room)}?ts=3000000000150&dir=f`;
    const res = await t.handler(
      new Request(`http://localhost${path}`, { headers: { authorization: t.hs.federation.client.authHeader("localhost", "GET", path) } }),
    );
    assert.equal(((await res.json()) as any).event_id, early);
  } finally {
    await t.close();
  }
});

// https://github.com/k18k/katrix/issues/135
test("claimed keys are taken only for the users and devices asked of that server", async (ctx) => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    const alice = await t.user("alice");
    const whoami = await t.call("GET", "/_matrix/client/v3/account/whoami", { token: alice });
    const device: string = whoami.json.device_id;
    const own = { key: "own-key", signatures: { "@alice:localhost": { [`ed25519:${device}`]: "sig" } } };
    const uploaded = await t.call("POST", "/_matrix/client/v3/keys/upload", {
      token: alice,
      body: { one_time_keys: { "signed_curve25519:AAAA": own } },
    });
    assert.equal(uploaded.status, 200, uploaded.text);

    const signed = { key: "bob-key", signatures: { "@bob:remote.example": { "ed25519:BOBDEV": "sig" } } };
    const asked: unknown[] = [];
    ctx.mock.method(t.hs.federation.client, "request", async (...args: unknown[]) => {
      asked.push(args[0]);
      return {
        one_time_keys: {
          "@bob:remote.example": {
            BOBDEV: { "signed_curve25519:B1": signed, "curve25519:B2": "unsigned-key", "signed_curve25519:B3": { key: 1 } },
            OTHERDEV: { "signed_curve25519:B4": signed },
          },
          "@alice:localhost": { [device]: { "signed_curve25519:EVIL": { key: "evil", signatures: {} } } },
          "@carol:remote.example": { CAROLDEV: { "signed_curve25519:C1": signed } },
        },
      };
    });
    const res = await t.call("POST", "/_matrix/client/v3/keys/claim", {
      token: alice,
      body: {
        one_time_keys: { "@alice:localhost": { [device]: "signed_curve25519" }, "@bob:remote.example": { BOBDEV: "signed_curve25519" } },
      },
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(asked, ["remote.example"]);
    assert.deepEqual(res.json.one_time_keys, {
      "@alice:localhost": { [device]: { "signed_curve25519:AAAA": own } },
      "@bob:remote.example": { BOBDEV: { "signed_curve25519:B1": signed, "curve25519:B2": "unsigned-key" } },
    });
  } finally {
    await t.close();
  }
});

// https://github.com/k18k/katrix/issues/128
test("queried keys of remote users are passed on only when they are well-formed", async (ctx) => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    const alice = await t.user("alice");
    const bob = "@bob:remote.example";
    const signatures = { [bob]: { "ed25519:BOBDEV": "sig" } };
    const device = {
      user_id: bob,
      device_id: "BOBDEV",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      keys: { "ed25519:BOBDEV": "e" },
      signatures,
    };
    const master = { user_id: bob, usage: ["master"], keys: { "ed25519:m": "m" } };
    ctx.mock.method(t.hs.federation.client, "request", async () => ({
      device_keys: {
        [bob]: { BOBDEV: device, BROKEN: { ...device, device_id: "BROKEN", keys: "none" } },
        "@carol:remote.example": { CAROLDEV: { ...device, user_id: "@carol:remote.example" } },
      },
      master_keys: { [bob]: master, "@alice:localhost": { ...master, user_id: "@alice:localhost" } },
      self_signing_keys: { [bob]: { user_id: bob, usage: "self_signing", keys: {} } },
    }));
    const res = await t.call("POST", "/_matrix/client/v3/keys/query", { token: alice, body: { device_keys: { [bob]: [] } } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.device_keys, { [bob]: { BOBDEV: device } });
    assert.deepEqual(res.json.master_keys, { [bob]: master });
    assert.deepEqual(res.json.self_signing_keys, {});
  } finally {
    await t.close();
  }
});

// https://github.com/k18k/katrix/issues/128
test("a remote alias resolves only when the remote server answers with a room ID", async (ctx) => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    const answers: unknown[] = [
      { room_id: "!room:remote.example", servers: ["remote.example"] },
      { room_id: "!other:remote.example", servers: "remote.example" },
      { room_id: 5, servers: [] },
      { room_id: "not a room", servers: [] },
    ];
    ctx.mock.method(t.hs.federation.client, "request", async () => answers.shift());
    const resolve = () => t.call("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent("#lobby:remote.example")}`);
    assert.deepEqual((await resolve()).json, { room_id: "!room:remote.example", servers: ["remote.example"] });
    assert.deepEqual(
      (await resolve()).json,
      { room_id: "!other:remote.example", servers: ["remote.example"] },
      "a malformed list falls back",
    );
    assert.equal((await resolve()).status, 404);
    assert.equal((await resolve()).status, 404);
  } finally {
    await t.close();
  }
});
