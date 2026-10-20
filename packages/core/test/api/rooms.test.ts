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

test("a former member cannot read later member lists with /members?at= (#78)", async () => {
  const t = await testServer();
  try {
    const alice = await t.user("alice");
    const bob = await t.user("bob");
    const carol = await t.user("carol");
    const room = (
      await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: { preset: "private_chat", invite: ["@bob:localhost"] } })
    ).json.room_id;
    const r = encodeURIComponent(room);
    await t.call("POST", `/_matrix/client/v3/rooms/${r}/join`, { token: bob, body: {} });
    const whileJoined = (await t.call("GET", "/_matrix/client/v3/sync?timeout=0", { token: bob })).json.next_batch;
    await t.call("POST", `/_matrix/client/v3/rooms/${r}/leave`, { token: bob, body: {} });
    await t.call("POST", `/_matrix/client/v3/rooms/${r}/invite`, { token: alice, body: { user_id: "@carol:localhost" } });
    await t.call("POST", `/_matrix/client/v3/rooms/${r}/join`, { token: carol, body: {} });
    const now = (await t.call("GET", "/_matrix/client/v3/sync?timeout=0", { token: alice })).json.next_batch;
    const members = (token: string, at?: string) =>
      t.call("GET", `/_matrix/client/v3/rooms/${r}/members${at ? `?at=${encodeURIComponent(at)}` : ""}`, { token });
    const ids = (res: { json: any }) => res.json.chunk.map((e: any) => e.state_key).sort();

    // After leaving, bob sees the room as it was when he left, with or without `at`.
    assert.deepEqual(ids(await members(bob)), ["@alice:localhost", "@bob:localhost"]);
    assert.deepEqual(ids(await members(bob, whileJoined)), ["@alice:localhost", "@bob:localhost"]);
    const later = await members(bob, now);
    assert.equal(later.status, 403, later.text);
    // Members still see the current list at any point.
    assert.deepEqual(ids(await members(alice, now)), ["@alice:localhost", "@bob:localhost", "@carol:localhost"]);
  } finally {
    await t.close();
  }
});

test("guests join only rooms that allow guest access, and leave when it is turned off (#87)", async () => {
  const t = await testServer({ userAuthAdapter: { registrationEnabled: true, guestAccessEnabled: true } });
  try {
    const alice = await t.user("alice");
    const guest = (await t.call("POST", "/_matrix/client/v3/register?kind=guest", { body: {} })).json;
    const closed = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: { preset: "public_chat" } })).json.room_id;
    const open = (
      await t.call("POST", "/_matrix/client/v3/createRoom", {
        token: alice,
        body: {
          preset: "public_chat",
          initial_state: [{ type: M.ROOM.GUEST_ACCESS, state_key: "", content: { guest_access: "can_join" } }],
        },
      })
    ).json.room_id;
    const join = (room: string) =>
      t.call("POST", `/_matrix/client/v3/join/${encodeURIComponent(room)}`, { token: guest.access_token, body: {} });
    assert.equal((await join(closed)).status, 403);
    assert.equal((await join(open)).status, 200);

    await t.call("PUT", state(open, M.ROOM.GUEST_ACCESS), { token: alice, body: { guest_access: "forbidden" } });
    let membership = "join";
    for (let i = 0; i < 50 && membership === "join"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      membership = (await t.call("GET", state(open, M.ROOM.MEMBER, guest.user_id), { token: alice })).json.membership;
    }
    assert.equal(membership, "leave");
  } finally {
    await t.close();
  }
});
