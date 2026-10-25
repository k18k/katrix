import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../../src/auth/login.ts";
import { passwordAuth } from "../../src/auth/uia.ts";
import { MatrixClient } from "../../src/client.ts";
import { body, findEvent, homeserver, until } from "./helpers.ts";

type T = Awaited<ReturnType<typeof homeserver>>;

async function started(t: T, localpart: string, create = true): Promise<MatrixClient> {
  const c = await t.login(localpart, { create });
  await c.start();
  await c.waitForPrepared();
  return c;
}

/** Another device of an existing user. */
async function anotherDevice(t: T, localpart: string): Promise<MatrixClient> {
  const credentials = await new Auth({ baseUrl: t.baseUrl, http: t.http }).loginWithPassword(localpart, "password");
  const c = new MatrixClient({ baseUrl: t.baseUrl, http: t.http, credentials, sync: { pollTimeoutMs: 1000 } });
  await c.start();
  await c.waitForPrepared();
  return c;
}

test("cross-signing: bootstrap, own devices, verifying another user, identity changes", async () => {
  const t = await homeserver();
  const extra: MatrixClient[] = [];
  try {
    const alice = await started(t, "alice");
    const bob = await started(t, "bob");
    const cs = alice.e2ee!.crossSigning;
    assert.equal((await cs.status()).publishedOnServer, false);
    await cs.bootstrap(passwordAuth(alice.userId, "password"));
    assert.deepEqual(await cs.status(), { publishedOnServer: true, trusted: true, selfSigning: true, userSigning: true });
    assert.equal((await cs.deviceTrust(alice.userId, alice.deviceId)).crossSigned, true, "this device is signed");

    // A second device of Alice's is signed by the first, and trusted there.
    const alice2 = await anotherDevice(t, "alice");
    extra.push(alice2);
    await alice.e2ee!.devices.refresh([alice.userId], { force: true });
    assert.equal((await cs.deviceTrust(alice.userId, alice2.deviceId)).verified, false);
    await cs.signOwnDevice(alice2.deviceId);
    assert.deepEqual(await cs.deviceTrust(alice.userId, alice2.deviceId), { locallyVerified: false, crossSigned: true, verified: true });

    // Bob sets up cross-signing; Alice verifies him (as after SAS): his devices are trusted.
    await bob.e2ee!.crossSigning.bootstrap(passwordAuth(bob.userId, "password"));
    await alice.e2ee!.devices.refresh([bob.userId], { force: true });
    assert.equal((await cs.userTrust(bob.userId)).verified, false);
    await cs.verifyUser(bob.userId);
    assert.equal((await cs.userTrust(bob.userId)).verified, true);
    assert.equal((await cs.deviceTrust(bob.userId, bob.deviceId)).verified, true);

    // Bob replaces his identity: no longer verified, and Alice is told it changed.
    await bob.e2ee!.crossSigning.bootstrap(passwordAuth(bob.userId, "password"));
    await alice.e2ee!.devices.refresh([bob.userId], { force: true });
    const changed = await cs.userTrust(bob.userId);
    assert.equal(changed.verified, false);
    assert.equal(changed.identityChanged, true);
    assert.equal((await cs.deviceTrust(bob.userId, bob.deviceId)).verified, false);
    await cs.acceptIdentityChange(bob.userId);
    assert.equal((await cs.userTrust(bob.userId)).identityChanged, false);
  } finally {
    for (const c of extra) await c.stop();
    await t.close();
  }
});

test("recovery: set up, then a new device gets the identity and the history with the recovery key", async () => {
  const t = await homeserver();
  const extra: MatrixClient[] = [];
  try {
    const alice = await started(t, "alice");
    const bob = await started(t, "bob");
    const roomId = await alice.createRoom({ encrypted: true, invite: [bob.userId] });
    await until("the invite", () => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    await until("bob joined", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
    await until("bob has the room", () => bob.getRoom(roomId)?.state.membership(alice.userId) === "join");
    await bob.sendText(roomId, "an old secret");
    await until("alice reads it", () => findEvent(alice, roomId, (e) => body(e) === "an old secret"));

    const { recoveryKey } = await alice.e2ee!.recovery.setUp({ passphrase: "my passphrase", auth: passwordAuth(alice.userId, "password") });
    assert.equal((await alice.e2ee!.recovery.status()).setUp, true);
    await assert.rejects(alice.e2ee!.recovery.setUp({}), /set up already/);
    // The backup has Bob's session (sent to Alice) and Alice's own.
    const info = await alice.e2ee!.backup.serverInfo();
    assert.ok(info && info.count >= 1);

    const alice2 = await anotherDevice(t, "alice");
    extra.push(alice2);
    await alice2.paginateBackwards(roomId);
    const old = await until("the old message", () => alice2.getRoom(roomId)?.timeline.events.find((e) => e.isEncrypted()));
    assert.notEqual(old.decryptionStatus, "decrypted");
    await assert.rejects(alice2.e2ee!.recovery.recover("not it"), /recovery key or passphrase/);
    const { importedKeys } = await alice2.e2ee!.recovery.recover(recoveryKey);
    assert.ok(importedKeys >= 1);
    await until("the old message decrypts", () => alice2.getRoom(roomId)?.timeline.events.some((e) => body(e) === "an old secret"));
    const decrypted = alice2.getRoom(roomId)!.timeline.events.find((e) => body(e) === "an old secret")!;
    assert.equal(decrypted.decryptionInfo?.authenticity, "unauthenticated", "a backed-up key does not prove its sender");

    // The new device is verified: by its own identity, and as seen from the first device.
    assert.equal((await alice2.e2ee!.crossSigning.status()).trusted, true);
    await alice.e2ee!.devices.refresh([alice.userId], { force: true });
    assert.equal((await alice.e2ee!.crossSigning.deviceTrust(alice.userId, alice2.deviceId)).verified, true);

    // Backup management: the version, the master key's signature on it, deleting keys.
    const version = (await alice.e2ee!.backup.active())!.version;
    assert.equal((await alice.e2ee!.backup.versionInfo(version))?.version, version);
    const masterSeed = Uint8Array.from(
      Buffer.from(
        (await alice.e2ee!.secretStorage.get("m.cross_signing.master", await alice.e2ee!.recovery.keyFrom(recoveryKey)))!,
        "base64",
      ),
    );
    await alice.e2ee!.backup.signWithMasterKey(masterSeed);
    assert.equal(await alice2.e2ee!.backup.isTrusted((await alice2.e2ee!.backup.serverInfo())!), true);
    await alice.e2ee!.backup.deleteKeys({ roomId });
    assert.equal((await alice.e2ee!.backup.serverInfo())?.count, 0);

    // The passphrase opens it too.
    const alice3 = await anotherDevice(t, "alice");
    extra.push(alice3);
    await alice3.e2ee!.recovery.recover("my passphrase");
    assert.equal((await alice3.e2ee!.crossSigning.status()).trusted, true);
  } finally {
    for (const c of extra) await c.stop();
    await t.close();
  }
});

test("key and secret sharing between verified own devices", async () => {
  const t = await homeserver();
  const extra: MatrixClient[] = [];
  try {
    const alice = await started(t, "alice");
    const bob = await started(t, "bob");
    await alice.e2ee!.recovery.setUp({ auth: passwordAuth(alice.userId, "password") });
    const roomId = await alice.createRoom({ encrypted: true, invite: [bob.userId] });
    await until("the invite", () => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    await until("bob joined", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
    await until("bob has the room", () => bob.getRoom(roomId)?.state.membership(alice.userId) === "join");
    await bob.sendText(roomId, "before the new device");
    await until("alice reads it", () => findEvent(alice, roomId, (e) => body(e) === "before the new device"));
    // Not in the backup: the new device must get the key from Alice's first device.
    await alice.e2ee!.backup.disable();

    const alice2 = await anotherDevice(t, "alice");
    extra.push(alice2);
    // Verified both ways, as after an SAS verification between the two.
    await alice.e2ee!.devices.refresh([alice.userId], { force: true });
    await alice.e2ee!.crossSigning.signOwnDevice(alice2.deviceId);
    await alice2.e2ee!.devices.refresh([alice.userId], { force: true });
    await alice2.e2ee!.crossSigning.markOwnIdentityVerified();
    assert.equal((await alice2.e2ee!.crossSigning.deviceTrust(alice.userId, alice.deviceId)).verified, true);

    // Secret sharing: the self-signing key, from the first device.
    const ssk = await alice2.e2ee!.sharing.requestSecret("m.cross_signing.self_signing", 10_000);
    assert.ok(ssk);
    await alice2.e2ee!.crossSigning.importPrivateKeys({ selfSigning: Uint8Array.from(Buffer.from(ssk, "base64")) });
    assert.equal((await alice2.e2ee!.crossSigning.status()).selfSigning, true);
    assert.equal(await alice2.e2ee!.sharing.requestSecret("m.cross_signing.master", 2_000), undefined, "the master key is never shared");

    // A room key request: the old message decrypts with a key forwarded by the first device.
    await alice2.paginateBackwards(roomId);
    await until(
      "the forwarded key",
      () => alice2.getRoom(roomId)?.timeline.events.some((e) => body(e) === "before the new device"),
      20_000,
    );
  } finally {
    for (const c of extra) await c.stop();
    await t.close();
  }
});
