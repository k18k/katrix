import { M } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

// Presence in /sync: the users sharing a room with the syncing user, and only their changes.

const C = "/_matrix/client/v3";
type PresenceEvent = { type: string; sender: string; content: { presence: string; status_msg?: string } };

test("incremental syncs carry the presence changes of users sharing a room, and only theirs", async () => {
  const t = await testServer();
  try {
    const alice = await t.user("alice");
    const bob = await t.user("bob");
    const carol = await t.user("carol");
    const room = (await t.call("POST", `${C}/createRoom`, { token: alice, body: { preset: "public_chat" } })).json.room_id;
    assert.equal((await t.call("POST", `${C}/join/${encodeURIComponent(room)}`, { token: bob, body: {} })).status, 200);
    const sync = async (since?: string) => {
      const res = await t.call("GET", `${C}/sync?set_presence=offline${since ? `&since=${since}` : ""}`, { token: alice });
      assert.equal(res.status, 200, res.text);
      const events: PresenceEvent[] = res.json.presence?.events ?? [];
      return { next: res.json.next_batch as string, events };
    };
    const setPresence = (token: string, user: string, presence: string, status?: string) =>
      t.call("PUT", `${C}/presence/${encodeURIComponent(user)}/status`, { token, body: { presence, status_msg: status } });

    const first = await sync();
    assert.deepEqual(first.events.map((e) => e.sender).sort(), []);

    assert.equal((await setPresence(bob, "@bob:localhost", "online", "here")).status, 200);
    assert.equal((await setPresence(carol, "@carol:localhost", "online", "elsewhere")).status, 200);
    const changed = await sync(first.next);
    assert.deepEqual(
      changed.events.map((e) => [e.type, e.sender, e.content.presence, e.content.status_msg]),
      [[M.PRESENCE, "@bob:localhost", "online", "here"]],
    );

    const quiet = await sync(changed.next);
    assert.deepEqual(quiet.events, [], "nothing changed since");

    assert.equal((await setPresence(bob, "@bob:localhost", "unavailable")).status, 200);
    const away = await sync(quiet.next);
    assert.deepEqual(
      away.events.map((e) => [e.sender, e.content.presence]),
      [["@bob:localhost", "unavailable"]],
    );
  } finally {
    await t.close();
  }
});
