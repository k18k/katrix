import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../../src/auth/login.ts";
import { body, findEvent, homeserver, recordingLogger, until } from "./helpers.ts";

// Secrets must never reach logs or error messages: access and refresh tokens, passwords,
// one-time and session keys, pickles, plaintexts.

test("a whole E2EE session logs no secrets", async () => {
  const t = await homeserver();
  const logger = recordingLogger();
  try {
    const password = "correct horse battery staple";
    await t.hs.admin.createUser("alice", { password });
    await t.hs.admin.createUser("bob", { password });
    const alice = await t.login("alice", { create: false, password, logger });
    const bob = await t.login("bob", { create: false, password, logger });
    await alice.start();
    await bob.start();
    await alice.waitForPrepared();
    await bob.waitForPrepared();
    const roomId = await alice.createRoom({ encrypted: true, invite: [bob.userId] });
    await until("invite", () => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    await until("join", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
    const plaintext = "the eagle lands at midnight";
    await alice.sendText(roomId, plaintext);
    await until("decrypted", () => findEvent(bob, roomId, (e) => e.decryptionStatus === "decrypted" && body(e) === plaintext));
    // Provoke warnings: a failed login, an undecryptable event, a rejected request.
    await new Auth({ baseUrl: t.baseUrl, http: t.http, logger }).loginWithPassword("alice", "wrong " + password).catch(() => {});
    await bob.api.request("GET", "/v3/rooms/!nope:localhost/state").catch(() => {});

    const secrets: string[] = [password, plaintext];
    for (const c of [alice, bob]) {
      secrets.push((c as unknown as { tokens: { accessToken(): string } }).tokens.accessToken());
      const refresh = (c as unknown as { tokens: { current(): { refreshToken?: string } } }).tokens.current().refreshToken;
      if (refresh) secrets.push(refresh);
      const account = await c.store.get<{ pickle: string }>("account", "account");
      const state = JSON.parse(account!.pickle);
      secrets.push(state.curve25519.secret_key, state.ed25519.secret_key);
      for (const k of state.one_time_keys) secrets.push(k.secret_key);
      for (const [, s] of await c.store.list<{ pickle: string }>("inbound_group_sessions")) secrets.push(JSON.parse(s.pickle).initial);
      for (const [, s] of await c.store.list<{ pickle: string }>("outbound_group_sessions"))
        secrets.push(JSON.parse(s.pickle).ratchet, JSON.parse(s.pickle).signing_secret_key);
      for (const [, s] of await c.store.list<{ pickle: string }>("olm_sessions")) secrets.push(JSON.parse(s.pickle).ratchet.root_key);
    }
    assert.ok(logger.lines.length > 0, "there was something to check");
    const all = logger.lines.join("\n");
    for (const s of secrets) {
      assert.ok(s && s.length >= 8);
      assert.ok(!all.includes(s), `a secret appears in the logs: ${s.slice(0, 4)}…`);
      // Nor a fragment of it long enough to matter.
      assert.ok(!all.includes(s.slice(0, 16)) || s.length < 16, "a fragment of a secret appears in the logs");
    }
  } finally {
    await t.close();
  }
});

test("errors of failed requests carry no tokens or passwords", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice");
    const token = (alice as unknown as { tokens: { accessToken(): string } }).tokens.accessToken();
    const errors = [
      await alice.api.request("GET", "/v3/rooms/!nope:localhost/messages").catch((e) => e),
      await new Auth({ baseUrl: t.baseUrl, http: t.http }).loginWithPassword("alice", "pa55-not-this-one").catch((e) => e),
      await alice.sendText("!nope:localhost", "x").catch((e) => e),
    ];
    for (const e of errors) {
      const text = `${e.message}\n${e.stack}\n${JSON.stringify(e)}`;
      assert.ok(!text.includes(token));
      assert.ok(!text.includes("pa55-not-this-one"));
    }
  } finally {
    await t.close();
  }
});
