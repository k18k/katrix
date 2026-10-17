import { test } from "node:test";
import assert from "node:assert/strict";
import { localCluster, StreamManager } from "#core/cluster.ts";
import { Notifier } from "#core/notifier.ts";
import { longPoll } from "#api/longpoll.ts";
import type { Homeserver } from "#homeserver.ts";

/** Just what longPoll uses: a stream and a notifier, as a homeserver wires them. */
function server() {
  const cluster = localCluster();
  const streams = new StreamManager(cluster, "a");
  const notifier = new Notifier(cluster, "a", () => streams.lastAllocated);
  return { streams, notifier } as unknown as Homeserver & { streams: StreamManager; notifier: Notifier };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// https://github.com/k18k/matrix-nodejs-homeserver/issues/50
test("a waiting request does not rebuild for changes that are not its own", async () => {
  const hs = server();
  let builds = 0;
  const poll = longPoll(hs, "@me:x", 300, undefined, async () => {
    builds++;
    return { value: null, done: false };
  });
  // Others' changes move the position many times.
  for (let i = 0; i < 20; i++) {
    const pos = await hs.streams.write(async (id) => id);
    hs.notifier.notify(["@other:x"], pos);
    await sleep(5);
  }
  await poll;
  assert.equal(builds, 1);
});

test("a wake-up whose change is still held back by an earlier write is not lost", async () => {
  const hs = server();
  // An earlier write, still in flight, holds the position below the change we are woken for.
  const earlier = await hs.streams.allocate();
  let mine = 0;
  const poll = longPoll(hs, "@me:x", 5_000, undefined, async (to) => ({ value: to, done: mine > 0 && to >= mine }));
  await sleep(10);
  mine = await hs.streams.write(async (id) => id);
  hs.notifier.notify(["@me:x"], mine);
  await sleep(30);
  // Releasing the earlier write wakes nobody here; the request must still see the change.
  const started = Date.now();
  await earlier.done();
  const { value } = await poll;
  assert.ok(value >= mine);
  assert.ok(Date.now() - started < 1_000, "the change arrived without waiting for the timeout");
});

test("a wake-up between two builds is not lost", async () => {
  const hs = server();
  let mine = 0;
  let builds = 0;
  const poll = longPoll(hs, "@me:x", 5_000, undefined, async (to) => {
    builds++;
    // The change lands while the first build runs, before the request waits again.
    if (builds === 1) {
      mine = await hs.streams.write(async (id) => id);
      hs.notifier.notify(["@me:x"], mine);
    }
    return { value: to, done: mine > 0 && to >= mine };
  });
  const started = Date.now();
  const { value } = await poll;
  assert.ok(value >= mine);
  assert.ok(Date.now() - started < 1_000);
});
