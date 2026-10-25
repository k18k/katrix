import { M } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { memoryAdapter, memoryMedia, sqliteAdapter } from "#index.ts";
import { testServer } from "./helpers.ts";

// Smoke tests: does a homeserver work at all? One quick check per area a client uses on its first
// day (accounts, rooms and messages, /sync waking up, E2EE keys and to-device messages, media,
// profiles, receipts), on the memory adapter and on SQLite. They take a second or two; the
// thorough check is Complement in CI.

const BACKENDS = {
  memory: () => ({ databaseAdapter: memoryAdapter(), cleanup: () => {} }),
  sqlite: () => {
    const dir = mkdtempSync(`${tmpdir()}/smoke-`);
    const db = new DatabaseSync(`${dir}/homeserver.db`);
    return {
      databaseAdapter: sqliteAdapter(db),
      cleanup: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
};

for (const [backend, make] of Object.entries(BACKENDS)) {
  test(`smoke (${backend}): accounts, rooms, sync, E2EE, media, profiles`, async (t) => {
    const { databaseAdapter, cleanup } = make();
    const s = await testServer({ databaseAdapter, mediaAdapter: memoryMedia() });
    try {
      const alice = await s.user("alice");
      const bob = await s.user("bob");
      const get = (path: string, token: string) => s.call("GET", path, { token });
      const send = (method: string, path: string, token: string, body: unknown = {}) => s.call(method, path, { token, body });

      await t.test("accounts: whoami, refresh, logout", async () => {
        assert.equal((await get("/_matrix/client/v3/account/whoami", alice)).json.user_id, "@alice:localhost");
        const login = await s.call("POST", "/_matrix/client/v3/login", {
          body: { type: M.LOGIN.PASSWORD, identifier: { type: M.ID.USER, user: "alice" }, password: "password", refresh_token: true },
        });
        assert.ok(login.json.refresh_token);
        const refreshed = await s.call("POST", "/_matrix/client/v3/refresh", { body: { refresh_token: login.json.refresh_token } });
        assert.equal(refreshed.status, 200);
        assert.equal((await send("POST", "/_matrix/client/v3/logout", refreshed.json.access_token)).status, 200);
        assert.equal((await get("/_matrix/client/v3/account/whoami", refreshed.json.access_token)).status, 401);
      });

      const roomId: string = (
        await send("POST", "/_matrix/client/v3/createRoom", alice, { preset: "private_chat", invite: ["@bob:localhost"] })
      ).json.room_id;

      await t.test("rooms: invite, join, message, /messages", async () => {
        assert.ok(roomId);
        assert.equal((await send("POST", `/_matrix/client/v3/join/${roomId}`, bob)).status, 200);
        const sent = await send("PUT", `/_matrix/client/v3/rooms/${roomId}/send/m.room.message/m1`, alice, {
          msgtype: M.TEXT,
          body: "hello bob",
        });
        assert.ok(sent.json.event_id);
        const messages = await get(`/_matrix/client/v3/rooms/${roomId}/messages?dir=b&limit=5`, bob);
        assert.ok(messages.json.chunk.some((e: { content: { body?: string } }) => e.content.body === "hello bob"));
        const members = await get(`/_matrix/client/v3/rooms/${roomId}/joined_members`, bob);
        assert.deepEqual(Object.keys(members.json.joined).sort(), ["@alice:localhost", "@bob:localhost"]);
      });

      await t.test("sync: a waiting /sync wakes up for a new message", async () => {
        const first = await get("/_matrix/client/v3/sync", bob);
        const waiting = get(`/_matrix/client/v3/sync?since=${first.json.next_batch}&timeout=10000`, bob);
        await new Promise((r) => setTimeout(r, 50));
        const started = Date.now();
        await send("PUT", `/_matrix/client/v3/rooms/${roomId}/send/m.room.message/m2`, alice, { msgtype: M.TEXT, body: "are you there?" });
        const woke = await waiting;
        assert.ok(Date.now() - started < 5000, "the long poll returned with the message, not at its timeout");
        const events = woke.json.rooms.join[roomId].timeline.events;
        assert.ok(events.some((e: { content: { body?: string } }) => e.content.body === "are you there?"));
        // The unread count reaches the receiver; a receipt clears it.
        assert.ok(woke.json.rooms.join[roomId].unread_notifications.notification_count >= 1);
        const last = events.at(-1).event_id;
        assert.equal(
          (await send("POST", `/_matrix/client/v3/rooms/${roomId}/receipt/m.read/${encodeURIComponent(last)}`, bob)).status,
          200,
        );
      });

      await t.test("E2EE: device keys, one-time keys and a to-device message", async () => {
        const bobDevice = (await get("/_matrix/client/v3/account/whoami", bob)).json.device_id;
        const upload = await send("POST", "/_matrix/client/v3/keys/upload", bob, {
          device_keys: {
            user_id: "@bob:localhost",
            device_id: bobDevice,
            algorithms: ["m.olm.v1.curve25519-aes-sha2"],
            keys: { [`curve25519:${bobDevice}`]: "curve", [`ed25519:${bobDevice}`]: "ed" },
            signatures: {},
          },
          one_time_keys: { "signed_curve25519:AAAA": { key: "otk", signatures: {} } },
        });
        assert.equal(upload.json.one_time_key_counts.signed_curve25519, 1);
        const query = await send("POST", "/_matrix/client/v3/keys/query", alice, { device_keys: { "@bob:localhost": [] } });
        assert.ok(query.json.device_keys["@bob:localhost"][bobDevice]);
        const claim = await send("POST", "/_matrix/client/v3/keys/claim", alice, {
          one_time_keys: { "@bob:localhost": { [bobDevice]: "signed_curve25519" } },
        });
        assert.ok(claim.json.one_time_keys["@bob:localhost"][bobDevice]["signed_curve25519:AAAA"]);
        await send("PUT", "/_matrix/client/v3/sendToDevice/m.room.encrypted/td1", alice, {
          messages: { "@bob:localhost": { [bobDevice]: { algorithm: "m.olm.v1.curve25519-aes-sha2", ciphertext: {} } } },
        });
        const sync = await get("/_matrix/client/v3/sync", bob);
        assert.ok(sync.json.to_device.events.some((e: { type: string }) => e.type === "m.room.encrypted"));
      });

      await t.test("media: upload and download", async () => {
        const bytes = new TextEncoder().encode("a small file");
        const up = await s.handler(
          new Request("http://localhost/_matrix/media/v3/upload?filename=note.txt", {
            method: "POST",
            headers: { authorization: `Bearer ${alice}`, "content-type": "text/plain" },
            body: bytes,
          }),
        );
        const { content_uri } = (await up.json()) as { content_uri: string };
        assert.match(content_uri, /^mxc:\/\/localhost\//);
        const down = await s.handler(
          new Request(`http://localhost/_matrix/client/v1/media/download/${content_uri.slice("mxc://".length)}`, {
            headers: { authorization: `Bearer ${bob}` },
          }),
        );
        assert.equal(down.status, 200);
        assert.equal(await down.text(), "a small file");
      });

      await t.test("profiles and account data", async () => {
        await send("PUT", "/_matrix/client/v3/profile/@alice:localhost/displayname", alice, { displayname: "Alice A." });
        assert.equal((await get("/_matrix/client/v3/profile/@alice:localhost", bob)).json.displayname, "Alice A.");
        await send("PUT", "/_matrix/client/v3/user/@alice:localhost/account_data/org.example.settings", alice, { theme: "dark" });
        assert.equal((await get("/_matrix/client/v3/user/@alice:localhost/account_data/org.example.settings", alice)).json.theme, "dark");
      });
    } finally {
      await s.close();
      cleanup();
    }
  });
}
