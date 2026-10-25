import { test } from "node:test";
import assert from "node:assert/strict";
import { MatrixEvent } from "../../src/models/event.ts";
import { Room } from "../../src/models/room.ts";
import type { ClientEvent } from "@katrix/shared";
import { parseV3 } from "../../src/sync/v3.ts";

const ME = "@me:x";
const member = (userId: string, membership: string, displayname?: string): ClientEvent => ({
  type: "m.room.member",
  state_key: userId,
  sender: userId,
  event_id: `$m-${userId}-${membership}`,
  content: { membership, ...(displayname ? { displayname } : {}) } as never,
});

function room(events: ClientEvent[], summary?: Room["summary"]) {
  const r = new Room("!r:x", ME, "join");
  for (const e of events) r.state.setRaw(e);
  if (summary) r.summary = summary;
  return r;
}

test("room names follow the spec's order: name, alias, heroes, empty", () => {
  assert.equal(
    room([
      { type: "m.room.name", state_key: "", content: { name: "Team" } },
      { type: "m.room.canonical_alias", state_key: "", content: { alias: "#t:x" } },
    ]).name(),
    "Team",
  );
  assert.equal(room([{ type: "m.room.canonical_alias", state_key: "", content: { alias: "#t:x" } }]).name(), "#t:x");
  assert.equal(room([member(ME, "join"), member("@a:x", "join", "Alice")]).name(), "Alice");
  assert.equal(room([member(ME, "join"), member("@a:x", "join", "Alice"), member("@b:x", "invite", "Bob")]).name(), "Alice and Bob");
  assert.equal(
    room([member(ME, "join"), member("@a:x", "join", "Alice")], { heroes: ["@a:x"], joinedMemberCount: 5, invitedMemberCount: 0 }).name(),
    "Alice and 3 others",
  );
  assert.equal(room([member(ME, "join"), member("@a:x", "leave", "Alice")]).name(), "Empty Room (was Alice)");
  assert.equal(room([member(ME, "join")]).name(), "Empty Room");
});

test("member names are disambiguated when shared or when they look like a user ID", () => {
  const r = room([
    member("@a:x", "join", "Sam"),
    member("@b:x", "join", "Sam"),
    member("@c:x", "join", "@a:x"),
    member("@d:x", "join"),
    member("@e:x", "leave", "Sam"),
  ]);
  const names = Object.fromEntries(r.state.members().map((m) => [m.userId, m.name]));
  assert.equal(names["@a:x"], "Sam (@a:x)");
  assert.equal(names["@b:x"], "Sam (@b:x)");
  assert.equal(names["@c:x"], "@a:x (@c:x)");
  assert.equal(names["@d:x"], "@d:x");
});

test("power levels: defaults without the event, users and events from it", () => {
  const create: ClientEvent = { type: "m.room.create", state_key: "", sender: "@creator:x", content: { room_version: "10" } };
  const r = room([create]);
  assert.equal(r.state.powerLevel("@creator:x"), 100);
  assert.equal(r.state.powerLevel("@other:x"), 0);
  r.state.setRaw({
    type: "m.room.power_levels",
    state_key: "",
    content: { users: { "@mod:x": 50 }, users_default: 10, events: { "m.room.name": 50 }, state_default: 60, events_default: 5 },
  });
  assert.equal(r.state.powerLevel("@mod:x"), 50);
  assert.equal(r.state.powerLevel("@other:x"), 10);
  assert.ok(r.state.maySend("@mod:x", "m.room.name", true));
  assert.ok(!r.state.maySend("@mod:x", "m.room.topic", true));
  assert.ok(r.state.maySend("@other:x", "m.room.message", false));
  const v12 = room([{ ...create, content: { room_version: "12" } }]);
  assert.equal(v12.state.powerLevel("@creator:x"), Infinity);
});

test("encryption targets include invited members unless history is for joined members only", () => {
  const r = room([member("@a:x", "join"), member("@b:x", "invite"), member("@c:x", "leave"), member("@d:x", "ban")]);
  assert.deepEqual(r.encryptionTargets().sort(), ["@a:x", "@b:x"]);
  r.state.setRaw({ type: "m.room.history_visibility", state_key: "", content: { history_visibility: "joined" } });
  assert.deepEqual(r.encryptionTargets(), ["@a:x"]);
});

test("typed events narrow their content; redaction keeps only the allowed keys", () => {
  const e = new MatrixEvent({
    type: "m.room.member",
    state_key: "@a:x",
    content: { membership: "join", displayname: "A", avatar_url: "mxc://x/y" } as never,
  });
  if (e.is("m.room.member")) assert.equal(e.content.membership, "join");
  else assert.fail();
  e.applyRedaction({ type: "m.room.redaction", event_id: "$r", content: {} });
  assert.deepEqual(e.content, { membership: "join" });
  assert.ok(e.isRedacted());
  const msg = new MatrixEvent({ type: "m.room.message", content: { msgtype: "m.text", body: "secret" } });
  msg.applyRedaction({ type: "m.room.redaction", event_id: "$r2", content: {} });
  assert.deepEqual(msg.content, {});
});

test("timeline: dedup by event ID, cap with dropped back token, gap reset", () => {
  const r = new Room("!r:x", ME, "join", { maxTimelineEvents: 3 });
  const ev = (i: number) => new MatrixEvent({ type: "m.room.message", event_id: `$${i}`, content: { msgtype: "m.text", body: `${i}` } });
  r.timeline.backToken = "t0";
  assert.equal(r.timeline.append([ev(1), ev(2), ev(1)]).length, 2);
  r.timeline.append([ev(3), ev(4)]);
  assert.deepEqual(
    r.timeline.events.map((e) => e.eventId),
    ["$2", "$3", "$4"],
  );
  assert.equal(r.timeline.backToken, undefined, "dropped events: the old token no longer fits");
  r.timeline.reset("t9");
  assert.equal(r.timeline.events.length, 0);
  r.timeline.prepend([ev(8), ev(7)], undefined);
  assert.deepEqual(
    r.timeline.events.map((e) => e.eventId),
    ["$7", "$8"],
  );
  assert.ok(r.timeline.atStart);
});

test("/sync v3 responses are parsed defensively", () => {
  const res = parseV3(
    {
      next_batch: "s2",
      rooms: {
        join: {
          "!a:x": {
            timeline: { events: [{ type: "m.room.message", content: {} }, "junk", null], limited: true, prev_batch: "p" },
            state: { events: [member("@a:x", "join")] },
            summary: { "m.heroes": ["@a:x"], "m.joined_member_count": 2 },
          },
        },
        invite: { "!b:x": { invite_state: { events: [{ type: "m.room.name", state_key: "", content: { name: "B" }, sender: "@b:x" }] } } },
        leave: { "!c:x": {} },
      },
      to_device: { events: [{ type: "m.room.encrypted", sender: "@b:x", content: {} }] },
      device_lists: { changed: ["@b:x"] },
      device_one_time_keys_count: { signed_curve25519: 3 },
    },
    false,
  );
  assert.equal(res.nextBatch, "s2");
  assert.equal(res.rooms.join["!a:x"].timeline.events.length, 1);
  assert.equal(res.rooms.join["!a:x"].timeline.limited, true);
  assert.equal(res.rooms.join["!a:x"].summary?.joinedMemberCount, 2);
  assert.equal(res.rooms.invite["!b:x"].strippedState.length, 1);
  assert.deepEqual(res.rooms.leave["!c:x"].timeline.events, []);
  assert.deepEqual(res.deviceLists, { changed: ["@b:x"], left: [] });
  assert.equal(res.unusedFallbackKeyTypes, undefined, "absent means: not reported");
  assert.throws(() => parseV3({}, false), /next_batch/);
});
