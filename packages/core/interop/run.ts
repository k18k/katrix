// Interoperability scenarios between this server (ours.test) and Synapse (synapse.test), driven
// through both servers' client APIs (https://github.com/k18k/matrix-nodejs-homeserver/issues/61).
// Start the servers with interop/docker-compose.yml, then: node interop/run.ts
// Prints a Markdown table of the scenarios (also usable as a CI job summary); exits 1 if any failed.
import { randomBytes } from "node:crypto";
import { CryptoClient } from "../src/auditbot/client.ts";

const OURS = process.env.OURS_URL ?? "http://localhost:18008";
const SYNAPSE = process.env.SYNAPSE_URL ?? "http://localhost:28008";

interface Account {
  base: string;
  userId: string;
  deviceId: string;
  token: string;
  since?: string;
}

async function call(base: string, method: string, path: string, body?: unknown, token?: string, raw = false): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
  });
  if (raw && method === "GET") {
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`), { status: res.status, json });
  return json;
}

/** Register with the dummy flow, as clients do on both servers. */
async function register(base: string, username: string): Promise<Account> {
  const body = { username, password: `p-${randomBytes(8).toString("hex")}`, initial_device_display_name: "interop" };
  let session: string | undefined;
  try {
    return toAccount(base, await call(base, "POST", "/_matrix/client/v3/register", body));
  } catch (err: any) {
    if (err.status !== 401) throw err;
    session = err.json.session;
  }
  return toAccount(base, await call(base, "POST", "/_matrix/client/v3/register", { ...body, auth: { type: "m.login.dummy", session } }));
}
const toAccount = (base: string, r: any): Account => ({ base, userId: r.user_id, deviceId: r.device_id, token: r.access_token });

const api = (a: Account, method: string, path: string, body?: unknown) => call(a.base, method, `/_matrix/client/v3${path}`, body, a.token);
const room = (id: string) => `/rooms/${encodeURIComponent(id)}`;
let txn = 0;
const send = (a: Account, roomId: string, type: string, content: unknown) =>
  api(a, "PUT", `${room(roomId)}/send/${encodeURIComponent(type)}/t${Date.now()}${txn++}`, content).then((r) => r.event_id as string);

/** Incremental /sync for `a` until `found` returns a value (or 20 s pass). */
async function syncUntil<T>(a: Account, found: (sync: any) => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const sync = await api(a, "GET", `/sync?timeout=1000${a.since ? `&since=${a.since}` : ""}`);
    a.since = sync.next_batch;
    const result = found(sync);
    if (result !== undefined) return result;
  }
  throw new Error(`timed out waiting for ${what}`);
}
const timeline = (sync: any, roomId: string): any[] => sync.rooms?.join?.[roomId]?.timeline?.events ?? [];
const until = async <T>(fn: () => Promise<T | undefined>, what: string): Promise<T> => {
  for (let i = 0; i < 40; i++) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const results: { name: string; ok: boolean; detail: string; ms: number }[] = [];
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, detail: "", ms: Date.now() - started });
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message.slice(0, 300), ms: Date.now() - started });
  }
}

const versions = await Promise.all(
  [OURS, SYNAPSE].map((b) => call(b, "GET", "/_matrix/federation/v1/version").then((r) => `${r.server.name} ${r.server.version}`)),
);
const tag = randomBytes(3).toString("hex");
const alice = await register(OURS, `alice${tag}`);
const bob = await register(SYNAPSE, `bob${tag}`);
for (const a of [alice, bob]) a.since = (await api(a, "GET", "/sync?timeout=0")).next_batch;

let oursRoom = "";
await scenario("Synapse user joins a public room on this server", async () => {
  oursRoom = (await api(alice, "POST", "/createRoom", { preset: "public_chat", name: "on ours" })).room_id;
  await api(bob, "POST", `/join/${encodeURIComponent(oursRoom)}?via=ours.test`, {});
  await syncUntil(alice, (s) => timeline(s, oursRoom).find((e) => e.type === "m.room.member" && e.state_key === bob.userId), "bob's join");
});

let aliceMessage = "";
await scenario("Messages in both directions", async () => {
  aliceMessage = await send(alice, oursRoom, "m.room.message", { msgtype: "m.text", body: "hello from ours" });
  await syncUntil(bob, (s) => timeline(s, oursRoom).find((e) => e.content?.body === "hello from ours"), "alice's message on Synapse");
  await send(bob, oursRoom, "m.room.message", { msgtype: "m.text", body: "hello from synapse" });
  await syncUntil(alice, (s) => timeline(s, oursRoom).find((e) => e.content?.body === "hello from synapse"), "bob's message on ours");
});

await scenario("Edits, reactions and redactions", async () => {
  await send(alice, oursRoom, "m.room.message", {
    msgtype: "m.text",
    body: "* edited",
    "m.new_content": { msgtype: "m.text", body: "edited" },
    "m.relates_to": { rel_type: "m.replace", event_id: aliceMessage },
  });
  await syncUntil(
    bob,
    (s) => timeline(s, oursRoom).find((e) => e.content?.["m.relates_to"]?.rel_type === "m.replace"),
    "the edit on Synapse",
  );
  await send(bob, oursRoom, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: aliceMessage, key: "👍" } });
  await syncUntil(alice, (s) => timeline(s, oursRoom).find((e) => e.type === "m.reaction"), "bob's reaction on ours");
  const relations = await api(alice, "GET", `${room(oursRoom)}/relations/${encodeURIComponent(aliceMessage)}`.replace("/v3/", "/v1/"));
  check(relations.chunk.length >= 2, `relations on ours: ${relations.chunk.length}`);
  await api(alice, "PUT", `${room(oursRoom)}/redact/${encodeURIComponent(aliceMessage)}/r${txn++}`, { reason: "test" });
  await until(async () => {
    const ev = await call(
      SYNAPSE,
      "GET",
      `/_matrix/client/v3${room(oursRoom)}/event/${encodeURIComponent(aliceMessage)}`,
      undefined,
      bob.token,
    );
    return Object.keys(ev.content).length === 0 ? true : undefined;
  }, "the redaction on Synapse");
});

await scenario("Room state changes reach the other server", async () => {
  await api(alice, "PUT", `${room(oursRoom)}/state/m.room.topic/`, { topic: "set on ours" });
  await until(
    async () => ((await api(bob, "GET", `${room(oursRoom)}/state/m.room.topic/`)).topic === "set on ours" ? true : undefined),
    "the topic on Synapse",
  );
});

await scenario("Typing notifications and read receipts", async () => {
  await api(alice, "PUT", `${room(oursRoom)}/typing/${encodeURIComponent(alice.userId)}`, { typing: true, timeout: 10000 });
  await syncUntil(
    bob,
    (s) =>
      s.rooms?.join?.[oursRoom]?.ephemeral?.events?.find((e: any) => e.type === "m.typing" && e.content.user_ids.includes(alice.userId)),
    "alice typing on Synapse",
  );
  const last = await send(alice, oursRoom, "m.room.message", { msgtype: "m.text", body: "read me" });
  await syncUntil(bob, (s) => timeline(s, oursRoom).find((e) => e.event_id === last), "the message to read");
  await api(bob, "POST", `${room(oursRoom)}/receipt/m.read/${encodeURIComponent(last)}`, {});
  await syncUntil(
    alice,
    (s) =>
      s.rooms?.join?.[oursRoom]?.ephemeral?.events?.find((e: any) => e.type === "m.receipt" && e.content[last]?.["m.read"]?.[bob.userId]),
    "bob's receipt on ours",
  );
});

await scenario("Invites from this server to a Synapse user", async () => {
  const privateRoom = (await api(alice, "POST", "/createRoom", { preset: "private_chat" })).room_id;
  await api(alice, "POST", `${room(privateRoom)}/invite`, { user_id: bob.userId });
  await syncUntil(bob, (s) => s.rooms?.invite?.[privateRoom], "the invite on Synapse");
  await api(bob, "POST", `/join/${encodeURIComponent(privateRoom)}`, {});
  await syncUntil(
    alice,
    (s) => timeline(s, privateRoom).find((e) => e.state_key === bob.userId && e.content.membership === "join"),
    "bob's join",
  );
});

let synapseRoom = "";
await scenario("A user here joins a room on Synapse, and backfills its history", async () => {
  synapseRoom = (await api(bob, "POST", "/createRoom", { preset: "public_chat", name: "on synapse" })).room_id;
  for (let i = 0; i < 25; i++) await send(bob, synapseRoom, "m.room.message", { msgtype: "m.text", body: `history ${i}` });
  await api(alice, "POST", `/join/${encodeURIComponent(synapseRoom)}?via=synapse.test`, {});
  const bodies: string[] = [];
  let from: string | undefined;
  for (let page = 0; page < 10 && !bodies.includes("history 0"); page++) {
    const res = await api(alice, "GET", `${room(synapseRoom)}/messages?dir=b&limit=10${from ? `&from=${from}` : ""}`);
    bodies.push(...res.chunk.filter((e: any) => e.type === "m.room.message").map((e: any) => e.content.body));
    if (!res.end) break;
    from = res.end;
  }
  check(bodies.includes("history 0") && bodies.includes("history 24"), `backfilled ${bodies.length} messages`);
  await send(alice, synapseRoom, "m.room.message", { msgtype: "m.text", body: "joined from ours" });
  await syncUntil(bob, (s) => timeline(s, synapseRoom).find((e) => e.content?.body === "joined from ours"), "alice's message on Synapse");
});

await scenario("Media in both directions (authenticated media over federation)", async () => {
  const bytes = randomBytes(2048);
  for (const [up, down] of [
    [alice, bob],
    [bob, alice],
  ] as const) {
    const { content_uri } = await call(up.base, "POST", "/_matrix/media/v3/upload?filename=x.bin", bytes, up.token, true);
    const [, server, id] = /^mxc:\/\/([^/]+)\/(.+)$/.exec(content_uri)!;
    const got = await call(down.base, "GET", `/_matrix/client/v1/media/download/${server}/${id}`, undefined, down.token, true);
    check(Buffer.compare(Buffer.from(got), bytes) === 0, `${content_uri}: ${got.length} bytes, not the uploaded ones`);
  }
});

await scenario("Profiles across servers", async () => {
  await api(alice, "PUT", `/profile/${encodeURIComponent(alice.userId)}/displayname`, { displayname: "Alice Ours" });
  await until(
    async () => ((await api(bob, "GET", `/profile/${encodeURIComponent(alice.userId)}`)).displayname === "Alice Ours" ? true : undefined),
    "alice's profile on Synapse",
  );
  await api(bob, "PUT", `/profile/${encodeURIComponent(bob.userId)}/displayname`, { displayname: "Bob Synapse" });
  await until(
    async () => ((await api(alice, "GET", `/profile/${encodeURIComponent(bob.userId)}`)).displayname === "Bob Synapse" ? true : undefined),
    "bob's profile here",
  );
});

await scenario("Leave and rejoin", async () => {
  await api(bob, "POST", `${room(oursRoom)}/leave`, {});
  await syncUntil(
    alice,
    (s) => timeline(s, oursRoom).find((e) => e.state_key === bob.userId && e.content.membership === "leave"),
    "bob's leave",
  );
  await api(bob, "POST", `/join/${encodeURIComponent(oursRoom)}?via=ours.test`, {});
  await syncUntil(
    alice,
    (s) => timeline(s, oursRoom).find((e) => e.state_key === bob.userId && e.content.membership === "join"),
    "bob's rejoin",
  );
});

await scenario("End-to-end encryption both ways (matrix-rust-sdk crypto)", async () => {
  const e2eRoom = (
    await api(alice, "POST", "/createRoom", {
      preset: "private_chat",
      invite: [bob.userId],
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    })
  ).room_id;
  await syncUntil(bob, (s) => s.rooms?.invite?.[e2eRoom], "the invite");
  await api(bob, "POST", `/join/${encodeURIComponent(e2eRoom)}`, {});
  const crypto = new Map<Account, CryptoClient>();
  for (const a of [alice, bob]) {
    const c = new CryptoClient({ fetch: (r) => fetch(r), baseUrl: a.base, userId: a.userId, deviceId: a.deviceId, accessToken: a.token });
    await c.open();
    await c.flush();
    crypto.set(a, c);
  }
  try {
    for (const [from, to] of [
      [alice, bob],
      [bob, alice],
    ] as const) {
      const text = `secret from ${from === alice ? "ours" : "synapse"}`;
      const eventId = await crypto.get(from)!.sendEncrypted(e2eRoom, [alice.userId, bob.userId], { msgtype: "m.text", body: text });
      const receiver = crypto.get(to)!;
      const clear = await syncUntil(
        to,
        (s) => {
          void receiver.receiveSync(s);
          return timeline(s, e2eRoom).find((e) => e.event_id === eventId);
        },
        "the encrypted message",
      );
      const decrypted = await until(async () => JSON.parse((await receiver.decrypt(clear, e2eRoom)).event), "the room key");
      check(decrypted.content.body === text, `decrypted: ${JSON.stringify(decrypted.content)}`);
    }
  } finally {
    for (const c of crypto.values()) c.close();
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`### Interoperability: ${versions[0]} ↔ ${versions[1]}\n`);
console.log(`${results.length - failed.length} of ${results.length} scenarios passed.\n`);
console.log("| Scenario | Result | Time |\n|---|---|---|");
for (const r of results)
  console.log(`| ${r.name} | ${r.ok ? "pass" : `**fail**: ${r.detail.replaceAll("|", "\\|")}`} | ${(r.ms / 1000).toFixed(1)} s |`);
process.exit(failed.length ? 1 : 0);
