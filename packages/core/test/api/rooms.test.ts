import { test } from "node:test";
import assert from "node:assert/strict";
import { M } from "#core/m.ts";
import { testServer } from "../helpers.ts";

const state = (roomId: string, type: string, key = "") =>
  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/${encodeURIComponent(key)}`;

test("power levels decide who may change what", async () => {
  const t = await testServer();
  try {
    const alice = await t.user("alice");
    const bob = await t.user("bob");
    const room = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: { preset: "public_chat" } })).json.room_id;
    assert.equal((await t.call("POST", `/_matrix/client/v3/join/${encodeURIComponent(room)}`, { token: bob, body: {} })).status, 200);

    // The creator may change state; a member with the default level may not.
    assert.equal((await t.call("PUT", state(room, M.ROOM.NAME), { token: alice, body: { name: "A" } })).status, 200);
    assert.equal((await t.call("PUT", state(room, M.ROOM.NAME), { token: bob, body: { name: "B" } })).status, 403);
    const pl = (await t.call("GET", state(room, M.ROOM.POWER_LEVELS), { token: bob })).json;
    assert.equal(
      (
        await t.call("PUT", state(room, M.ROOM.POWER_LEVELS), {
          token: bob,
          body: { ...pl, users: { ...pl.users, "@bob:localhost": 100 } },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/kick`, {
          token: bob,
          body: { user_id: "@alice:localhost" },
        })
      ).status,
      403,
    );

    // Members may send messages.
    const sent = await t.call("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${M.ROOM.MESSAGE}/1`, {
      token: bob,
      body: { msgtype: M.TEXT, body: "hi" },
    });
    assert.equal(sent.status, 200);
  } finally {
    await t.close();
  }
});

test("a private room needs an invite", async () => {
  const t = await testServer();
  try {
    const alice = await t.user("alice");
    const bob = await t.user("bob");
    const room = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: { preset: "private_chat" } })).json.room_id;
    const join = () => t.call("POST", `/_matrix/client/v3/join/${encodeURIComponent(room)}`, { token: bob, body: {} });
    assert.equal((await join()).status, 403);
    assert.equal(
      (
        await t.call("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`, {
          token: alice,
          body: { user_id: "@bob:localhost" },
        })
      ).status,
      200,
    );
    assert.equal((await join()).status, 200);
  } finally {
    await t.close();
  }
});

test("a redacted message loses its content", async () => {
  const t = await testServer();
  try {
    const alice = await t.user("alice");
    const room = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: {} })).json.room_id;
    const r = encodeURIComponent(room);
    const eventId = (
      await t.call("PUT", `/_matrix/client/v3/rooms/${r}/send/${M.ROOM.MESSAGE}/1`, {
        token: alice,
        body: { msgtype: M.TEXT, body: "oops" },
      })
    ).json.event_id;
    assert.equal(
      (
        await t.call("PUT", `/_matrix/client/v3/rooms/${r}/redact/${encodeURIComponent(eventId)}/2`, {
          token: alice,
          body: { reason: "typo" },
        })
      ).status,
      200,
    );
    const ev = (await t.call("GET", `/_matrix/client/v3/rooms/${r}/event/${encodeURIComponent(eventId)}`, { token: alice })).json;
    assert.deepEqual(ev.content, {});
    assert.ok(ev.unsigned?.redacted_because);
  } finally {
    await t.close();
  }
});
