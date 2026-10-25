import { M } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
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

test("/versions lists every stable spec version the server implements (#89)", async () => {
  const t = await testServer();
  try {
    const versions = (await t.call("GET", "/_matrix/client/versions")).json.versions;
    assert.ok(versions.includes("v1.11") && versions.includes("v1.19"), String(versions));
  } finally {
    await t.close();
  }
});

test("user directory: members of public rooms are found, also right after they join (#107)", async () => {
  const t = await testServer();
  try {
    const alice = await t.user("alice");
    const carol = await t.user("carol");
    const dave = await t.user("dave");
    const room = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: { preset: "public_chat" } })).json.room_id;
    const search = async (term: string) =>
      (await t.call("POST", "/_matrix/client/v3/user_directory/search", { token: carol, body: { search_term: term } })).json.results.map(
        (r: any) => r.user_id,
      );
    assert.deepEqual(await search("alice"), ["@alice:localhost"]);
    assert.deepEqual(await search("dave"), []);
    await t.call("POST", `/_matrix/client/v3/join/${encodeURIComponent(room)}`, { token: dave, body: {} });
    assert.deepEqual(await search("dave"), ["@dave:localhost"]);
  } finally {
    await t.close();
  }
});
