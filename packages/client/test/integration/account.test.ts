import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../../src/auth/login.ts";
import { passwordAuth } from "../../src/auth/uia.ts";
import { MatrixError } from "../../src/http/errors.ts";
import { homeserver, until } from "./helpers.ts";

test("discovery and registration: versions, support, username availability, guests", async () => {
  const t = await homeserver();
  try {
    const auth = new Auth({ baseUrl: t.baseUrl, http: t.http });
    assert.ok((await auth.versions()).versions.length > 0);
    assert.equal(await auth.support(), undefined, "no support contacts configured");
    assert.equal(await auth.isUsernameAvailable("carol"), true);
    await auth.register("carol", "a long password");
    assert.equal(await auth.isUsernameAvailable("carol"), false);
    const url = new URL(auth.ssoRedirectUrl("https://app.example/cb", "oidc-x", "login"));
    assert.equal(url.pathname, "/_matrix/client/v3/login/sso/redirect/oidc-x");
    assert.equal(url.searchParams.get("redirectUrl"), "https://app.example/cb");
    assert.equal(url.searchParams.get("action"), "login");
  } finally {
    await t.close();
  }
});

test("account: capabilities, password change with user-interactive auth, account data, ignored users, filters, OpenID", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const caps = await alice.account.capabilities();
    assert.ok(caps["m.room_versions"]?.default);

    const wrong = await alice.account.changePassword("new password 1", passwordAuth(alice.userId, "not it")).catch((e) => e);
    assert.ok(wrong instanceof MatrixError && wrong.status === 401, "a wrong password is not retried");
    await alice.account.changePassword("new password 1", passwordAuth(alice.userId, "password"), { logoutDevices: false });
    await new Auth({ baseUrl: t.baseUrl, http: t.http }).loginWithPassword("alice", "new password 1");

    assert.equal(await alice.account.getAccountData("com.example.x"), undefined);
    await alice.account.setAccountData("com.example.x", { a: 1 });
    assert.deepEqual(await alice.account.getAccountData("com.example.x"), { a: 1 });

    await alice.account.setIgnored(["@spam:localhost", "@troll:localhost"], true);
    await alice.account.setIgnored(["@troll:localhost"], false);
    assert.deepEqual(await alice.account.ignoredUsers(), ["@spam:localhost"]);

    const filterId = await alice.account.createFilter({ room: { timeline: { limit: 5 } } });
    assert.equal((await alice.account.getFilter(filterId)).room?.timeline?.limit, 5);

    const openid = await alice.account.requestOpenIdToken();
    assert.equal(openid.matrix_server_name, "localhost");
    assert.deepEqual(await alice.account.threePids(), []);
  } finally {
    await t.close();
  }
});

test("devices: list, rename, delete with user-interactive auth", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const other = await new Auth({ baseUrl: t.baseUrl, http: t.http }).loginWithPassword("alice", "password");
    const ids = (await alice.devices.list()).map((d) => d.device_id).sort();
    assert.deepEqual(ids, [alice.deviceId, other.deviceId].sort());
    await alice.devices.rename(other.deviceId, "Old phone");
    assert.equal((await alice.devices.get(other.deviceId)).display_name, "Old phone");
    const refused = await alice.devices.delete([other.deviceId], () => undefined).catch((e) => e);
    assert.ok(refused instanceof MatrixError && refused.status === 401);
    await alice.devices.delete([other.deviceId], passwordAuth(alice.userId, "password"));
    assert.deepEqual(
      (await alice.devices.list()).map((d) => d.device_id),
      [alice.deviceId],
    );
  } finally {
    await t.close();
  }
});

test("profile fields and presence", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const bob = await t.login("bob", { e2ee: false });
    await alice.profile.setDisplayName("Alice");
    await alice.profile.setTimeZone("Europe/Warsaw");
    await alice.profile.setAvatarUrl("mxc://localhost/abc");
    assert.equal(await bob.profile.getField("m.tz", alice.userId), "Europe/Warsaw");
    const p = await bob.profile.get(alice.userId);
    assert.equal(p.displayname, "Alice");
    assert.equal(p.avatar_url, "mxc://localhost/abc");
    await alice.profile.deleteField("m.tz");
    assert.equal(await alice.profile.getField("m.tz"), undefined);

    await alice.presence.set("unavailable", "lunch");
    const presence = await alice.presence.get();
    assert.equal(presence.presence, "unavailable");
    assert.equal(presence.status_msg, "lunch");
  } finally {
    await t.close();
  }
});

test("directory: aliases, visibility, public rooms, room summary, user search", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const bob = await t.login("bob", { e2ee: false });
    await alice.profile.setDisplayName("Alice Liddell");
    const roomId = await alice.createRoom({ name: "Lobby", preset: "public_chat" });
    await alice.directory.createAlias("#lobby:localhost", roomId);
    assert.deepEqual(await bob.directory.resolveAlias("#lobby:localhost"), { roomId, servers: ["localhost"] });
    assert.deepEqual(await alice.directory.roomAliases(roomId), ["#lobby:localhost"]);
    assert.equal(await bob.directory.resolveAlias("#nope:localhost"), undefined);

    assert.equal(await alice.directory.getVisibility(roomId), "private");
    await alice.directory.setVisibility(roomId, "public");
    assert.equal(await alice.directory.getVisibility(roomId), "public");
    const listed = await bob.directory.publicRooms();
    assert.ok(listed.chunk.some((r) => r.room_id === roomId));
    const searched = await bob.directory.publicRooms({ searchTerm: "lobby" });
    assert.ok(searched.chunk.some((r) => r.room_id === roomId));

    const summary = await bob.directory.roomSummary("#lobby:localhost");
    assert.equal(summary.room_id, roomId);
    assert.equal(summary.name, "Lobby");

    const users = await bob.directory.searchUsers("Liddell");
    assert.ok(users.results.some((u) => u.user_id === alice.userId));
    await alice.directory.deleteAlias("#lobby:localhost");
    assert.equal(await bob.directory.resolveAlias("#lobby:localhost"), undefined);
  } finally {
    await t.close();
  }
});

test("rooms: knock, joined rooms, mutual rooms, upgrade, state helpers, tags, reports", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const bob = await t.login("bob", { e2ee: false });
    await alice.start();
    await alice.waitForPrepared();
    const roomId = await alice.createRoom({ name: "Knock knock", preset: "private_chat" });
    await alice.setJoinRule(roomId, { join_rule: "knock" });
    await bob.knockRoom(roomId, { reason: "let me in" });
    await until("the knock", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "knock");
    await alice.invite(roomId, bob.userId);
    await bob.joinRoom(roomId);
    assert.ok((await bob.getJoinedRooms()).includes(roomId));
    assert.deepEqual(await alice.getMutualRooms(bob.userId), [roomId]);

    await alice.setPowerLevel(roomId, bob.userId, 50);
    assert.equal(((await alice.fetchStateEvent(roomId, "m.room.power_levels")) as { users: Record<string, number> }).users[bob.userId], 50);
    await alice.setHistoryVisibility(roomId, "joined");
    assert.ok((await alice.fetchRoomState(roomId)).some((e) => e.type === "m.room.history_visibility"));
    assert.ok(Object.keys(await alice.fetchJoinedMembers(roomId)).includes(bob.userId));
    assert.equal((await alice.fetchMembers(roomId, { membership: "join" })).length, 2);

    await bob.setTag(roomId, "m.favourite", 0.5);
    assert.deepEqual(await bob.getTags(roomId), { "m.favourite": { order: 0.5 } });
    await bob.deleteTag(roomId, "m.favourite");
    assert.deepEqual(await bob.getTags(roomId), {});

    const eventId = await bob.sendText(roomId, "spam?");
    await bob.reportEvent(roomId, eventId, "testing");
    await bob.reportRoom(roomId, "testing");
    await bob.reportUser(alice.userId, "testing");

    const newRoom = await alice.upgradeRoom(roomId, "11");
    assert.notEqual(newRoom, roomId);
    const tombstone = await alice.fetchStateEvent(roomId, "m.room.tombstone");
    assert.equal(tombstone?.replacement_room, newRoom);
  } finally {
    await t.close();
  }
});

test("timeline queries: event, context, relations, threads, timestamps, read markers, search, peeking", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const bob = await t.login("bob", { e2ee: false });
    const roomId = await alice.createRoom({ preset: "public_chat" });
    await alice.setHistoryVisibility(roomId, "world_readable");
    const before = Date.now();
    const first = await alice.sendText(roomId, "first message about kittens");
    const second = await alice.sendText(roomId, "second");
    await alice.sendReaction(roomId, first, "👍");
    await alice.sendEvent(roomId, "m.room.message", {
      msgtype: "m.text",
      body: "in a thread",
      "m.relates_to": { rel_type: "m.thread", event_id: first },
    });

    assert.equal((await alice.fetchEvent(roomId, second)).content.body, "second");
    const ctx = await alice.fetchContext(roomId, second, { limit: 4 });
    assert.equal(ctx.event?.eventId, second);
    assert.ok(ctx.before.some((e) => e.eventId === first));

    const reactions = await alice.fetchRelations(roomId, first, { relType: "m.annotation", eventType: "m.reaction" });
    assert.equal(reactions.events.length, 1);
    assert.equal((await alice.fetchRelations(roomId, first)).events.length, 2);
    const threads = await alice.fetchThreads(roomId);
    assert.deepEqual(
      threads.roots.map((e) => e.eventId),
      [first],
    );

    const found = await alice.timestampToEvent(roomId, before, "f");
    assert.ok(found.eventId);

    await alice.setReadMarkers(roomId, { fullyRead: second, read: second });
    await alice.sendReadReceipt(roomId, first, "m.read", { threadId: first });

    const results = await alice.search("kittens");
    assert.equal(results.search_categories.room_events?.results?.[0]?.result?.event_id, first);

    // Bob is not in the room: a world-readable room can be peeked at.
    const peek = await bob.peekRoom(roomId);
    assert.ok(peek.messages.some((e) => e.eventId === second));
  } finally {
    await t.close();
  }
});

test("admin: whois, suspend, lock", async () => {
  const t = await homeserver();
  try {
    const admin = await t.login("root", { e2ee: false, admin: true });
    const bob = await t.login("bob", { e2ee: false });
    const whois = await admin.admin.whois(bob.userId);
    assert.equal(whois.user_id, bob.userId);
    assert.equal(await admin.admin.setSuspended(bob.userId, true), true);
    assert.equal(await admin.admin.isSuspended(bob.userId), true);
    assert.equal(await admin.admin.setSuspended(bob.userId, false), false);
    assert.equal(await admin.admin.setLocked(bob.userId, true), true);
    assert.equal(await admin.admin.isLocked(bob.userId), true);
    const locked = await bob.account.whoami().catch((e) => e);
    assert.ok(locked instanceof MatrixError && locked.errcode === "M_USER_LOCKED");
    assert.equal(await admin.admin.setLocked(bob.userId, false), false);
    const forbidden = await bob.admin.whois(admin.userId).catch((e) => e);
    assert.ok(forbidden instanceof MatrixError && forbidden.status === 403, "only admins");
  } finally {
    await t.close();
  }
});
