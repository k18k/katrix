// k6 load test for the homeserver (see loadtest/README.md).
//
// Two kinds of virtual users in ROOMS shared rooms:
// - "online" users, each with its own account, hold a long-polling /sync open, as idle clients
//   do, and measure how long a message takes from being sent to reaching them (message_delivery);
// - "chat" users send MESSAGES_PER_SECOND messages in total, spread over the rooms, as one
//   sender account per room, registered and joined in setup().
// Online users ramp up over RAMP, then everything runs for DURATION.
import http from "k6/http";
import { check, fail, sleep } from "k6";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:8008";
const ONLINE = Number(__ENV.ONLINE_USERS || 100);
const RATE = Number(__ENV.MESSAGES_PER_SECOND || 10);
const ROOMS = Number(__ENV.ROOMS || 10);
const RAMP = __ENV.RAMP || "1m";
const DURATION = __ENV.DURATION || "2m";
const SYNC_TIMEOUT_MS = 30000;

const delivery = new Trend("message_delivery", true);
const received = new Counter("messages_received");
// Messages the server accepted. The chat scenario asks for MESSAGES_PER_SECOND × DURATION; when
// sends are slow, k6 runs out of senders and skips some (dropped_iterations), and the run then
// measured a lighter load than asked for. The summary and the badges report the share that got in.
const sent = new Counter("messages_sent");

export const options = {
  scenarios: {
    online: {
      executor: "ramping-vus",
      exec: "online",
      startVUs: 0,
      stages: [
        { duration: RAMP, target: ONLINE },
        { duration: DURATION, target: ONLINE },
      ],
      gracefulRampDown: "40s",
      gracefulStop: "40s",
    },
    chat: {
      executor: "constant-arrival-rate",
      exec: "chat",
      startTime: RAMP,
      duration: DURATION,
      rate: RATE,
      timeUnit: "1s",
      preAllocatedVUs: Math.max(1, Math.ceil(RATE / 2)),
      maxVUs: Math.max(10, RATE * 5),
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:send}": ["p(95)<1000"],
    // Listed so that the summary breaks these requests out; the limits are loose on purpose.
    "http_req_duration{name:register}": ["p(95)<60000"],
    "http_req_duration{name:join}": ["p(95)<60000"],
    "http_req_duration{name:initial_sync}": ["p(95)<60000"],
    "http_req_duration{name:sync}": ["p(95)<60000"],
    messages_received: ["count>=0"],
    messages_sent: ["count>=0"],
    message_delivery: ["p(95)<3000"],
    checks: ["rate>0.99"],
  },
  setupTimeout: "10m",
  // The default summary plus these percentiles.
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const auth = (token, extra = {}) => ({ headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...extra });

/** Register through the client API (dummy auth), as a client would. Returns null on failure. */
function register(username) {
  const params = { headers: { "content-type": "application/json" }, tags: { name: "register" } };
  const url = `${BASE}/_matrix/client/v3/register`;
  const first = http.post(url, JSON.stringify({ username, password: "loadtest" }), {
    ...params,
    responseCallback: http.expectedStatuses(401),
  });
  if (first.status !== 401) return null;
  const res = http.post(
    url,
    JSON.stringify({ username, password: "loadtest", auth: { type: "m.login.dummy", session: first.json("session") } }),
    params,
  );
  if (!check(res, { registered: (r) => r.status === 200 })) return null;
  return res.json("access_token");
}

/** Once per run (per k6 instance): a run ID for unique user names, and the shared rooms. */
export function setup() {
  // The server (or the load balancer in front of it) may still be starting: wait for it, so a slow
  // start is not reported as a failed run.
  for (
    let i = 0;
    i < 60 && http.get(`${BASE}/_matrix/client/versions`, { responseCallback: http.expectedStatuses(200, 0, 502, 503) }).status !== 200;
    i++
  )
    sleep(1);
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const token = register(`lt_${run}_owner`);
  if (!token) fail("could not register the room owner");
  const rooms = [];
  for (let i = 0; i < ROOMS; i++) {
    const res = http.post(
      `${BASE}/_matrix/client/v3/createRoom`,
      JSON.stringify({ preset: "public_chat", name: `load ${i}` }),
      auth(token),
    );
    if (res.status !== 200) fail(`createRoom failed: ${res.status} ${res.body}`);
    rooms.push(res.json("room_id"));
  }
  // The senders exist before the chat phase, so it consists of sends only and every run puts
  // the same load on the server. Senders made on first use registered and joined during the
  // measurement, and k6 skipped sends while they did, more so the slower the server was.
  const senders = [];
  for (let i = 0; i < ROOMS; i++) {
    const sender = register(`lt_${run}_chat_${i}`);
    if (!sender) fail("could not register a sender");
    const join = http.post(
      `${BASE}/_matrix/client/v3/join/${encodeURIComponent(rooms[i])}`,
      "{}",
      auth(sender, { tags: { name: "join" } }),
    );
    if (join.status !== 200) fail(`sender join failed: ${join.status} ${join.body}`);
    senders.push(sender);
  }
  return { run, rooms, senders };
}

// Each VU has its own JavaScript runtime, so these are per virtual user.
let me = null;
let attempts = 0;

/** This VU's account, registered and joined on first use; null (after a pause) if that failed. */
function account(data, kind) {
  if (me) return me;
  const vu = exec.vu.idInTest;
  // A retry uses a new name: the failed attempt may have created the account after the client gave up.
  const token = register(`lt_${data.run}_${kind}_${vu}_${attempts++}`);
  const room = data.rooms[vu % data.rooms.length];
  const join =
    token && http.post(`${BASE}/_matrix/client/v3/join/${encodeURIComponent(room)}`, "{}", auth(token, { tags: { name: "join" } }));
  if (!join || !check(join, { joined: (r) => r.status === 200 })) {
    sleep(1);
    return null;
  }
  me = { token, room, since: null, txn: 0 };
  return me;
}

export function online(data) {
  const u = account(data, "online");
  if (!u) return;
  const params = { timeout: SYNC_TIMEOUT_MS + 15000 };
  // The first sync returns the room's recent history; only later ones carry new messages.
  const url = u.since
    ? `${BASE}/_matrix/client/v3/sync?timeout=${SYNC_TIMEOUT_MS}&since=${encodeURIComponent(u.since)}`
    : `${BASE}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 } } }))}`;
  const res = http.get(url, auth(u.token, { ...params, tags: { name: u.since ? "sync" : "initial_sync" } }));
  if (!check(res, { synced: (r) => r.status === 200 })) return;
  const body = res.json();
  if (u.since) {
    const now = Date.now();
    for (const room of Object.values(body.rooms?.join ?? {})) {
      for (const ev of room.timeline?.events ?? []) {
        if (ev.type === "m.room.message" && typeof ev.content?.sent === "number") {
          delivery.add(now - ev.content.sent);
          received.add(1);
        }
      }
    }
  }
  u.since = body.next_batch;
}

let sends = 0;

export function chat(data) {
  // Each message goes to the next room, from that room's sender; transaction IDs are unique per VU.
  const i = (exec.vu.idInTest + sends) % data.rooms.length;
  const txn = `${exec.vu.idInTest}-${sends++}`;
  const res = http.put(
    `${BASE}/_matrix/client/v3/rooms/${encodeURIComponent(data.rooms[i])}/send/m.room.message/${txn}`,
    JSON.stringify({ msgtype: "m.text", body: "load test", sent: Date.now() }),
    auth(data.senders[i], { tags: { name: "send" } }),
  );
  if (check(res, { sent: (r) => r.status === 200 })) sent.add(1);
}
