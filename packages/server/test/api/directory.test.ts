import { M } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

// The public room directory (GET and POST /publicRooms).

const C = "/_matrix/client/v3";

test("the public room directory lists, filters and pages public rooms", async () => {
  const t = await testServer({ rateLimits: false });
  try {
    const alice = await t.user("alice");
    const bob = await t.user("bob");
    const create = async (body: Record<string, unknown>) => {
      const res = await t.call("POST", `${C}/createRoom`, { token: alice, body: { visibility: "public", preset: "public_chat", ...body } });
      assert.equal(res.status, 200, res.text);
      const roomId: string = res.json.room_id;
      return roomId;
    };
    const lobby = await create({ name: "Lobby", topic: "Say hello", room_alias_name: "lobby" });
    const space = await create({ name: "Space", creation_content: { type: M.SPACE._ } });
    const quiet = await create({ name: "" });
    await create({ name: "Hidden", visibility: "private" });
    assert.equal((await t.call("POST", `${C}/join/${encodeURIComponent(lobby)}`, { token: bob, body: {} })).status, 200);

    const all = await t.call("GET", `${C}/publicRooms`);
    assert.equal(all.status, 200, all.text);
    assert.equal(all.json.total_room_count_estimate, 3);
    const [first] = all.json.chunk;
    assert.deepEqual(first, {
      room_id: lobby,
      num_joined_members: 2,
      world_readable: false,
      guest_can_join: false,
      join_rule: "public",
      name: "Lobby",
      topic: "Say hello",
      canonical_alias: "#lobby:localhost",
    });
    const unnamed = all.json.chunk.find((c: { room_id: string }) => c.room_id === quiet);
    assert.equal(unnamed.name, undefined, "an empty name is no name");

    const search = (body: Record<string, unknown>) => t.call("POST", `${C}/publicRooms`, { token: bob, body });
    assert.deepEqual(
      (await search({ filter: { generic_search_term: "HELLO" } })).json.chunk.map((c: { room_id: string }) => c.room_id),
      [lobby],
    );
    assert.deepEqual(
      (await search({ filter: { room_types: [M.SPACE._] } })).json.chunk.map((c: { room_id: string }) => c.room_id),
      [space],
    );
    assert.equal((await search({ filter: { room_types: [null] } })).json.chunk.length, 2);
    assert.equal((await search({ filter: { room_types: "all" } })).json.chunk.length, 3, "a malformed filter is ignored");

    const page = await search({ limit: 2 });
    assert.equal(page.json.chunk.length, 2);
    assert.equal(page.json.next_batch, "o2");
    assert.equal(page.json.prev_batch, undefined);
    const next = await search({ limit: 2, since: page.json.next_batch });
    assert.equal(next.json.chunk.length, 1);
    assert.equal(next.json.next_batch, undefined);
    assert.equal(next.json.prev_batch, "o0");
    assert.equal((await t.call("GET", `${C}/publicRooms?limit=1`)).json.next_batch, "o1");
  } finally {
    await t.close();
  }
});
