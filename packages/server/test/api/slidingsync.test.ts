import { M } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

// Simplified sliding sync (MSC4186): lists and subscriptions choose the rooms, the connection
// remembers what was sent, and the extensions carry what is not in a room.

const C = "/_matrix/client/v3";
const SYNC = "/_matrix/client/v5/sync";
const ALICE = "@alice:localhost";
const BOB = "@bob:localhost";
const room = (roomId: string) => `${C}/rooms/${encodeURIComponent(roomId)}`;

async function server() {
  const t = await testServer();
  const alice = await t.user("alice");
  const bob = await t.user("bob");

  async function createRoom(opts: { token: string; body: Record<string, unknown> }) {
    const res = await t.call("POST", `${C}/createRoom`, opts);
    assert.equal(res.status, 200, res.text);
    const roomId: string = res.json.room_id;
    return roomId;
  }

  async function send(opts: { token: string; roomId: string; text: string }) {
    const path = `${room(opts.roomId)}/send/${M.ROOM.MESSAGE}/${encodeURIComponent(opts.text)}`;
    const res = await t.call("PUT", path, { token: opts.token, body: { msgtype: "m.text", body: opts.text } });
    assert.equal(res.status, 200, res.text);
    const eventId: string = res.json.event_id;
    return eventId;
  }

  /** One sliding sync request of alice; `pos` continues a connection. */
  async function sync(opts: { body: Record<string, unknown>; pos?: string; token?: string }) {
    const res = await t.call("POST", opts.pos === undefined ? SYNC : `${SYNC}?pos=${opts.pos}`, {
      token: opts.token ?? alice,
      body: opts.body,
    });
    assert.equal(res.status, 200, res.text);
    return res.json;
  }

  return { ...t, alice, bob, createRoom, send, sync };
}

const ALL = { ranges: [[0, 9]], timeline_limit: 5, required_state: [[M.ROOM.NAME, ""]] };

test("a list sends each room once, then only what changed", async () => {
  const t = await server();
  try {
    const roomId = await t.createRoom({ token: t.alice, body: { name: "Plans", invite: [BOB] } });
    assert.equal((await t.call("POST", `${room(roomId)}/join`, { token: t.bob, body: {} })).status, 200);
    const first = await t.send({ token: t.alice, roomId, text: "one" });

    const initial = await t.sync({ body: { lists: { all: ALL } } });
    assert.equal(typeof initial.pos, "string");
    assert.deepEqual(initial.lists, { all: { count: 1 } });
    assert.deepEqual(Object.keys(initial.rooms), [roomId]);
    const sent = initial.rooms[roomId];
    assert.equal(sent.initial, true);
    assert.equal(sent.name, "Plans");
    assert.equal(sent.heroes, undefined, "a named room needs no heroes");
    assert.equal(sent.joined_count, 2);
    assert.equal(sent.invited_count, 0);
    assert.equal(sent.notification_count, 0);
    assert.equal(sent.highlight_count, 0);
    assert.equal(typeof sent.bump_stamp, "number");
    assert.equal(typeof sent.prev_batch, "string");
    assert.equal(sent.limited, true);
    assert.equal(sent.num_live, undefined);
    assert.equal(sent.timeline.length, 5);
    assert.equal(sent.timeline.at(-1).event_id, first);
    assert.ok(
      sent.timeline.every((e: { room_id?: string }) => e.room_id === undefined),
      "the room ID is the key, not in each event",
    );
    assert.deepEqual(
      sent.required_state.map((e: { type: string; content: unknown }) => [e.type, e.content]),
      [[M.ROOM.NAME, { name: "Plans" }]],
    );
    assert.deepEqual(initial.extensions, {});

    // Nothing new: the room is not sent again.
    const quiet = await t.sync({ body: { lists: { all: ALL } }, pos: initial.pos });
    assert.deepEqual(quiet.rooms, {});
    assert.deepEqual(quiet.lists, { all: { count: 1 } });

    const second = await t.send({ token: t.bob, roomId, text: "two" });
    const live = await t.sync({ body: { lists: { all: ALL } }, pos: quiet.pos });
    const update = live.rooms[roomId];
    assert.equal(update.initial, undefined);
    assert.deepEqual(
      update.timeline.map((e: { event_id: string }) => e.event_id),
      [second],
    );
    assert.equal(update.num_live, 1);
    assert.equal(update.limited, false);
    assert.deepEqual(update.required_state, []);
    assert.equal(update.notification_count, 1);
    assert.ok(update.bump_stamp > sent.bump_stamp);

    // A different config for a known room sends it in full again.
    const wider = await t.sync({
      body: { lists: { all: { ...ALL, required_state: [[M.ROOM.MEMBER, "$ME"]] } } },
      pos: live.pos,
    });
    assert.equal(wider.rooms[roomId].initial, true);
    assert.deepEqual(
      wider.rooms[roomId].required_state.map((e: { state_key: string }) => e.state_key),
      [ALICE],
    );
  } finally {
    await t.close();
  }
});

test("a position is valid once more for a retry, and unknown positions start over", async () => {
  const t = await server();
  try {
    const roomId = await t.createRoom({ token: t.alice, body: {} });
    const initial = await t.sync({ body: { conn_id: "main", lists: { all: ALL } } });
    await t.send({ token: t.alice, roomId, text: "one" });
    const next = await t.sync({ body: { conn_id: "main", lists: { all: ALL } }, pos: initial.pos });
    assert.equal(next.rooms[roomId].timeline.length, 1);

    // The response was lost: the same request again is answered, with its rooms in full.
    const retried = await t.sync({ body: { conn_id: "main", lists: { all: ALL } }, pos: initial.pos });
    assert.equal(retried.rooms[roomId].initial, true);
    assert.equal(retried.rooms[roomId].timeline.at(-1).event_id, next.rooms[roomId].timeline[0].event_id);

    for (const path of [`${SYNC}?pos=999999`, `${SYNC}?pos=abc`, `${SYNC}?pos=${initial.pos}`]) {
      // The last one: a position of another connection.
      const res = await t.call("POST", path, { token: t.alice, body: { conn_id: "other", lists: { all: ALL } } });
      assert.equal(res.status, 400, path);
      assert.equal(res.json.errcode, "M_UNKNOWN_POS");
    }

    // The unstable path is the same endpoint.
    const unstable = await t.call("POST", "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync", {
      token: t.alice,
      body: { lists: { all: ALL } },
    });
    assert.deepEqual(Object.keys(unstable.json.rooms), [roomId]);
  } finally {
    await t.close();
  }
});

test("list filters and ranges choose the rooms", async () => {
  const t = await server();
  try {
    const plain = await t.createRoom({ token: t.alice, body: { name: "Plain" } });
    const encrypted = await t.createRoom({
      token: t.alice,
      body: { initial_state: [{ type: M.ROOM.ENCRYPTION, state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }] },
    });
    const space = await t.createRoom({ token: t.alice, body: { creation_content: { type: M.SPACE._ } } });
    const child = await t.call("PUT", `${room(space)}/state/${M.SPACE.CHILD}/${encodeURIComponent(plain)}`, {
      token: t.alice,
      body: { via: ["localhost"] },
    });
    assert.equal(child.status, 200, child.text);
    const invited = await t.createRoom({ token: t.bob, body: { name: "From Bob", is_direct: true, invite: [ALICE] } });
    const direct = await t.createRoom({ token: t.alice, body: {} });
    const marked = await t.call("PUT", `${C}/user/${encodeURIComponent(ALICE)}/account_data/${M.DIRECT}`, {
      token: t.alice,
      body: { [BOB]: [direct] },
    });
    assert.equal(marked.status, 200, marked.text);

    const list = (filters: Record<string, unknown>) => ({ ranges: [[0, 9]], filters });
    const res = await t.sync({
      body: {
        lists: {
          dms: list({ is_dm: true }),
          invites: list({ is_invite: true }),
          encrypted: list({ is_encrypted: true }),
          spaces: list({ room_types: [M.SPACE._] }),
          rooms: list({ not_room_types: [M.SPACE._], is_invite: false, is_dm: false, is_encrypted: false }),
          untyped: list({ room_types: [null], is_invite: false }),
          children: list({ spaces: [space, "!unknown:localhost"] }),
          newest: { ranges: [[0, 0]] },
          none: { ranges: [] },
        },
      },
    });
    const count = (name: string) => res.lists[name].count;
    assert.equal(count("dms"), 2, "the room in m.direct and the direct invite");
    assert.equal(count("invites"), 1);
    assert.equal(count("encrypted"), 1);
    assert.equal(count("spaces"), 1);
    assert.equal(count("rooms"), 1);
    assert.equal(count("untyped"), 3);
    assert.equal(count("children"), 1);
    assert.equal(count("newest"), 5);
    assert.equal(count("none"), 5);
    assert.deepEqual(Object.keys(res.rooms).sort(), [plain, encrypted, space, invited, direct].sort());
    assert.equal(res.rooms[direct].is_dm, true);
    assert.equal(res.rooms[plain].is_dm, undefined);

    // An invite carries stripped state instead of a timeline.
    const invite = res.rooms[invited];
    assert.equal(invite.is_dm, true);
    assert.equal(invite.name, "From Bob");
    assert.deepEqual(invite.timeline, []);
    assert.equal(invite.joined_count, undefined);
    const own = invite.invite_state.find((e: { type: string; state_key: string }) => e.type === M.ROOM.MEMBER && e.state_key === ALICE);
    assert.deepEqual(Object.keys(own).sort(), ["content", "sender", "state_key", "type"]);
    assert.equal(own.sender, BOB);
    assert.equal(own.content.membership, "invite");

    // A range past the first room: only the newest room is sent.
    const top = await t.sync({ body: { lists: { newest: { ranges: [[0, 0]] } } } });
    assert.deepEqual(Object.keys(top.rooms), [direct]);
  } finally {
    await t.close();
  }
});

test("heroes name a room without a name, and $LAZY sends the members who spoke", async () => {
  const t = await server();
  try {
    const roomId = await t.createRoom({ token: t.alice, body: { invite: [BOB] } });
    await t.send({ token: t.alice, roomId, text: "hello" });
    const res = await t.sync({
      body: { lists: { all: { ranges: [[0, 9]], timeline_limit: 1, required_state: [[M.ROOM.MEMBER, "$LAZY"]] } } },
    });
    const sent = res.rooms[roomId];
    assert.deepEqual(sent.heroes, [{ user_id: BOB, displayname: "bob" }]);
    assert.equal(sent.joined_count, 1);
    assert.equal(sent.invited_count, 1);
    assert.deepEqual(
      sent.required_state.map((e: { state_key: string }) => e.state_key),
      [ALICE],
    );

    const everything = await t.sync({ body: { lists: { all: { ranges: [[0, 9]], required_state: [["*", "*"]] } } } });
    assert.deepEqual(everything.rooms[roomId].timeline, [], "no timeline_limit, no timeline");
    assert.equal(everything.rooms[roomId].prev_batch, undefined);
    assert.ok(everything.rooms[roomId].required_state.length >= 6);
  } finally {
    await t.close();
  }
});

test("room subscriptions add rooms outside the lists, and world-readable rooms the user is not in", async () => {
  const t = await server();
  try {
    const mine = await t.createRoom({ token: t.alice, body: { name: "Mine" } });
    const readable = await t.createRoom({
      token: t.bob,
      body: {
        name: "Public",
        initial_state: [{ type: M.ROOM.HISTORY_VISIBILITY, state_key: "", content: { history_visibility: "world_readable" } }],
      },
    });
    const closed = await t.createRoom({ token: t.bob, body: { name: "Private" } });
    const subscription = { timeline_limit: 1, required_state: [[M.ROOM.NAME, ""]] };
    const res = await t.sync({
      body: {
        room_subscriptions: { [mine]: subscription, [readable]: subscription, [closed]: subscription, "!unknown:localhost": subscription },
      },
    });
    assert.deepEqual(res.lists, {});
    assert.deepEqual(Object.keys(res.rooms).sort(), [mine, readable].sort());
    assert.equal(res.rooms[readable].name, "Public");
    assert.equal(res.rooms[readable].bump_stamp, 0);
  } finally {
    await t.close();
  }
});

test("extensions carry to-device messages, keys, account data, receipts and typing", async () => {
  const t = await server();
  try {
    const roomId = await t.createRoom({ token: t.alice, body: { invite: [BOB] } });
    assert.equal((await t.call("POST", `${room(roomId)}/join`, { token: t.bob, body: {} })).status, 200);
    const eventId = await t.send({ token: t.alice, roomId, text: "one" });
    const whoami = await t.call("GET", `${C}/account/whoami`, { token: t.alice });
    const toDevice = (text: string) =>
      t.call("PUT", `${C}/sendToDevice/m.test/${text}`, {
        token: t.bob,
        body: { messages: { [ALICE]: { [whoami.json.device_id]: { text } } } },
      });
    assert.equal((await toDevice("first")).status, 200);
    const tagged = await t.call("PUT", `${C}/user/${encodeURIComponent(ALICE)}/rooms/${encodeURIComponent(roomId)}/account_data/m.test`, {
      token: t.alice,
      body: { a: 1 },
    });
    assert.equal(tagged.status, 200, tagged.text);
    const read = await t.call("POST", `${room(roomId)}/receipt/${M.READ._}/${encodeURIComponent(eventId)}`, { token: t.bob, body: {} });
    assert.equal(read.status, 200, read.text);

    const extensions = {
      to_device: { enabled: true },
      e2ee: { enabled: true },
      account_data: { enabled: true },
      receipts: { enabled: true },
      typing: { enabled: true },
    };
    const body = { lists: { all: ALL }, extensions };
    const initial = await t.sync({ body });
    const ext = initial.extensions;
    assert.deepEqual(Object.keys(ext).sort(), Object.keys(extensions).sort());
    assert.deepEqual(ext.to_device.events, [{ sender: BOB, type: "m.test", content: { text: "first" } }]);
    assert.equal(typeof ext.to_device.next_batch, "string");
    assert.deepEqual(ext.e2ee, { device_one_time_keys_count: { signed_curve25519: 0 }, device_unused_fallback_key_types: [] });
    assert.ok(
      ext.account_data.global.some((e: { type: string }) => e.type === M.PUSH_RULES),
      "push rules are always there on an initial sync",
    );
    assert.deepEqual(ext.account_data.rooms, { [roomId]: [{ type: "m.test", content: { a: 1 } }] });
    assert.deepEqual(Object.keys(ext.receipts.rooms), [roomId]);
    assert.equal(ext.receipts.rooms[roomId].type, M.RECEIPT);
    assert.deepEqual(Object.keys(ext.receipts.rooms[roomId].content[eventId][M.READ._]), [BOB]);
    assert.deepEqual(ext.typing.rooms, {}, "nobody types");

    // Nothing new: the response says so for every extension, and the delivered message is gone.
    const quiet = await t.sync({ body, pos: initial.pos });
    assert.deepEqual(quiet.rooms, {});
    assert.deepEqual(quiet.extensions.to_device.events, []);
    assert.deepEqual(quiet.extensions.e2ee.device_lists, { changed: [], left: [] });
    assert.deepEqual(quiet.extensions.account_data, { global: [], rooms: {} });
    assert.deepEqual(quiet.extensions.receipts, { rooms: {} });
    assert.deepEqual(quiet.extensions.typing, { rooms: {} });

    // An extension alone ends the wait: a to-device message, then typing.
    assert.equal((await toDevice("second")).status, 200);
    const woken = await t.sync({ body, pos: `${quiet.pos}&timeout=5000` });
    assert.deepEqual(
      woken.extensions.to_device.events.map((e: { content: unknown }) => e.content),
      [{ text: "second" }],
    );
    const typing = await t.call("PUT", `${room(roomId)}/typing/${encodeURIComponent(BOB)}`, {
      token: t.bob,
      body: { typing: true, timeout: 30000 },
    });
    assert.equal(typing.status, 200, typing.text);
    const typed = await t.sync({ body, pos: `${woken.pos}&timeout=5000` });
    assert.deepEqual(typed.extensions.typing.rooms[roomId], { type: M.TYPING, content: { user_ids: [BOB] } });
    assert.deepEqual(typed.extensions.to_device.events, []);

    // Extensions that are not enabled are not in the response.
    const none = await t.sync({ body: { lists: { all: ALL }, extensions: { to_device: { enabled: false } } } });
    assert.deepEqual(none.extensions, {});
  } finally {
    await t.close();
  }
});

test("malformed parts of a request are ignored, not refused", async () => {
  const t = await server();
  try {
    const roomId = await t.createRoom({ token: t.alice, body: { name: "Plans" } });
    const res = await t.sync({
      body: {
        conn_id: 7,
        lists: {
          empty: 5,
          loose: { ranges: "0-9", filters: "none", timeline_limit: "5", required_state: [M.ROOM.NAME] },
          mixed: { ranges: [[0, 9]], filters: { is_dm: "no", room_types: M.SPACE._ }, required_state: [[M.ROOM.NAME, ""]] },
        },
        room_subscriptions: { [roomId]: "all" },
        extensions: { to_device: { enabled: "yes" }, e2ee: true, typing: { enabled: true, limit: {} } },
      },
    });
    assert.deepEqual(res.lists, { empty: { count: 1 }, loose: { count: 1 }, mixed: { count: 1 } });
    assert.deepEqual(res.rooms[roomId].timeline, []);
    assert.equal(res.rooms[roomId].required_state.length, 1);
    assert.deepEqual(res.extensions, { typing: { rooms: {} } });

    for (const body of [{ lists: "all" }, { room_subscriptions: [roomId] }, { extensions: "all" }]) {
      const ignored = await t.sync({ body });
      assert.deepEqual([ignored.lists, ignored.rooms, ignored.extensions], [{}, {}, {}]);
    }
  } finally {
    await t.close();
  }
});
