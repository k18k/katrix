import { UNSTABLE } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

test("a delayed event whose send fails once is sent on the retry, exactly once (#100)", async () => {
  const t = await testServer();
  try {
    const alice = await t.user("alice");
    const room = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: {} })).json.room_id;
    const r = encodeURIComponent(room);
    const scheduled = await t.call("PUT", `/_matrix/client/v3/rooms/${r}/send/m.room.message/d1?${UNSTABLE.ORG.MATRIX.MSC4140.DELAY}=1`, {
      token: alice,
      body: { msgtype: "m.text", body: "later" },
    });
    assert.equal(scheduled.status, 200, scheduled.text);
    const delayed = t.hs.delayedEvents as any;
    const due = () => t.hs.db.update("delayed_events", [{ field: "delay_id", value: scheduled.json.delay_id }], { send_at: 0 });

    // The first send fails as a database outage would.
    const send = t.hs.rooms.sendEvent.bind(t.hs.rooms);
    let failures = 1;
    t.hs.rooms.sendEvent = (async (...args: Parameters<typeof send>) => {
      if (failures-- > 0) throw new Error("connection refused");
      return send(...args);
    }) as typeof send;
    await due();
    await delayed.tick();
    assert.equal((await t.hs.db.findMany("delayed_events")).length, 1, "kept for a retry");

    await due();
    await delayed.tick();
    await delayed.tick();
    assert.equal((await t.hs.db.findMany("delayed_events")).length, 0);
    const messages = await t.call("GET", `/_matrix/client/v3/rooms/${r}/messages?dir=b&limit=20`, { token: alice });
    assert.deepEqual(messages.json.chunk.filter((e: any) => e.content?.body === "later").length, 1);
  } finally {
    await t.close();
  }
});
