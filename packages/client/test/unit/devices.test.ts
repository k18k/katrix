import { test } from "node:test";
import assert from "node:assert/strict";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { DeviceTracker } from "../../src/e2ee/devices.ts";
import { deviceKeysObject } from "../../src/e2ee/keys.ts";
import type { MatrixHttpApi } from "../../src/http/api.ts";
import { nativeE2EEProtocol } from "../../src/protocol/native.ts";
import { MemoryStorage } from "../../src/storage/memory.ts";
import { Store } from "../../src/storage/store.ts";
import { noopLogger } from "../../src/util/logger.ts";

const protocol = nativeE2EEProtocol(nobleCryptoPrimitives());
const U = "@u:x";

function tracker(answer: () => Record<string, unknown>) {
  const store = new Store(new MemoryStorage());
  const queries: unknown[] = [];
  const api = {
    async endpoint(_key: string, _params: unknown, opts: { body: unknown }) {
      queries.push(opts.body);
      return { device_keys: { [U]: answer() }, failures: {} };
    },
  } as unknown as MatrixHttpApi;
  return { t: new DeviceTracker({ api, store, protocol, logger: noopLogger }), store, queries };
}

test("only devices whose keys are self-signed and name the right user and device are kept", async () => {
  const good = protocol.newAccount();
  const other = protocol.newAccount();
  const forged = { ...deviceKeysObject(good, U, "FORGED"), keys: deviceKeysObject(other, U, "FORGED").keys };
  const answer = {
    GOOD: deviceKeysObject(good, U, "GOOD"),
    WRONGUSER: deviceKeysObject(protocol.newAccount(), "@v:x", "WRONGUSER"),
    MISMATCH: deviceKeysObject(protocol.newAccount(), U, "OTHERID"),
    FORGED: forged,
    UNSIGNED: { ...deviceKeysObject(protocol.newAccount(), U, "UNSIGNED"), signatures: {} },
    FLOAT: { ...deviceKeysObject(protocol.newAccount(), U, "FLOAT"), extra: 1.5 },
  };
  const { t } = tracker(() => answer);
  await t.refresh([U]);
  assert.deepEqual(
    (await t.devices(U)).map((d) => d.deviceId),
    ["GOOD"],
  );
});

test("a known device's keys cannot be swapped (trust on first use)", async () => {
  const first = protocol.newAccount();
  const attacker = protocol.newAccount();
  let answer: Record<string, unknown> = { DEV: deviceKeysObject(first, U, "DEV") };
  const { t, store } = tracker(() => answer);
  await t.refresh([U]);
  const before = (await t.devices(U))[0];
  assert.equal(before.ed25519, first.identityKeys().ed25519);
  // The server now presents other, validly self-signed keys for the same device ID.
  answer = { DEV: deviceKeysObject(attacker, U, "DEV") };
  await store.transaction((tx) => t.handleDeviceLists(tx, { changed: [U], left: [] }));
  await t.refresh([U]);
  assert.deepEqual(await t.devices(U), [before]);
});

test("outdated users are queried again; a change during a query keeps them outdated", async () => {
  const acc = protocol.newAccount();
  let release: () => void = () => {};
  let block = false;
  const store = new Store(new MemoryStorage());
  let calls = 0;
  const api = {
    async endpoint() {
      calls++;
      if (block) await new Promise<void>((r) => (release = r));
      return { device_keys: { [U]: { D: deviceKeysObject(acc, U, "D") } } };
    },
  } as unknown as MatrixHttpApi;
  const t = new DeviceTracker({ api, store, protocol, logger: noopLogger });
  await store.transaction((tx) => t.track(tx, [U]));
  assert.ok(await t.isOutdated(U));
  await t.refresh([U]);
  assert.ok(!(await t.isOutdated(U)));
  await t.refresh([U]);
  assert.equal(calls, 1, "up to date: no query");
  block = true;
  await store.transaction((tx) => t.handleDeviceLists(tx, { changed: [U], left: [] }));
  const running = t.refresh([U]);
  await new Promise((r) => setTimeout(r, 10));
  await store.transaction((tx) => t.handleDeviceLists(tx, { changed: [U], left: [] }));
  release();
  await running;
  assert.ok(await t.isOutdated(U), "the second change came after the query started");
  await store.transaction((tx) => t.handleDeviceLists(tx, { changed: [], left: [U] }));
  assert.equal((await t.getUser(U))?.tracked, false);
});
