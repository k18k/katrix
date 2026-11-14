import { M } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

// Room upgrades (POST /rooms/{roomId}/upgrade).

const C = "/_matrix/client/v3";
const ALICE = "@alice:localhost";
const BOB = "@bob:localhost";

async function server() {
  const t = await testServer({ rateLimits: false });
  const alice = await t.user("alice");
  const bob = await t.user("bob");
  const path = (roomId: string, rest: string) => `${C}/rooms/${encodeURIComponent(roomId)}${rest}`;
  const state = async (roomId: string, type: string) => (await t.call("GET", path(roomId, `/state/${type}/`), { token: alice })).json;

  async function oldRoom(version: string) {
    const res = await t.call("POST", `${C}/createRoom`, {
      token: alice,
      body: {
        room_version: version,
        name: "Old",
        topic: "Topic",
        room_alias_name: `old${version}`,
        visibility: "public",
        preset: "public_chat",
        invite: [BOB],
        power_level_content_override: { users: { [ALICE]: 100, [BOB]: 75 }, events_default: 10 },
      },
    });
    assert.equal(res.status, 200, res.text);
    const roomId: string = res.json.room_id;
    return roomId;
  }

  async function upgrade(roomId: string, body: Record<string, unknown>) {
    const res = await t.call("POST", path(roomId, "/upgrade"), { token: alice, body });
    assert.equal(res.status, 200, res.text);
    const replacement: string = res.json.replacement_room;
    return replacement;
  }

  return { ...t, alice, bob, state, oldRoom, upgrade };
}

test("an upgrade copies the room's state, moves its aliases and closes the old room", async () => {
  const t = await server();
  try {
    const old = await t.oldRoom("10");
    const room = await t.upgrade(old, { new_version: "11" });

    const create = await t.state(room, M.ROOM.CREATE);
    assert.equal(create.room_version, "11");
    assert.equal(create.predecessor.room_id, old);
    assert.equal(typeof create.predecessor.event_id, "string");
    assert.equal((await t.state(room, M.ROOM.NAME)).name, "Old");
    assert.equal((await t.state(room, M.ROOM.TOPIC)).topic, "Topic");
    assert.equal((await t.state(room, M.ROOM.JOIN_RULES)).join_rule, "public");
    const pl = await t.state(room, M.ROOM.POWER_LEVELS);
    assert.deepEqual(pl.users, { [ALICE]: 100, [BOB]: 75 }, "the original levels, without the creator's boost");
    assert.equal(pl.events_default, 10);
    assert.equal((await t.state(room, M.ROOM.CANONICAL_ALIAS)).alias, "#old10:localhost");
    const resolved = await t.call("GET", `${C}/directory/room/${encodeURIComponent("#old10:localhost")}`);
    assert.equal(resolved.json.room_id, room);

    assert.equal((await t.state(old, M.ROOM.TOMBSTONE)).replacement_room, room);
    assert.deepEqual(await t.state(old, M.ROOM.CANONICAL_ALIAS), {});
    const closed = await t.state(old, M.ROOM.POWER_LEVELS);
    assert.equal(closed.events_default, 50);
    assert.equal(closed.invite, 50);
    assert.deepEqual(closed.users, { [ALICE]: 100, [BOB]: 75 });

    const denied = await t.call("POST", `${C}/rooms/${encodeURIComponent(room)}/upgrade`, { token: t.bob, body: { new_version: "11" } });
    assert.equal(denied.status, 403);
    const unknown = await t.call("POST", `${C}/rooms/${encodeURIComponent(room)}/upgrade`, { token: t.alice, body: { new_version: "99" } });
    assert.equal(unknown.json.errcode, "M_UNSUPPORTED_ROOM_VERSION");
  } finally {
    await t.close();
  }
});

test("an upgrade to room version 12 makes the upgrader and the additional creators the creators", async () => {
  const t = await server();
  try {
    const old = await t.oldRoom("11");
    const room = await t.upgrade(old, { new_version: "12", additional_creators: [BOB] });
    const create = await t.state(room, M.ROOM.CREATE);
    assert.deepEqual(create.predecessor, { room_id: old });
    assert.deepEqual(create.additional_creators, [BOB]);
    const pl = await t.state(room, M.ROOM.POWER_LEVELS);
    assert.deepEqual(pl.users ?? {}, {}, "creators are not listed in users");
  } finally {
    await t.close();
  }
});
