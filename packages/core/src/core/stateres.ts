import { authEventKeys, checkAuth, powerLevels, userLevel, type StateMap } from "./authrules.ts";
import { eventIdOf, roomVersionFeatures, stateKey, type PDU } from "./events.ts";
import { M } from "./m.ts";

/** Event lookup used by state resolution (timeline events and outliers). */
export type EventSource = (eventIds: string[]) => Promise<Map<string, PDU>>;

/** A state map of (type, state_key) → event ID. */
export type StateIds = Record<string, string>;

const isPowerEvent = (ev: PDU) =>
  (ev.type === M.ROOM.POWER_LEVELS && ev.state_key === "") ||
  (ev.type === M.ROOM.JOIN_RULES && ev.state_key === "") ||
  (ev.type === M.ROOM.CREATE && ev.state_key === "") ||
  (ev.type === M.ROOM.MEMBER && ["leave", "ban"].includes(ev.content?.membership) && ev.sender !== ev.state_key);

const authIds = (ev: PDU) => (ev.auth_events ?? []).map(eventIdOf);

class EventCache {
  private events = new Map<string, PDU>();
  private source: EventSource;
  constructor(source: EventSource) {
    this.source = source;
  }

  async load(ids: Iterable<string>): Promise<void> {
    const missing = [...ids].filter((id) => !this.events.has(id));
    if (!missing.length) return;
    for (const [id, ev] of await this.source(missing)) this.events.set(id, ev);
  }
  get(id: string): PDU | undefined {
    return this.events.get(id);
  }

  /** All auth ancestors of the given events (not including them). */
  async authChain(ids: Iterable<string>): Promise<Set<string>> {
    const chain = new Set<string>();
    let frontier = [...ids];
    while (frontier.length) {
      await this.load(frontier);
      const next: string[] = [];
      for (const id of frontier) {
        const ev = this.get(id);
        if (!ev) continue;
        for (const a of authIds(ev))
          if (!chain.has(a)) {
            chain.add(a);
            next.push(a);
          }
      }
      frontier = next;
    }
    return chain;
  }
}

/**
 * State resolution v2 (and v2.1 for room version 12).
 * `createEvent` is required for v12, where the create event is not in auth_events.
 */
export async function resolveState(stateSets: StateIds[], roomVersion: string, source: EventSource, createEvent?: PDU): Promise<StateIds> {
  if (stateSets.length === 0) return {};
  if (stateSets.length === 1) return { ...stateSets[0] };
  const v21 = roomVersionFeatures(roomVersion).v12;
  const cache = new EventCache(source);

  // 1. Unconflicted and conflicted state.
  const keys = new Set(stateSets.flatMap((s) => Object.keys(s)));
  const unconflicted: StateIds = {};
  const conflicted = new Set<string>();
  for (const key of keys) {
    const values = stateSets.map((s) => s[key]);
    if (values.every((v) => v !== undefined && v === values[0])) unconflicted[key] = values[0]!;
    else for (const v of values) if (v !== undefined) conflicted.add(v);
  }
  if (conflicted.size === 0) return unconflicted;

  // 2. Auth difference (+ conflicted subgraph for v2.1).
  const chains = await Promise.all(stateSets.map((s) => cache.authChain(Object.values(s))));
  const union = new Set(chains.flatMap((c) => [...c]));
  const authDifference = [...union].filter((id) => !chains.every((c) => c.has(id)));
  const full = new Set<string>([...conflicted, ...authDifference]);
  if (v21) for (const id of await conflictedSubgraph(cache, conflicted)) full.add(id);
  await cache.load(full);
  // oxlint-disable-next-line unicorn/no-useless-spread -- copy on purpose: the loop removes entries
  for (const id of [...full]) if (!cache.get(id)) full.delete(id);

  // 3. Control events, in reverse topological power ordering.
  const powerEvents = [...full].filter((id) => isPowerEvent(cache.get(id)!));
  const control = new Set(powerEvents);
  for (const id of await cache.authChain(powerEvents)) if (full.has(id)) control.add(id);
  const sortedControl = await reverseTopologicalPowerSort(cache, control, roomVersion, createEvent);

  // 4. Iterative auth checks on the control events.
  let resolved = await iterativeAuthChecks(cache, sortedControl, v21 ? {} : { ...unconflicted }, roomVersion, createEvent);

  // 5. Remaining events, in mainline order.
  const remaining = [...full].filter((id) => !control.has(id));
  const mainline = await mainlineOf(cache, resolved[stateKey(M.ROOM.POWER_LEVELS, "")]);
  const positions = new Map<string, number>();
  for (const id of remaining) positions.set(id, await mainlinePosition(cache, id, mainline));
  remaining.sort((a, b) => {
    const ea = cache.get(a)!;
    const eb = cache.get(b)!;
    return positions.get(a)! - positions.get(b)! || ea.origin_server_ts - eb.origin_server_ts || (a < b ? -1 : a > b ? 1 : 0);
  });
  resolved = await iterativeAuthChecks(cache, remaining, resolved, roomVersion, createEvent);

  // 6. Unconflicted state always wins.
  return { ...resolved, ...unconflicted };
}

/** v2.1: events on auth paths between two conflicted events. */
async function conflictedSubgraph(cache: EventCache, conflicted: Set<string>): Promise<Set<string>> {
  const ancestors = await cache.authChain(conflicted);
  await cache.load(ancestors);
  const memo = new Map<string, boolean>();
  const reachesConflicted = (id: string, seen = new Set<string>()): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return false;
    seen.add(id);
    const ev = cache.get(id);
    const result = !!ev && authIds(ev).some((a) => conflicted.has(a) || reachesConflicted(a, seen));
    memo.set(id, result);
    return result;
  };
  const out = new Set<string>();
  for (const id of ancestors) if (!conflicted.has(id) && reachesConflicted(id)) out.add(id);
  return out;
}

/** Power level of an event's sender according to its own auth events. */
async function senderPowerLevel(cache: EventCache, ev: PDU, roomVersion: string, createEvent?: PDU): Promise<number> {
  await cache.load(authIds(ev));
  const state: StateMap = new Map();
  for (const id of authIds(ev)) {
    const a = cache.get(id);
    if (a && a.state_key !== undefined) state.set(stateKey(a.type, a.state_key), a);
  }
  if (createEvent) state.set(stateKey(M.ROOM.CREATE, ""), createEvent);
  const level = userLevel(powerLevels(state, roomVersion), ev.sender);
  return Number.isFinite(level) ? level : Number.MAX_SAFE_INTEGER;
}

async function reverseTopologicalPowerSort(cache: EventCache, ids: Set<string>, roomVersion: string, createEvent?: PDU): Promise<string[]> {
  const levels = new Map<string, number>();
  for (const id of ids) levels.set(id, await senderPowerLevel(cache, cache.get(id)!, roomVersion, createEvent));
  // Kahn's algorithm on the auth DAG restricted to `ids`: an event is ready once all its auth events are output.
  const pending = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    const deps = new Set(authIds(cache.get(id)!).filter((a) => ids.has(a)));
    pending.set(id, deps);
    for (const d of deps) (dependents.get(d) ?? dependents.set(d, []).get(d)!).push(id);
  }
  const compare = (a: string, b: string) => {
    const ea = cache.get(a)!;
    const eb = cache.get(b)!;
    return levels.get(b)! - levels.get(a)! || ea.origin_server_ts - eb.origin_server_ts || (a < b ? -1 : a > b ? 1 : 0);
  };
  const ready = [...ids].filter((id) => pending.get(id)!.size === 0).sort(compare);
  const out: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    for (const dep of dependents.get(id) ?? []) {
      const p = pending.get(dep)!;
      p.delete(id);
      if (p.size === 0) {
        ready.push(dep);
        ready.sort(compare);
      }
    }
  }
  return out;
}

async function iterativeAuthChecks(
  cache: EventCache,
  ids: string[],
  base: StateIds,
  roomVersion: string,
  createEvent?: PDU,
): Promise<StateIds> {
  const state: StateIds = { ...base };
  for (const id of ids) {
    const ev = cache.get(id);
    if (!ev || ev.state_key === undefined) continue;
    await cache.load(authIds(ev));
    const authState: StateMap = new Map();
    for (const aid of authIds(ev)) {
      const a = cache.get(aid);
      if (a && a.state_key !== undefined) authState.set(stateKey(a.type, a.state_key), a);
    }
    // Entries in the partially resolved state take precedence over the event's own auth events.
    const keys = authEventKeys(ev, roomVersion);
    await cache.load(keys.map((k) => state[k]).filter(Boolean));
    for (const k of keys) {
      const sid = state[k];
      const sev = sid ? cache.get(sid) : undefined;
      if (sev) authState.set(k, sev);
    }
    if (createEvent) authState.set(stateKey(M.ROOM.CREATE, ""), createEvent);
    try {
      checkAuth(ev, authState, roomVersion);
      state[stateKey(ev.type, ev.state_key)] = id;
    } catch {
      // Events failing auth are dropped from the resolved state.
    }
  }
  return state;
}

async function mainlineOf(cache: EventCache, plId: string | undefined): Promise<Map<string, number>> {
  const chain: string[] = [];
  let current = plId;
  while (current) {
    chain.push(current);
    await cache.load([current]);
    const ev = cache.get(current);
    if (!ev) break;
    await cache.load(authIds(ev));
    current = authIds(ev).find((a) => {
      const e = cache.get(a);
      return e?.type === M.ROOM.POWER_LEVELS && e.state_key === "";
    });
  }
  // The oldest power levels event gets the lowest position.
  const positions = new Map<string, number>();
  chain.reverse().forEach((id, i) => positions.set(id, i + 1));
  return positions;
}

async function mainlinePosition(cache: EventCache, id: string, mainline: Map<string, number>): Promise<number> {
  let current: string | undefined = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const pos = mainline.get(current);
    if (pos !== undefined) return pos;
    await cache.load([current]);
    const ev = cache.get(current);
    if (!ev) return 0;
    await cache.load(authIds(ev));
    current = authIds(ev).find((a) => {
      const e = cache.get(a);
      return e?.type === M.ROOM.POWER_LEVELS && e.state_key === "";
    });
  }
  return 0;
}
