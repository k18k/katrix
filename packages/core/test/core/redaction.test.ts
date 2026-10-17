import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "#core/events.ts";
import { M } from "#core/m.ts";

const base = {
  room_id: "!r:x",
  sender: "@a:x",
  origin: "x",
  origin_server_ts: 1,
  depth: 3,
  prev_events: [],
  auth_events: [],
  hashes: { sha256: "h" },
};

test("message content is removed, top-level keys kept per room version", () => {
  const ev = { ...base, type: M.ROOM.MESSAGE, content: { body: "secret" }, unsigned: { age: 1 } };
  const v10 = redact(ev, "10");
  assert.deepEqual(v10.content, {});
  assert.equal("unsigned" in v10, false);
  assert.equal(v10.origin, "x");
  // Room version 11 no longer keeps origin (or membership and prev_state) at the top level.
  assert.equal("origin" in redact(ev, "11"), false);
});

test("membership keeps join_authorised_via_users_server from v9 and signed third-party invites from v11", () => {
  const content = {
    membership: "join",
    displayname: "A",
    join_authorised_via_users_server: "@b:x",
    third_party_invite: { signed: { token: "t" }, display_name: "d" },
  };
  const ev = { ...base, type: M.ROOM.MEMBER, state_key: "@a:x", content };
  assert.deepEqual(redact(ev, "8").content, { membership: "join" });
  assert.deepEqual(redact(ev, "9").content, { membership: "join", join_authorised_via_users_server: "@b:x" });
  assert.deepEqual(redact(ev, "11").content, {
    membership: "join",
    join_authorised_via_users_server: "@b:x",
    third_party_invite: { signed: { token: "t" } },
  });
});

test("create keeps all of its content from v11, power levels keep invite from v11", () => {
  const create = { ...base, type: M.ROOM.CREATE, state_key: "", content: { creator: "@a:x", room_version: "11", "m.federate": true } };
  assert.deepEqual(redact(create, "10").content, { creator: "@a:x" });
  assert.deepEqual(redact(create, "11").content, create.content);
  const pl = {
    ...base,
    type: M.ROOM.POWER_LEVELS,
    state_key: "",
    content: { ban: 50, invite: 0, notifications: { room: 50 }, users: { "@a:x": 100 } },
  };
  assert.deepEqual(redact(pl, "10").content, { ban: 50, users: { "@a:x": 100 } });
  assert.deepEqual(redact(pl, "11").content, { ban: 50, invite: 0, users: { "@a:x": 100 } });
});

test("join rules keep allow from v8; aliases keep content only up to v5", () => {
  const jr = {
    ...base,
    type: M.ROOM.JOIN_RULES,
    state_key: "",
    content: { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: "!s:x" }] },
  };
  assert.deepEqual(redact(jr, "7").content, { join_rule: "restricted" });
  assert.deepEqual(redact(jr, "8").content, jr.content);
  const aliases = { ...base, type: M.ROOM.ALIASES, state_key: "x", content: { aliases: ["#a:x"] } };
  assert.deepEqual(redact(aliases, "5").content, { aliases: ["#a:x"] });
  assert.deepEqual(redact(aliases, "6").content, {});
});
