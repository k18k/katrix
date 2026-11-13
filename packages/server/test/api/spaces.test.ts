import { M } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

// The space hierarchy and room summaries, as a client sees them.

const C = "/_matrix/client";
const BOB = "@bob:localhost";

async function server() {
  // Many rooms are created at once; the limits are tested elsewhere.
  const t = await testServer({ rateLimits: false });
  const alice = await t.user("alice");
  const bob = await t.user("bob");

  async function createRoom(opts: { token: string; body: Record<string, unknown> }) {
    const res = await t.call("POST", `${C}/v3/createRoom`, opts);
    assert.equal(res.status, 200, res.text);
    const roomId: string = res.json.room_id;
    return roomId;
  }

  async function addChild(opts: { space: string; child: string; content: Record<string, unknown> }) {
    const path = `${C}/v3/rooms/${encodeURIComponent(opts.space)}/state/${M.SPACE.CHILD}/${encodeURIComponent(opts.child)}`;
    const res = await t.call("PUT", path, { token: alice, body: opts.content });
    assert.equal(res.status, 200, res.text);
  }

  const hierarchy = (opts: { roomId: string; token: string; query?: string }) =>
    t.call("GET", `${C}/v1/rooms/${encodeURIComponent(opts.roomId)}/hierarchy${opts.query ?? ""}`, { token: opts.token });

  const summary = (opts: { roomId: string; token?: string }) =>
    t.call("GET", `${C}/v1/room_summary/${encodeURIComponent(opts.roomId)}`, { token: opts.token });

  return { ...t, alice, bob, createRoom, addChild, hierarchy, summary };
}

const VIA = { via: ["localhost"] };
const ids = (rooms: { room_id: string }[]) => rooms.map((r) => r.room_id);

test("the hierarchy walks a space depth first, with its children in the spec's order", async () => {
  const t = await server();
  try {
    const space = await t.createRoom({
      token: t.alice,
      body: { name: "Company", preset: "public_chat", creation_content: { type: M.SPACE._ } },
    });
    const team = await t.createRoom({
      token: t.alice,
      body: { name: "Team", preset: "public_chat", creation_content: { type: M.SPACE._ } },
    });
    const [late, first, second, hidden, unlisted, nested, plain] = await Promise.all(
      ["late", "first", "second", "hidden", "unlisted", "nested", "plain"].map((name) =>
        t.createRoom({ token: t.alice, body: { name, preset: name === "hidden" ? "private_chat" : "public_chat" } }),
      ),
    );
    await t.addChild({ space, child: late, content: VIA });
    await t.addChild({ space, child: second, content: { ...VIA, order: "b" } });
    await t.addChild({ space, child: first, content: { ...VIA, order: "a", suggested: true } });
    await t.addChild({ space, child: team, content: { ...VIA, order: "c", suggested: true } });
    await t.addChild({ space, child: hidden, content: { ...VIA, order: "d" } });
    await t.addChild({ space, child: unlisted, content: { via: [] } });
    await t.addChild({ space, child: unlisted, content: {} });
    await t.addChild({ space: team, child: nested, content: { ...VIA, suggested: true } });
    // Children of a room that is not a space are not followed.
    await t.addChild({ space: first, child: plain, content: VIA });

    const full = await t.hierarchy({ roomId: space, token: t.alice });
    assert.equal(full.status, 200, full.text);
    assert.deepEqual(ids(full.json.rooms), [space, first, second, team, nested, hidden, late]);
    assert.equal(full.json.next_batch, undefined);
    const root = full.json.rooms[0];
    assert.deepEqual(
      root.children_state.map((c: { state_key: string }) => c.state_key),
      [first, second, team, hidden, late],
    );
    assert.deepEqual(Object.keys(root.children_state[0]).sort(), ["content", "origin_server_ts", "sender", "state_key", "type"]);
    assert.deepEqual(root.children_state[0].content, { ...VIA, order: "a", suggested: true });
    assert.deepEqual(
      { name: root.name, room_type: root.room_type, join_rule: root.join_rule, members: root.num_joined_members },
      { name: "Company", room_type: M.SPACE._, join_rule: "public", members: 1 },
    );
    assert.equal(root.world_readable, false);
    assert.equal(root.guest_can_join, false);
    assert.equal(root.topic, undefined);
    assert.deepEqual(full.json.rooms[1].children_state, [], "an ordinary room has no children");

    // Someone else does not see the private room, only that it is a child.
    const other = await t.hierarchy({ roomId: space, token: t.bob });
    assert.deepEqual(ids(other.json.rooms), [space, first, second, team, nested, late]);
    assert.equal(other.json.rooms[0].children_state.length, 5);

    const suggested = await t.hierarchy({ roomId: space, token: t.alice, query: "?suggested_only=true" });
    assert.deepEqual(ids(suggested.json.rooms), [space, first, team, nested]);
    const shallow = await t.hierarchy({ roomId: space, token: t.alice, query: "?max_depth=1" });
    assert.deepEqual(ids(shallow.json.rooms), [space, first, second, team, hidden, late]);

    // Pages follow the same order, and a token is bound to its query.
    const page = await t.hierarchy({ roomId: space, token: t.alice, query: "?limit=3" });
    assert.deepEqual(ids(page.json.rooms), [space, first, second]);
    const rest = await t.hierarchy({ roomId: space, token: t.alice, query: `?limit=3&from=${encodeURIComponent(page.json.next_batch)}` });
    assert.deepEqual(ids(rest.json.rooms), [team, nested, hidden]);
    const moved = await t.hierarchy({
      roomId: space,
      token: t.alice,
      query: `?limit=3&suggested_only=true&from=${encodeURIComponent(page.json.next_batch)}`,
    });
    assert.equal(moved.status, 400);
    assert.equal(moved.json.errcode, "M_INVALID_PARAM");

    assert.equal((await t.hierarchy({ roomId: hidden, token: t.bob })).status, 403);
    assert.equal((await t.hierarchy({ roomId: "!unknown:localhost", token: t.alice })).status, 403);
  } finally {
    await t.close();
  }
});

test("a room summary describes the room to those who may see it", async () => {
  const t = await server();
  try {
    const open = await t.createRoom({
      token: t.alice,
      body: {
        name: "Open",
        topic: "Everything",
        preset: "public_chat",
        room_alias_name: "open",
        initial_state: [
          { type: M.ROOM.ENCRYPTION, state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
          { type: M.ROOM.AVATAR, state_key: "", content: { url: "mxc://localhost/avatar" } },
          { type: M.ROOM.HISTORY_VISIBILITY, state_key: "", content: { history_visibility: "world_readable" } },
          { type: M.ROOM.GUEST_ACCESS, state_key: "", content: { guest_access: "can_join" } },
        ],
      },
    });
    const mine = await t.summary({ roomId: open, token: t.alice });
    assert.equal(mine.status, 200, mine.text);
    assert.equal(typeof mine.json.room_version, "string");
    assert.deepEqual(
      { ...mine.json, room_version: undefined },
      {
        room_id: open,
        num_joined_members: 1,
        world_readable: true,
        guest_can_join: true,
        join_rule: "public",
        name: "Open",
        topic: "Everything",
        canonical_alias: "#open:localhost",
        avatar_url: "mxc://localhost/avatar",
        room_version: undefined,
        encryption: "m.megolm.v1.aes-sha2",
        membership: "join",
      },
    );
    assert.equal((await t.summary({ roomId: open, token: t.bob })).json.membership, "leave");
    const anonymous = await t.summary({ roomId: "#open:localhost" });
    assert.equal(anonymous.json.room_id, open);
    assert.equal(anonymous.json.membership, undefined);

    // A restricted room: its summary names the rooms whose members may join, and they may see it.
    const restricted = await t.createRoom({
      token: t.alice,
      body: {
        room_version: "10",
        initial_state: [
          {
            type: M.ROOM.JOIN_RULES,
            state_key: "",
            content: { join_rule: "restricted", allow: [{ type: M.ROOM_MEMBERSHIP, room_id: open }, { type: "other" }, "junk"] },
          },
        ],
      },
    });
    assert.equal((await t.summary({ roomId: restricted, token: t.bob })).status, 404);
    assert.equal((await t.summary({ roomId: restricted })).status, 404);
    assert.equal((await t.call("POST", `${C}/v3/join/${encodeURIComponent(open)}`, { token: t.bob, body: {} })).status, 200);
    const allowed = await t.summary({ roomId: restricted, token: t.bob });
    assert.equal(allowed.status, 200, allowed.text);
    assert.deepEqual(allowed.json.allowed_room_ids, [open]);
    assert.equal(allowed.json.join_rule, "restricted");
    assert.equal(allowed.json.name, undefined);
    assert.equal(allowed.json.encryption, undefined);

    const invited = await t.createRoom({ token: t.alice, body: { invite: [BOB] } });
    assert.equal((await t.summary({ roomId: invited, token: t.bob })).json.membership, "invite");
    assert.equal((await t.summary({ roomId: "!unknown:localhost", token: t.alice })).status, 404);
  } finally {
    await t.close();
  }
});
