import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHomeserver, getFetchHandler, memoryAdapter } from "#index.ts";
import { CryptoClient, fileSink, memorySink, startAuditBot, type AuditRecord } from "#auditbot/index.ts";

// The audit bot against a real homeserver: it joins rooms on its own and records them, and in an
// end-to-end encrypted room it decrypts what a real E2EE client (matrix-sdk-crypto, as in the
// Element apps) sends.

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function setup(botOptions: { rooms?: "all" | "groups"; sink?: ReturnType<typeof memorySink> | ReturnType<typeof fileSink> } = {}) {
  const hs = createHomeserver({ homeserver: "localhost", databaseAdapter: memoryAdapter(), cleanupIntervalMs: 0, logger: quiet });
  await hs.ready;
  const fetch = getFetchHandler(hs);
  const dataDir = mkdtempSync(`${tmpdir()}/auditbot-`);
  const sink = botOptions.sink ?? memorySink();
  const bot = await startAuditBot(hs, { sink, dataDir, storePassphrase: "test passphrase", rooms: botOptions.rooms });
  const user = async (localpart: string) => {
    const userId = await hs.admin.createUser(localpart, { password: "password" });
    const s = await hs.auth.createSession(userId);
    return new CryptoClient({ fetch, userId, deviceId: s.device_id, accessToken: s.access_token });
  };
  return {
    hs,
    bot,
    sink,
    dataDir,
    user,
    async close() {
      await bot.stop();
      await hs.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const records = (t: { sink: unknown }) => (t.sink as ReturnType<typeof memorySink>).records;
const find = (records: AuditRecord[], body: string) => records.find((r) => (r.content as { body?: string }).body === body);

test("the bot joins a new private room on its own and records its messages", async () => {
  const t = await setup();
  try {
    const alice = await t.user("alice");
    const { room_id } = await alice.request("POST", "/_matrix/client/v3/createRoom", { preset: "private_chat", name: "Team" });
    await until("the bot to join", async () => (await t.hs.rooms.joinedMembers(room_id)).includes(t.bot.userId));
    // Everyone sees that the room is recorded: the bot is a member, with a name that says so.
    const members = await alice.request("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/joined_members`);
    assert.equal(members.joined[t.bot.userId].display_name, "Audit log (this room is recorded)");
    await alice.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/t1`, {
      msgtype: "m.text",
      body: "plain hello",
    });
    const record = await until("the message to be recorded", () => find(records(t), "plain hello"));
    assert.equal(record.sender, "@alice:localhost");
    assert.equal(record.room_id, room_id);
    assert.equal(record.encrypted, false);
    // The room's settings are part of the record too.
    assert.ok(records(t).some((r) => r.room_id === room_id && r.type === "m.room.name" && r.content.name === "Team"));
  } finally {
    await t.close();
  }
});

test("e2e: the bot decrypts an end-to-end encrypted message sent by a real E2EE client", async () => {
  const t = await setup();
  try {
    const alice = await t.user("alice");
    await alice.open();
    await alice.flush(); // device keys and one-time keys
    const { room_id } = await alice.request("POST", "/_matrix/client/v3/createRoom", {
      preset: "private_chat",
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    await until("the bot to join", async () => (await t.hs.rooms.joinedMembers(room_id)).includes(t.bot.userId));
    await t.bot.synced();
    const eventId = await alice.sendEncrypted(room_id, ["@alice:localhost", t.bot.userId], { msgtype: "m.text", body: "secret hello" });
    const record = await until("the decrypted message", () => find(records(t), "secret hello"));
    assert.equal(record.event_id, eventId);
    assert.equal(record.type, "m.room.message");
    assert.equal(record.encrypted, true);
    assert.equal(record.sender_device, alice.deviceId);
    // The server only ever saw ciphertext.
    const stored = await t.hs.rooms.getEvent(eventId);
    assert.equal(stored?.pdu.type, "m.room.encrypted");
    alice.close();
  } finally {
    await t.close();
  }
});

test("rooms: groups leaves direct messages alone; the file sink writes one file per room and day", async () => {
  const dir = mkdtempSync(`${tmpdir()}/auditbot-files-`);
  const t = await setup({ rooms: "groups", sink: fileSink(dir) });
  try {
    const alice = await t.user("alice");
    await t.user("bob");
    const dm = await alice.request("POST", "/_matrix/client/v3/createRoom", {
      preset: "trusted_private_chat",
      is_direct: true,
      invite: ["@bob:localhost"],
    });
    const group = await alice.request("POST", "/_matrix/client/v3/createRoom", { preset: "private_chat", name: "Group" });
    await until("the bot to join the group", async () => (await t.hs.rooms.joinedMembers(group.room_id)).includes(t.bot.userId));
    await t.bot.sweep();
    assert.equal((await t.hs.rooms.joinedMembers(dm.room_id)).includes(t.bot.userId), false);
    await alice.request("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(group.room_id)}/send/m.room.message/t2`, {
      msgtype: "m.text",
      body: "to the file",
    });
    const roomDir = `${dir}/${encodeURIComponent(group.room_id)}`;
    const line = await until("the file", () => {
      try {
        const file = readdirSync(roomDir).find((f) => f.endsWith(".jsonl"));
        return file
          ? readFileSync(`${roomDir}/${file}`, "utf8")
              .split("\n")
              .find((l) => l.includes("to the file"))
          : undefined;
      } catch {
        return undefined;
      }
    });
    assert.equal(JSON.parse(line).sender, "@alice:localhost");
  } finally {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after a restart the bot keeps its device and room keys, and goes on recording", async () => {
  const hs = createHomeserver({ homeserver: "localhost", databaseAdapter: memoryAdapter(), cleanupIntervalMs: 0, logger: quiet });
  await hs.ready;
  const fetch = getFetchHandler(hs);
  const dataDir = mkdtempSync(`${tmpdir()}/auditbot-restart-`);
  const sink = memorySink();
  const options = { sink, dataDir, storePassphrase: "test passphrase" };
  let bot = await startAuditBot(hs, options);
  try {
    const userId = await hs.admin.createUser("alice", { password: "password" });
    const s = await hs.auth.createSession(userId);
    const alice = new CryptoClient({ fetch, userId, deviceId: s.device_id, accessToken: s.access_token });
    await alice.open();
    await alice.flush();
    const { room_id } = await alice.request("POST", "/_matrix/client/v3/createRoom", {
      preset: "private_chat",
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    await until("the bot to join", async () => (await hs.rooms.joinedMembers(room_id)).includes(bot.userId));
    await bot.synced();
    await alice.sendEncrypted(room_id, [userId, bot.userId], { msgtype: "m.text", body: "before restart" });
    await until("the first message", () => find(sink.records, "before restart"));
    const device = (await hs.db.findMany("devices", { where: [{ field: "user_id", value: bot.userId }] })).map((d) => d.device_id);
    await bot.stop();

    // While it is down, Alice goes on in the same Megolm session: only the stored room key
    // lets the restarted bot read this.
    await alice.sendEncrypted(room_id, [userId, bot.userId], { msgtype: "m.text", body: "while it was down" });
    bot = await startAuditBot(hs, options);
    await until("the message sent while it was down", () => find(sink.records, "while it was down"));
    const after = (await hs.db.findMany("devices", { where: [{ field: "user_id", value: bot.userId }] })).map((d) => d.device_id);
    assert.deepEqual(after, device);
    alice.close();
  } finally {
    await bot.stop();
    await hs.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
