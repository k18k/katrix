import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

// https://github.com/k18k/matrix-nodejs-homeserver/issues/24
test("admin routes refuse non-admins before looking at the body", async () => {
  const t = await testServer({ serverNotices: { localpart: "_server" } });
  try {
    const bob = await t.user("bob");
    const root = await t.user("root", { admin: true });
    for (const [path, body] of [
      ["/_synapse/admin/v1/send_server_notice", {}],
      ["/_synapse/admin/v1/reset_password/@root:localhost", {}],
      ["/_synapse/admin/v1/registration_tokens/new", { uses_allowed: "many" }],
    ] as const) {
      const res = await t.call("POST", path, { token: bob, body });
      assert.equal(res.status, 403, path);
      assert.equal(res.json.errcode, "M_FORBIDDEN", path);
    }
    assert.equal((await t.call("POST", "/_synapse/admin/v1/send_server_notice", { token: root, body: {} })).status, 400);
    const sent = await t.call("POST", "/_synapse/admin/v1/send_server_notice", {
      token: root,
      body: { user_id: "@bob:localhost", content: { msgtype: "m.text", body: "hi" } },
    });
    assert.equal(sent.status, 200);
    assert.match(sent.json.event_id, /^\$/);
  } finally {
    await t.close();
  }
});

test("POST /_synapse/admin/v1/join: a member who may invite brings the user in", async () => {
  const t = await testServer();
  try {
    const admin = await t.user("admin", { admin: true });
    const alice = await t.user("alice");
    await t.user("bob");
    const room = await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: { preset: "private_chat" } });
    const joined = await t.call("POST", `/_synapse/admin/v1/join/${encodeURIComponent(room.json.room_id)}`, {
      token: admin,
      body: { user_id: "@bob:localhost" },
    });
    assert.deepEqual(joined.json, { room_id: room.json.room_id });
    const members = await t.call("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room.json.room_id)}/joined_members`, {
      token: alice,
    });
    assert.ok(members.json.joined["@bob:localhost"]);
    // Not for non-admins.
    assert.equal(
      (
        await t.call("POST", `/_synapse/admin/v1/join/${encodeURIComponent(room.json.room_id)}`, {
          token: alice,
          body: { user_id: "@alice:localhost" },
        })
      ).status,
      403,
    );
  } finally {
    await t.close();
  }
});
