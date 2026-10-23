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

// https://github.com/k18k/matrix-nodejs-homeserver/issues/16
test("the federation version is the package's", async () => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    const res = await t.call("GET", "/_matrix/federation/v1/version");
    assert.deepEqual(res.json, { server: { name: pkg.name, version: pkg.version } });
  } finally {
    await t.close();
  }
});

// https://github.com/k18k/matrix-nodejs-homeserver/issues/22
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
