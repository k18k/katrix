import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

// Server-side key backups (/room_keys): which uploaded session key is kept.

const C = "/_matrix/client/v3";
const ROOM = "!room:localhost";

test("a backup keeps the better key of a session and skips malformed ones", async () => {
  const t = await testServer();
  try {
    const alice = await t.user("alice");
    const created = await t.call("POST", `${C}/room_keys/version`, {
      token: alice,
      body: { algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: { public_key: "pk" } },
    });
    assert.equal(created.status, 200, created.text);
    const version: string = created.json.version;
    const key = (overrides: Record<string, unknown>) => ({
      first_message_index: 5,
      forwarded_count: 1,
      is_verified: false,
      session_data: { ciphertext: "a" },
      ...overrides,
    });
    const put = (session: string, body: unknown) =>
      t.call("PUT", `${C}/room_keys/keys/${encodeURIComponent(ROOM)}/${session}?version=${version}`, { token: alice, body });
    const get = async (session: string) =>
      (await t.call("GET", `${C}/room_keys/keys/${encodeURIComponent(ROOM)}/${session}?version=${version}`, { token: alice })).json;

    assert.equal((await put("s1", key({}))).json.count, 1);
    // Verified beats unverified; then a lower first index; then fewer forwards.
    await put("s1", key({ first_message_index: 9, is_verified: true, session_data: { ciphertext: "verified" } }));
    assert.equal((await get("s1")).session_data.ciphertext, "verified");
    await put("s1", key({ first_message_index: 1, session_data: { ciphertext: "unverified" } }));
    assert.equal((await get("s1")).session_data.ciphertext, "verified");
    await put("s1", key({ first_message_index: 2, is_verified: true, session_data: { ciphertext: "earlier" } }));
    await put("s1", key({ first_message_index: 2, is_verified: true, forwarded_count: 0, session_data: { ciphertext: "fewer" } }));
    assert.equal((await get("s1")).session_data.ciphertext, "fewer");

    assert.equal((await put("s2", "junk")).json.errcode, "M_BAD_JSON", "a body that is not an object is refused");
    for (const [session, body] of [
      ["s3", key({ first_message_index: "0" })],
      ["s4", key({ session_data: undefined })],
    ] as const) {
      const res = await put(session, body);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.count, 1, session);
    }
    const all = await t.call("PUT", `${C}/room_keys/keys?version=${version}`, {
      token: alice,
      body: { rooms: { [ROOM]: { sessions: { s5: key({}), s6: { first_message_index: 0 } } }, "!other:localhost": "junk" } },
    });
    assert.equal(all.json.count, 2);
    const listed = await t.call("GET", `${C}/room_keys/keys?version=${version}`, { token: alice });
    assert.deepEqual(Object.keys(listed.json.rooms[ROOM].sessions).sort(), ["s1", "s5"]);
  } finally {
    await t.close();
  }
});
