import { M } from "../packages/shared/src/m.js";
import { authEventKeys, checkAuth, powerLevels, userLevel } from "./authrules.js";
import { eventIdOf, roomVersionFeatures, stateKey } from "./events.js";
// src/core/stateres.ts
const isPowerEvent = (ev) => ev.type === M.ROOM.POWER_LEVELS && ev.state_key === "" || ev.type === M.ROOM.JOIN_RULES && ev.state_key === "" || ev.type === M.ROOM.CREATE && ev.state_key === "" || ev.type === M.ROOM.MEMBER && (ev.content?.membership === "leave" || ev.content?.membership === "ban") && ev.sender !== ev.state_key;
const authIds = (ev) => (ev.auth_events ?? []).map(eventIdOf);
var EventCache = class {
	events = /* @__PURE__ */ new Map();
	source;
	constructor(source) {
		this.source = source;
	}
	async load(ids) {
		const missing = [...ids].filter((id) => !this.events.has(id));
		if (!missing.length) return;
		for (const [id, ev] of await this.source(missing)) this.events.set(id, ev);
	}
	get(id) {
		return this.events.get(id);
	}
	/** All auth ancestors of the given events (not including them). */
	async authChain(ids) {
		const chain = /* @__PURE__ */ new Set();
		let frontier = [...ids];
		while (frontier.length) {
			await this.load(frontier);
			const next = [];
			for (const id of frontier) {
				const ev = this.get(id);
				if (!ev) continue;
				for (const a of authIds(ev)) if (!chain.has(a)) {
					chain.add(a);
					next.push(a);
				}
			}
			frontier = next;
		}
		return chain;
	}
};
/**
* State resolution v2 (and v2.1 for room version 12).
* `createEvent` is required for v12, where the create event is not in auth_events.
*/
async function resolveState(stateSets, roomVersion, source, createEvent) {
	if (stateSets.length === 0) return {};
	if (stateSets.length === 1) return { ...stateSets[0] };
	const v21 = roomVersionFeatures(roomVersion).v12;
	const cache = new EventCache(source);
	const keys = new Set(stateSets.flatMap((s) => Object.keys(s)));
	const unconflicted = {};
	const conflicted = /* @__PURE__ */ new Set();
	for (const key of keys) {
		const values = stateSets.map((s) => s[key]);
		if (values.every((v) => v !== void 0 && v === values[0])) unconflicted[key] = values[0];
		else for (const v of values) if (v !== void 0) conflicted.add(v);
	}
	if (conflicted.size === 0) return unconflicted;
	const chains = await Promise.all(stateSets.map((s) => cache.authChain(Object.values(s))));
	const authDifference = [...new Set(chains.flatMap((c) => [...c]))].filter((id) => !chains.every((c) => c.has(id)));
	const full = /* @__PURE__ */ new Set([...conflicted, ...authDifference]);
	if (v21) for (const id of await conflictedSubgraph(cache, conflicted)) full.add(id);
	await cache.load(full);
	for (const id of [...full]) if (!cache.get(id)) full.delete(id);
	const powerEvents = [...full].filter((id) => isPowerEvent(cache.get(id)));
	const control = new Set(powerEvents);
	for (const id of await cache.authChain(powerEvents)) if (full.has(id)) control.add(id);
	let resolved = await iterativeAuthChecks(cache, await reverseTopologicalPowerSort(cache, control, roomVersion, createEvent), v21 ? {} : { ...unconflicted }, roomVersion, createEvent);
	const remaining = [...full].filter((id) => !control.has(id));
	const mainline = await mainlineOf(cache, resolved[stateKey(M.ROOM.POWER_LEVELS, "")]);
	const positions = /* @__PURE__ */ new Map();
	for (const id of remaining) positions.set(id, await mainlinePosition(cache, id, mainline));
	remaining.sort((a, b) => {
		const ea = cache.get(a);
		const eb = cache.get(b);
		return positions.get(a) - positions.get(b) || ea.origin_server_ts - eb.origin_server_ts || (a < b ? -1 : a > b ? 1 : 0);
	});
	resolved = await iterativeAuthChecks(cache, remaining, resolved, roomVersion, createEvent);
	return {
		...resolved,
		...unconflicted
	};
}
/** v2.1: events on auth paths between two conflicted events. */
async function conflictedSubgraph(cache, conflicted) {
	const ancestors = await cache.authChain(conflicted);
	await cache.load(ancestors);
	const memo = /* @__PURE__ */ new Map();
	const reachesConflicted = (id, seen = /* @__PURE__ */ new Set()) => {
		const cached = memo.get(id);
		if (cached !== void 0) return cached;
		if (seen.has(id)) return false;
		seen.add(id);
		const ev = cache.get(id);
		const result = !!ev && authIds(ev).some((a) => conflicted.has(a) || reachesConflicted(a, seen));
		memo.set(id, result);
		return result;
	};
	const out = /* @__PURE__ */ new Set();
	for (const id of ancestors) if (!conflicted.has(id) && reachesConflicted(id)) out.add(id);
	return out;
}
/** Power level of an event's sender according to its own auth events. */
async function senderPowerLevel(cache, ev, roomVersion, createEvent) {
	await cache.load(authIds(ev));
	const state = /* @__PURE__ */ new Map();
	for (const id of authIds(ev)) {
		const a = cache.get(id);
		if (a && a.state_key !== void 0) state.set(stateKey(a.type, a.state_key), a);
	}
	if (createEvent) state.set(stateKey(M.ROOM.CREATE, ""), createEvent);
	const level = userLevel(powerLevels(state, roomVersion), ev.sender);
	return Number.isFinite(level) ? level : Number.MAX_SAFE_INTEGER;
}
async function reverseTopologicalPowerSort(cache, ids, roomVersion, createEvent) {
	const levels = /* @__PURE__ */ new Map();
	for (const id of ids) levels.set(id, await senderPowerLevel(cache, cache.get(id), roomVersion, createEvent));
	const pending = /* @__PURE__ */ new Map();
	const dependents = /* @__PURE__ */ new Map();
	for (const id of ids) {
		const deps = new Set(authIds(cache.get(id)).filter((a) => ids.has(a)));
		pending.set(id, deps);
		for (const d of deps) (dependents.get(d) ?? dependents.set(d, []).get(d)).push(id);
	}
	const compare = (a, b) => {
		const ea = cache.get(a);
		const eb = cache.get(b);
		return levels.get(b) - levels.get(a) || ea.origin_server_ts - eb.origin_server_ts || (a < b ? -1 : a > b ? 1 : 0);
	};
	const ready = [...ids].filter((id) => pending.get(id).size === 0).sort(compare);
	const out = [];
	while (ready.length) {
		const id = ready.shift();
		out.push(id);
		for (const dep of dependents.get(id) ?? []) {
			const p = pending.get(dep);
			p.delete(id);
			if (p.size === 0) {
				ready.push(dep);
				ready.sort(compare);
			}
		}
	}
	return out;
}
async function iterativeAuthChecks(cache, ids, base, roomVersion, createEvent) {
	const state = { ...base };
	for (const id of ids) {
		const ev = cache.get(id);
		if (!ev || ev.state_key === void 0) continue;
		await cache.load(authIds(ev));
		const authState = /* @__PURE__ */ new Map();
		for (const aid of authIds(ev)) {
			const a = cache.get(aid);
			if (a && a.state_key !== void 0) authState.set(stateKey(a.type, a.state_key), a);
		}
		const keys = authEventKeys(ev, roomVersion);
		await cache.load(keys.map((k) => state[k]).filter(Boolean));
		for (const k of keys) {
			const sid = state[k];
			const sev = sid ? cache.get(sid) : void 0;
			if (sev) authState.set(k, sev);
		}
		if (createEvent) authState.set(stateKey(M.ROOM.CREATE, ""), createEvent);
		try {
			checkAuth(ev, authState, roomVersion);
			state[stateKey(ev.type, ev.state_key)] = id;
		} catch {}
	}
	return state;
}
async function mainlineOf(cache, plId) {
	const chain = [];
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
	const positions = /* @__PURE__ */ new Map();
	chain.reverse().forEach((id, i) => positions.set(id, i + 1));
	return positions;
}
async function mainlinePosition(cache, id, mainline) {
	let current = id;
	const seen = /* @__PURE__ */ new Set();
	while (current && !seen.has(current)) {
		seen.add(current);
		const pos = mainline.get(current);
		if (pos !== void 0) return pos;
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
export { resolveState };

//# sourceMappingURL=stateres.js.map