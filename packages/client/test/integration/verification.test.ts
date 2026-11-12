import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../../src/auth/login.ts";
import { passwordAuth } from "../../src/auth/uia.ts";
import { MatrixClient } from "../../src/client.ts";
import type { VerificationRequest } from "../../src/e2ee/verification/request.ts";
import { homeserver, until } from "./helpers.ts";

type T = Awaited<ReturnType<typeof homeserver>>;

async function device(t: T, localpart: string, create: boolean): Promise<MatrixClient> {
  let c: MatrixClient;
  if (create) c = await t.login(localpart);
  else {
    const credentials = await new Auth({ baseUrl: t.baseUrl, http: t.http }).loginWithPassword(localpart, "password");
    c = new MatrixClient({ baseUrl: t.baseUrl, http: t.http, credentials, sync: { pollTimeoutMs: 1000 } });
  }
  await c.start();
  await c.waitForPrepared();
  return c;
}

function nextRequest(c: MatrixClient): Promise<VerificationRequest> {
  return new Promise((resolve) => c.e2ee!.verification.once("request", resolve));
}

async function sas(a: VerificationRequest, b: VerificationRequest) {
  await until("both SAS", () => a.sasCode && b.sasCode);
  assert.deepEqual(a.sasCode, b.sasCode, "both sides show the same emoji and numbers");
  assert.equal(a.sasCode!.emoji.length, 7);
  await Promise.all([a.confirmSas(), b.confirmSas()]);
  await until("done", () => a.phase === "done" && b.phase === "done");
}

test("SAS between two devices of one user (to-device): the new device gets the identity and the keys", async () => {
  const t = await homeserver();
  const extra: MatrixClient[] = [];
  try {
    const alice = await device(t, "alice", true);
    await alice.e2ee!.recovery.setUp({ auth: passwordAuth(alice.userId, "password") });
    const alice2 = await device(t, "alice", false);
    extra.push(alice2);

    const incoming = nextRequest(alice);
    const req2 = await alice2.e2ee!.verification.requestOwnDeviceVerification();
    const req1 = await incoming;
    assert.equal(req1.otherDeviceId, alice2.deviceId);
    await req1.accept();
    await until("ready", () => req2.phase === "ready");
    await req2.startSas();
    await sas(req1, req2);

    assert.equal((await alice.e2ee!.crossSigning.deviceTrust(alice.userId, alice2.deviceId)).verified, true);
    // The new device trusts the identity, then fetches the private keys from the first one.
    await until(
      "secrets shared",
      async () => (await alice2.e2ee!.crossSigning.status()).selfSigning && (await alice2.e2ee!.backup.active())?.hasPrivateKey,
    );
    assert.equal((await alice2.e2ee!.crossSigning.status()).trusted, true);
  } finally {
    for (const c of extra) await c.stop();
    await t.close();
  }
});

test("SAS between two users, in their room; a mismatch cancels", async () => {
  const t = await homeserver();
  try {
    const alice = await device(t, "alice", true);
    const bob = await device(t, "bob", true);
    await alice.e2ee!.crossSigning.bootstrap(passwordAuth(alice.userId, "password"));
    await bob.e2ee!.crossSigning.bootstrap(passwordAuth(bob.userId, "password"));
    const roomId = await alice.createDirectRoom(bob.userId);
    await until("the invite", () => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    await until("bob joined", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
    await until("bob has the room", () => bob.getRoom(roomId)?.state.membership(alice.userId) === "join");

    const incoming = nextRequest(bob);
    const reqA = await alice.e2ee!.verification.requestUserVerification(roomId, bob.userId);
    const reqB = await incoming;
    await reqB.accept();
    await until("ready", () => reqA.phase === "ready");
    await reqB.startSas();
    await sas(reqA, reqB);
    assert.equal(
      (await alice.e2ee!.crossSigning.userTrust(bob.userId)).verified,
      true,
      "bob's master key, signed by alice's user-signing key",
    );
    assert.equal((await bob.e2ee!.crossSigning.userTrust(alice.userId)).verified, true);
    assert.equal((await alice.e2ee!.crossSigning.deviceTrust(bob.userId, bob.deviceId)).verified, true);

    // Again, and this time the user says the emoji differ.
    const incoming2 = nextRequest(bob);
    const reqA2 = await alice.e2ee!.verification.requestUserVerification(roomId, bob.userId);
    const reqB2 = await incoming2;
    await reqB2.accept();
    await until("ready", () => reqA2.phase === "ready");
    await reqA2.startSas();
    await until("both SAS", () => reqA2.sasCode && reqB2.sasCode);
    await reqB2.mismatchSas();
    await until("cancelled", () => reqA2.phase === "cancelled");
    assert.equal(reqA2.cancelCode, "m.mismatched_sas");
  } finally {
    await t.close();
  }
});

test("QR code self-verification: the new device shows, the trusted one scans", async () => {
  const t = await homeserver();
  const extra: MatrixClient[] = [];
  try {
    const alice = await device(t, "alice", true);
    await alice.e2ee!.recovery.setUp({ auth: passwordAuth(alice.userId, "password") });
    const alice2 = await device(t, "alice", false);
    extra.push(alice2);
    const incoming = nextRequest(alice);
    const req2 = await alice2.e2ee!.verification.requestOwnDeviceVerification();
    const req1 = await incoming;
    await req1.accept();
    await until("ready", () => req2.phase === "ready");

    const code = await req2.qrCode();
    assert.ok(code, "a device that does not trust the identity yet shows mode 2");
    assert.equal(code[7], 2);
    const scanned = new Promise<void>((resolve) => req2.once("qrScanned", () => resolve()));
    await req1.scanQrCode(code);
    await scanned;
    await req2.confirmQrScanned();
    await until("done", () => req1.phase === "done" && req2.phase === "done");
    assert.equal((await alice2.e2ee!.crossSigning.status()).trusted, true);
    assert.equal((await alice.e2ee!.crossSigning.deviceTrust(alice.userId, alice2.deviceId)).verified, true);

    // A code for another verification, or altered, is refused.
    await assert.rejects(req1.scanQrCode(code), /cannot be scanned now/);
  } finally {
    for (const c of extra) await c.stop();
    await t.close();
  }
});
