// k6 load test for the homeserver (see loadtest/README.md).
//
// Two kinds of virtual users, each with its own account in one of ROOMS shared rooms:
// - "online" users hold a long-polling /sync open, as idle clients do, and measure how long a
//   message takes from being sent to reaching them (message_delivery);
// - "chat" users send MESSAGES_PER_SECOND messages in total, spread over the rooms.
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
  return { run, rooms };
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

export function chat(data) {
  const u = account(data, "chat");
  if (!u) return;
  const txn = `${exec.vu.idInTest}-${u.txn++}`;
  const res = http.put(
    `${BASE}/_matrix/client/v3/rooms/${encodeURIComponent(u.room)}/send/m.room.message/${txn}`,
    JSON.stringify({ msgtype: "m.text", body: "load test", sent: Date.now() }),
    auth(u.token, { tags: { name: "send" } }),
  );
  check(res, { sent: (r) => r.status === 200 });
}
