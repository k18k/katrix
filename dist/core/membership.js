import { isObject, stringOrUndefined } from "../packages/shared/src/json.js";
import { isValidUserId, parseId } from "../packages/shared/src/ids.js";
import { M } from "../packages/shared/src/m.js";
import { errors } from "./errors.js";
import { finalisePdu, splitStateKey } from "./events.js";
import { getState, membershipOf, powerLevels, userLevel } from "./authrules.js";
import { copyRoomPushRules } from "./pushrules.js";
import { inviteDecision } from "./invitefilter.js";
// src/core/membership.ts
/** The room ID of the room a create event's content says this room replaces. */
function predecessorOf(content) {
	return isObject(content?.predecessor) ? stringOrUndefined(content.predecessor.room_id) : void 0;
}
/** Room membership: resolving a room to join, joins (local and over federation), invites, leaves, kicks, bans, knocks. */
var MembershipService = class {
	hs;
	constructor(hs) {
		this.hs = hs;
	}
	async resolveRoomIdOrAlias(idOrAlias) {
		return (await this.resolveRoom(idOrAlias)).roomId;
	}
	/** Resolve a room ID or alias, including remote aliases; returns candidate servers for joining. */
	async resolveRoom(idOrAlias) {
		if (idOrAlias.startsWith("!")) return {
			roomId: idOrAlias,
			servers: []
		};
		if (idOrAlias.startsWith("#")) {
			const row = await this.hs.db.findOne("room_aliases", [{
				field: "alias",
				value: idOrAlias
			}]);
			if (row) return {
				roomId: row.room_id,
				servers: [this.hs.serverName]
			};
			const fromAppservice = this.hs.isLocalUser(idOrAlias) ? await this.hs.appservices.queryAlias(idOrAlias) : null;
			if (fromAppservice) return {
				roomId: fromAppservice,
				servers: [this.hs.serverName]
			};
			const server = parseId(idOrAlias, "#")?.server;
			if (server && server !== this.hs.serverName && this.hs.federation.enabled) try {
				const res = await this.hs.federation.queryAlias(idOrAlias);
				return {
					roomId: res.room_id,
					servers: res.servers
				};
			} catch {
				throw errors.notFound("Room alias not found");
			}
			throw errors.notFound("Room alias not found");
		}
		throw errors.invalidParam("Invalid room ID or alias");
	}
	/** Servers that might help with a remote membership change for `userId` in `roomId`. */
	async remoteServersFor(roomId, userId, extra = []) {
		const servers = [...extra];
		const row = await this.hs.db.findOne("memberships", [{
			field: "room_id",
			value: roomId
		}, {
			field: "user_id",
			value: userId
		}]);
		const ev = row ? await this.hs.rooms.getPdu(row.event_id) : null;
		if (ev && !this.hs.isLocalUser(ev.sender)) servers.push(ev.sender.slice(ev.sender.indexOf(":") + 1));
		if (!extra.length) {
			const roomServer = parseId(roomId, "!")?.server;
			if (roomServer) servers.push(roomServer);
			if (await this.hs.rooms.exists(roomId)) for (const s of this.hs.federation.serversInRoom(await this.hs.rooms.currentState(roomId))) servers.push(s);
		}
		return [...new Set(servers)].filter((s) => s !== this.hs.serverName);
	}
	async join(userId, roomId, extra = {}) {
		const version = await this.hs.rooms.roomVersion(roomId);
		if ((await this.hs.db.findOne("users", [{
			field: "user_id",
			value: userId
		}]))?.is_guest) {
			if ((version ? getState(await this.hs.rooms.currentState(roomId), M.ROOM.GUEST_ACCESS)?.content?.guest_access : void 0) !== "can_join") throw errors.forbidden("Guest access is not allowed in this room");
		}
		if (version && !await this.hs.rooms.serverIsJoined(roomId) && extra.servers?.includes(this.hs.serverName) && await this.hs.rooms.isLocallyHosted(roomId)) return this.joinLocal(userId, roomId, version, extra);
		if (!version || !await this.hs.rooms.serverIsJoined(roomId)) {
			if (version && await this.hs.rooms.membership(roomId, userId) === "ban") throw errors.forbidden("You are banned from this room");
			const servers = await this.remoteServersFor(roomId, userId, extra.servers);
			if (!servers.length || !this.hs.federation.enabled) {
				if (version) return this.joinLocal(userId, roomId, version, extra);
				throw errors.notFound("Room not found");
			}
			const content = {
				...extra.content,
				membership: "join",
				...await this.hs.profile(userId)
			};
			if (extra.reason) content.reason = extra.reason;
			this.hs.logger.debug("Remote join", userId, roomId, "via", servers);
			await this.hs.federation.joinRemoteRoom(userId, roomId, servers, content);
			const predecessor = predecessorOf((await this.hs.rooms.createEventOf(roomId))?.content);
			if (typeof predecessor === "string") await copyRoomPushRules(this.hs, userId, predecessor, roomId);
			return roomId;
		}
		return this.joinLocal(userId, roomId, version, extra);
	}
	async joinLocal(userId, roomId, version, extra) {
		this.hs.logger.debug("Local join", userId, roomId);
		const state = await this.hs.rooms.currentState(roomId);
		const content = {
			...extra.content,
			membership: "join",
			...await this.hs.profile(userId)
		};
		if (extra.reason) content.reason = extra.reason;
		const existing = getState(state, M.ROOM.MEMBER, userId);
		if (existing?.content?.membership === "join" && JSON.stringify(existing.content) === JSON.stringify(content)) return roomId;
		const joinRule = getState(state, M.ROOM.JOIN_RULES)?.content?.join_rule;
		const current = membershipOf(state, userId);
		if ((joinRule === "restricted" || joinRule === "knock_restricted") && current !== "join" && current !== "invite") {
			const via = await this.findRestrictedAuthoriser(userId, state, version);
			if (via) content.join_authorised_via_users_server = via;
			else if (this.hs.federation.enabled && await this.mayQualifyRemotely(userId, state)) {
				const pl = powerLevels(state, version);
				const servers = /* @__PURE__ */ new Set();
				for (const [k, ev] of state) {
					const [type, member] = splitStateKey(k);
					if (type === M.ROOM.MEMBER && ev.content?.membership === "join" && !this.hs.isLocalUser(member) && userLevel(pl, member) >= pl.invite) servers.add(member.slice(member.indexOf(":") + 1));
				}
				if (servers.size) {
					await this.hs.federation.joinRemoteRoom(userId, roomId, [...servers], content);
					return roomId;
				}
			}
		}
		await this.hs.rooms.sendEvent(roomId, userId, {
			type: M.ROOM.MEMBER,
			state_key: userId,
			content
		});
		const predecessor = predecessorOf(getState(state, M.ROOM.CREATE)?.content);
		if (typeof predecessor === "string") await copyRoomPushRules(this.hs, userId, predecessor, roomId);
		return roomId;
	}
	/** Whether an allowed room exists that we can't check (or the user is joined to), so another server might authorise. */
	async mayQualifyRemotely(userId, state) {
		const allow = getState(state, M.ROOM.JOIN_RULES)?.content?.allow;
		if (!Array.isArray(allow)) return false;
		for (const rule of allow) {
			if (rule?.type !== M.ROOM_MEMBERSHIP || typeof rule.room_id !== "string") continue;
			if (!await this.hs.rooms.serverIsJoined(rule.room_id)) return true;
			if (await this.hs.rooms.membership(rule.room_id, userId) === "join") return true;
		}
		return false;
	}
	async findRestrictedAuthoriser(userId, state, version) {
		const allow = getState(state, M.ROOM.JOIN_RULES)?.content?.allow;
		if (!Array.isArray(allow)) return null;
		let permitted = false;
		for (const rule of allow) if (rule?.type === M.ROOM_MEMBERSHIP && typeof rule.room_id === "string" && await this.hs.rooms.exists(rule.room_id)) {
			if (await this.hs.rooms.membership(rule.room_id, userId) === "join") {
				permitted = true;
				break;
			}
		}
		if (!permitted) return null;
		const pl = powerLevels(state, version);
		for (const [k, ev] of state) {
			const [type, key] = splitStateKey(k);
			if (type === M.ROOM.MEMBER && ev.content?.membership === "join" && this.hs.isLocalUser(key) && userLevel(pl, key) >= pl.invite) return key;
		}
		return null;
	}
	async invite(roomId, sender, target, opts = {}) {
		if (!isValidUserId(target)) throw errors.invalidParam("Invalid user ID");
		const local = this.hs.isLocalUser(target);
		if (local && !await this.hs.db.findOne("users", [{
			field: "user_id",
			value: target
		}]) && !await this.hs.appservices.queryUser(target)) throw errors.notFound("Unknown user");
		if (local && await inviteDecision(this.hs, target, sender) === "block") throw errors.inviteBlocked();
		await this.hs.rooms.requireJoined(roomId, sender);
		const state = await this.hs.rooms.currentState(roomId);
		if (membershipOf(state, target) === "invite") return;
		const content = { membership: "invite" };
		if (local) Object.assign(content, await this.hs.profile(target));
		if (opts.reason) content.reason = opts.reason;
		if (opts.isDirect) content.is_direct = true;
		if (opts.thirdPartyInvite) content.third_party_invite = opts.thirdPartyInvite;
		if (local) {
			await this.hs.rooms.sendEvent(roomId, sender, {
				type: M.ROOM.MEMBER,
				state_key: target,
				content
			});
			return;
		}
		if (!this.hs.federation.enabled) throw errors.forbidden("Federation is disabled");
		await this.hs.rooms.withLock(roomId, async () => {
			const version = await this.hs.rooms.roomVersion(roomId);
			const pdu = await this.hs.rooms.buildLocalEvent(roomId, version, sender, {
				type: M.ROOM.MEMBER,
				state_key: target,
				content
			});
			const inviteState = [...this.hs.rooms.strippedState(await this.hs.rooms.currentState(roomId))];
			const senderMember = getState(await this.hs.rooms.currentState(roomId), M.ROOM.MEMBER, sender);
			if (senderMember) {
				const { unsigned, ...full } = senderMember;
				inviteState.push(this.hs.federation.toFederationPdu(full, version));
			}
			const signed = await this.hs.federation.sendInvite(pdu, version, inviteState);
			await this.hs.rooms.persistEvent(roomId, version, signed, { local: true });
		});
	}
	/** Make this server's guests leave a room that no longer allows guests (spec, guest access module; #87). */
	async removeGuests(roomId) {
		for (const [k, ev] of await this.hs.rooms.currentState(roomId)) {
			const [type, userId] = splitStateKey(k);
			if (type !== M.ROOM.MEMBER || ev.content?.membership !== "join" || !this.hs.isLocalUser(userId)) continue;
			if ((await this.hs.db.findOne("users", [{
				field: "user_id",
				value: userId
			}]))?.is_guest) await this.setMembership(roomId, userId, userId, "leave");
		}
	}
	async setMembership(roomId, sender, target, membership, reason, via = []) {
		const remote = !await this.hs.rooms.serverIsJoined(roomId) && (membership === "knock" || !await this.hs.rooms.isLocallyHosted(roomId));
		if (sender === target && (membership === "leave" || membership === "knock") && remote) {
			await this.remoteMembership(roomId, target, membership, reason, via);
			return;
		}
		if (!await this.hs.rooms.exists(roomId)) throw errors.notFound("Room not found");
		const content = { membership };
		if (reason) content.reason = reason;
		if (membership === "ban" || membership === "leave" && sender !== target) {
			const prev = getState(await this.hs.rooms.currentState(roomId), M.ROOM.MEMBER, target);
			if (prev?.content?.displayname) content.displayname = prev.content.displayname;
		}
		await this.hs.rooms.sendEvent(roomId, sender, {
			type: M.ROOM.MEMBER,
			state_key: target,
			content
		});
	}
	async remoteMembership(roomId, userId, membership, reason, via = []) {
		const row = await this.hs.db.findOne("memberships", [{
			field: "room_id",
			value: roomId
		}, {
			field: "user_id",
			value: userId
		}]);
		if (membership === "leave" && (!row || row.membership === "leave" || row.membership === "ban")) {
			if (!await this.hs.rooms.exists(roomId)) throw errors.notFound("Room not found");
			if (row?.membership === "ban") throw errors.forbidden("You are banned from this room");
			return;
		}
		const servers = await this.remoteServersFor(roomId, userId, via);
		if (membership === "knock") {
			if (!servers.length || !this.hs.federation.enabled) throw errors.notFound("Room not found");
			const { pdu, knockState } = await this.hs.federation.knockRemoteRoom(userId, roomId, servers, reason);
			await this.hs.rooms.recordRemoteMembership({
				...pdu,
				unsigned: { knock_room_state: knockState }
			}, "");
			return;
		}
		let leave;
		try {
			if (!servers.length || !this.hs.federation.enabled) throw new Error("No servers to contact");
			leave = await this.hs.federation.leaveRemoteRoom(userId, roomId, servers, reason);
		} catch (err) {
			this.hs.logger.debug("Remote leave failed, rejecting locally", err);
			const content = { membership: "leave" };
			if (reason) content.reason = reason;
			leave = finalisePdu({
				room_id: roomId,
				sender: userId,
				type: M.ROOM.MEMBER,
				state_key: userId,
				content,
				origin_server_ts: Date.now(),
				depth: 1,
				prev_events: row ? [row.event_id] : [],
				auth_events: []
			}, "10", this.hs.serverName, this.hs.signingKey);
		}
		await this.hs.rooms.recordRemoteMembership(leave, "");
	}
	/** Update the member event in every joined room after a profile change. */
	async propagateProfile(userId) {
		const profile = await this.hs.profile(userId);
		for (const roomId of await this.hs.rooms.roomsForUser(userId)) {
			const prev = getState(await this.hs.rooms.currentState(roomId), M.ROOM.MEMBER, userId);
			if (!prev) continue;
			const { displayname: _d, avatar_url: _a, ...rest } = prev.content;
			const content = {
				...rest,
				membership: "join",
				...profile
			};
			try {
				await this.hs.rooms.sendEvent(roomId, userId, {
					type: M.ROOM.MEMBER,
					state_key: userId,
					content
				});
			} catch (err) {
				this.hs.logger.warn("Failed to propagate profile to", roomId, err);
			}
		}
	}
};
export { MembershipService };

//# sourceMappingURL=membership.js.map