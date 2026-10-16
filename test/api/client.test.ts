import { test } from "node:test";
import assert from "node:assert/strict";
import { M } from "#core/m.ts";
import { testServer } from "../helpers.ts";

test("register, create a room, send a message and see it in /sync", async () => {
  const t = await testServer();
  try {
    const flows = await t.call("POST", "/_matrix/client/v3/register", { body: { username: "alice", password: "pw" } });
    assert.equal(flows.status, 401);
    const reg = await t.call("POST", "/_matrix/client/v3/register", {
      body: { username: "alice", password: "pw", auth: { type: M.LOGIN.DUMMY, session: flows.json.session } },
    });
    assert.equal(reg.status, 200);
    const token = reg.json.access_token;

    const room = await t.call("POST", "/_matrix/client/v3/createRoom", { token, body: { name: "Room", topic: "Topic" } });
    assert.equal(room.status, 200);
    const send = await t.call("PUT", `/_matrix/client/v3/rooms/${room.json.room_id}/send/${M.ROOM.MESSAGE}/t1`, {
      token,
      body: { msgtype: M.TEXT, body: "hello" },
    });
    assert.equal(send.status, 200);

    const sync = await t.call("GET", "/_matrix/client/v3/sync", { token });
    const joined = sync.json.rooms.join[room.json.room_id];
    const types = [...(joined.state?.events ?? []), ...joined.timeline.events].map((e: any) => e.type);
    for (const type of [M.ROOM.CREATE, M.ROOM.MEMBER, M.ROOM.POWER_LEVELS, M.ROOM.NAME, M.ROOM.TOPIC, M.ROOM.MESSAGE])
      assert.ok(types.includes(type), type);
  } finally {
    await t.close();
  }
});

test("requests without a token are refused before the body is read", async () => {
  const t = await testServer();
  try {
    const res = await t.call("POST", "/_matrix/client/v3/createRoom", { body: { preset: 42 } });
    assert.equal(res.status, 401);
    assert.equal(res.json.errcode, "M_MISSING_TOKEN");
  } finally {
    await t.close();
  }
});

test("capabilities and login flows use the spec identifiers", async () => {
  const t = await testServer();
  try {
    const token = await t.user("bob");
    const caps = await t.call("GET", "/_matrix/client/v3/capabilities", { token });
    assert.ok(M.CHANGE_PASSWORD in caps.json.capabilities);
    assert.ok(M.ROOM_VERSIONS in caps.json.capabilities);
    const login = await t.call("GET", "/_matrix/client/v3/login");
    assert.deepEqual(
      login.json.flows.map((f: any) => f.type),
      [M.LOGIN.PASSWORD, M.LOGIN.TOKEN],
    );
  } finally {
    await t.close();
  }
});
