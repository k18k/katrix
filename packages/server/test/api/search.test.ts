import { M } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

// Server-side search of room events (POST /search).

const C = "/_matrix/client/v3";

async function server() {
  const t = await testServer({ rateLimits: false });
  const alice = await t.user("alice");

  async function room(name: string) {
    const res = await t.call("POST", `${C}/createRoom`, { token: alice, body: { name } });
    assert.equal(res.status, 200, res.text);
    const roomId: string = res.json.room_id;
    return roomId;
  }

  async function send(roomId: string, text: string) {
    const path = `${C}/rooms/${encodeURIComponent(roomId)}/send/${M.ROOM.MESSAGE}/${encodeURIComponent(text)}`;
    const res = await t.call("PUT", path, { token: alice, body: { msgtype: "m.text", body: text } });
    assert.equal(res.status, 200, res.text);
    const eventId: string = res.json.event_id;
    return eventId;
  }

  const search = (roomEvents: Record<string, unknown>, query = "") =>
    t.call("POST", `${C}/search${query}`, { token: alice, body: { search_categories: { room_events: roomEvents } } });

  return { ...t, alice, room, send, search };
}

test("search finds events with every term, best match first, a page at a time", async () => {
  const t = await server();
  try {
    const plans = await t.room("Plans");
    const other = await t.room("Other");
    const once = await t.send(plans, "lunch at noon");
    const twice = await t.send(plans, "lunch lunch tomorrow");
    const elsewhere = await t.send(other, "lunch somewhere");
    await t.send(plans, "dinner at noon");

    const ranked = await t.search({ search_term: "Lunch" });
    assert.equal(ranked.status, 200, ranked.text);
    const out = ranked.json.search_categories.room_events;
    assert.equal(out.count, 3);
    assert.deepEqual(out.highlights, ["lunch"]);
    assert.equal(out.results[0].result.event_id, twice);
    assert.equal(out.results[0].rank, 2);
    assert.deepEqual(
      new Set(out.results.slice(1).map((r: { result: { event_id: string } }) => r.result.event_id)),
      new Set([once, elsewhere]),
    );
    assert.equal(out.next_batch, undefined);
    assert.equal(out.state, undefined);
    assert.equal(out.groups, undefined);

    const both = await t.search({ search_term: "lunch noon" });
    assert.deepEqual(
      both.json.search_categories.room_events.results.map((r: { result: { event_id: string } }) => r.result.event_id),
      [once],
    );

    const recent = await t.search({ search_term: "lunch", order_by: "recent", filter: { limit: 2 } });
    const first = recent.json.search_categories.room_events;
    assert.deepEqual(
      first.results.map((r: { result: { event_id: string } }) => r.result.event_id),
      [elsewhere, twice],
    );
    assert.equal(first.next_batch, "2");
    const rest = await t.search({ search_term: "lunch", order_by: "recent", filter: { limit: 2 } }, "?next_batch=2");
    assert.deepEqual(
      rest.json.search_categories.room_events.results.map((r: { result: { event_id: string } }) => r.result.event_id),
      [once],
    );

    const inRoom = await t.search({ search_term: "lunch", filter: { rooms: [other] } });
    assert.equal(inRoom.json.search_categories.room_events.count, 1);
    const notInRoom = await t.search({ search_term: "lunch", filter: { not_rooms: [other] } });
    assert.equal(notInRoom.json.search_categories.room_events.count, 2);
    const byName = await t.search({ search_term: "plans", keys: ["content.name"] });
    assert.equal(byName.json.search_categories.room_events.count, 0, "state events are not searched");
  } finally {
    await t.close();
  }
});

test("search adds context, profiles, state and groups when asked", async () => {
  const t = await server();
  try {
    const plans = await t.room("Plans");
    const before = await t.send(plans, "hello");
    const hit = await t.send(plans, "lunch today");
    const after = await t.send(plans, "bye");

    const res = await t.search({
      search_term: "lunch",
      event_context: { before_limit: 1, after_limit: 1, include_profile: true },
      include_state: true,
      groupings: { group_by: [{ key: "room_id" }] },
    });
    assert.equal(res.status, 200, res.text);
    const out = res.json.search_categories.room_events;
    const [result] = out.results;
    assert.equal(result.result.event_id, hit);
    assert.deepEqual(
      result.context.events_before.map((e: { event_id: string }) => e.event_id),
      [before],
    );
    assert.deepEqual(
      result.context.events_after.map((e: { event_id: string }) => e.event_id),
      [after],
    );
    assert.equal(typeof result.context.start, "string");
    assert.equal(typeof result.context.end, "string");
    assert.deepEqual(result.context.profile_info, { "@alice:localhost": { displayname: "alice" } });
    assert.ok(out.state[plans].some((e: { type: string }) => e.type === M.ROOM.NAME));
    assert.deepEqual(out.groups, { room_id: { [plans]: { results: [hit], order: 0, next_batch: null } } });

    const plain = await t.search({ search_term: "lunch", event_context: { include_profile: false } });
    assert.equal(plain.json.search_categories.room_events.results[0].context.profile_info, undefined);
  } finally {
    await t.close();
  }
});

test("a search with a malformed filter is refused", async () => {
  const t = await server();
  try {
    for (const filter of ["all", { rooms: "!a:localhost" }, { limit: -1 }, { contains_url: "yes" }]) {
      const res = await t.search({ search_term: "lunch", filter });
      assert.equal(res.status, 400, JSON.stringify(filter));
      assert.equal(res.json.errcode, "M_BAD_JSON");
    }
    assert.equal((await t.search({})).json.errcode, "M_BAD_JSON");
  } finally {
    await t.close();
  }
});
