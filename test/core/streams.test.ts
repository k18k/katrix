import { test } from "node:test";
import assert from "node:assert/strict";
import { localCluster, StreamManager, type ClusterAdapter } from "#core/cluster.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A shared cluster whose calls take random time, so answers arrive out of order (as over a network). */
function slowCluster(): ClusterAdapter {
  const c = localCluster();
  const delay = () => sleep(Math.random() * 3);
  return {
    ...c,
    nextId: async (s) => {
      await delay();
      const id = await c.nextId(s);
      await delay();
      return id;
    },
    currentId: async (s) => {
      await delay();
      const v = await c.currentId(s);
      await delay();
      return v;
    },
    set: async (k, v, t) => {
      await delay();
      await c.set(k, v, t);
    },
    entries: async (p) => {
      await delay();
      return c.entries(p);
    },
  } as ClusterAdapter;
}

// https://github.com/k18k/matrix-nodejs-homeserver/issues/30: publishes are shared between
// writers now; readers must still never see a position whose write is not finished.
test("readers never pass a position that is still being written, across several writers", async () => {
  const cluster = slowCluster();
  const writers = [new StreamManager(cluster, "a"), new StreamManager(cluster, "b"), new StreamManager(cluster, "c")];
  const committed = new Set<number>();
  let stop = false;
  let checks = 0;
  const reader = (async () => {
    const r = new StreamManager(cluster, "reader");
    while (!stop) {
      const pos = await r.position();
      for (let i = 1; i <= pos; i++) assert.ok(committed.has(i), `position ${pos} passes uncommitted ${i}`);
      checks++;
      await sleep(Math.random() * 2);
    }
    await r.stop();
  })();
  // Short bursts with pauses, so writers often go idle and a new reservation meets an allocation
  // that is still waiting for its position (the window where a publish could overtake it).
  let total = 0;
  await Promise.all(
    writers.map(async (w) => {
      for (let burst = 0; burst < 60; burst++) {
        await Promise.all(
          Array.from({ length: 1 + Math.floor(Math.random() * 3) }, async () => {
            await sleep(Math.random() * 2);
            total++;
            await w.write(async (id) => {
              await sleep(Math.random() * 5);
              committed.add(id);
            });
          }),
        );
        await sleep(Math.random() * 4);
      }
    }),
  );
  stop = true;
  await reader;
  for (const w of writers) await w.stop();
  assert.equal(committed.size, total);
  assert.ok(checks > 20);
  // Once everything is written, readers see all of it.
  assert.equal(await new StreamManager(cluster, "late").position(), total);
});
