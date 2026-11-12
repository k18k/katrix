// src/spaces/spaces.ts
/** The server name of a user ID, the default `via` for rooms of this user's server. */
function serverOf(userId) {
	return userId.slice(userId.indexOf(":") + 1);
}
/** The spec's `order`: up to 50 printable ASCII characters (0x20–0x7E); anything else is ignored. */
function validOrder(order) {
	return typeof order === "string" && order.length <= 50 && /^[\x20-\x7E]*$/.test(order) ? order : void 0;
}
/**
* Spaces (https://spec.matrix.org/v1.19/client-server-api/#spaces): rooms of type m.space whose
* m.space.child state lists the rooms in them, and m.space.parent state in rooms pointing back.
*/
var SpacesApi = class {
	client;
	constructor(client) {
		this.client = client;
	}
	/**
	* Create a space. Only moderators can post messages in it (events_default 50): a space is a
	* list of rooms, not a chat, and other clients set them up the same way.
	*/
	create(opts) {
		return this.client.createRoom({
			name: opts.name,
			topic: opts.topic,
			visibility: opts.visibility,
			preset: opts.visibility === "public" ? "public_chat" : "private_chat",
			invite: opts.invite,
			roomAliasName: opts.roomAliasName,
			creationContent: { type: "m.space" },
			powerLevelContentOverride: { events_default: 50 }
		});
	}
	/**
	* Add a room to a space. `via` are servers to join the room through (default: this user's
	* server). `order` sorts children (printable ASCII, up to 50 characters).
	*/
	async addChild(spaceId, roomId, opts = {}) {
		if (opts.order !== void 0 && validOrder(opts.order) === void 0) throw new Error("order must be at most 50 printable ASCII characters");
		await this.client.sendStateEvent(spaceId, "m.space.child", {
			via: opts.via ?? [serverOf(this.client.userId)],
			...opts.order !== void 0 ? { order: opts.order } : {},
			suggested: opts.suggested ?? false
		}, roomId);
	}
	/** Remove a room from a space (its m.space.child is emptied, as the spec says). */
	async removeChild(spaceId, roomId) {
		await this.client.sendStateEvent(spaceId, "m.space.child", {}, roomId);
	}
	/** Point a room at its space. `canonical` marks the main parent. */
	async setParent(roomId, spaceId, opts = {}) {
		await this.client.sendStateEvent(roomId, "m.space.parent", {
			via: opts.via ?? [serverOf(this.client.userId)],
			canonical: opts.canonical ?? false
		}, spaceId);
	}
	async removeParent(roomId, spaceId) {
		await this.client.sendStateEvent(roomId, "m.space.parent", {}, spaceId);
	}
	/**
	* The children of a synced space, in the spec's order: by `order` (rooms without one last),
	* then by when they were added, then by room ID. Children without `via` were removed.
	*/
	children(spaceId) {
		const room = this.client.getRoom(spaceId);
		if (!room) return [];
		const live = room.state.getAll("m.space.child").filter((e) => Array.isArray(e.content.via) && e.content.via.length > 0);
		live.sort((a, b) => {
			const oa = validOrder(a.content.order);
			const ob = validOrder(b.content.order);
			if (oa !== ob) {
				if (oa === void 0) return 1;
				if (ob === void 0) return -1;
				return oa < ob ? -1 : 1;
			}
			const ta = a.originServerTs ?? 0;
			const tb = b.originServerTs ?? 0;
			if (ta !== tb) return ta - tb;
			return a.stateKey < b.stateKey ? -1 : 1;
		});
		return live.map((e) => ({
			roomId: e.stateKey,
			via: e.content.via,
			order: validOrder(e.content.order),
			suggested: e.content.suggested === true
		}));
	}
	/** The spaces a synced room says it is in (m.space.parent with `via`), canonical first. */
	parents(roomId) {
		const room = this.client.getRoom(roomId);
		if (!room) return [];
		return room.state.getAll("m.space.parent").filter((e) => Array.isArray(e.content.via) && e.content.via.length > 0).map((e) => ({
			spaceId: e.stateKey,
			via: e.content.via,
			canonical: e.content.canonical === true
		})).sort((a, b) => Number(b.canonical) - Number(a.canonical));
	}
	/** One page of a space's hierarchy from the server, depth first, including rooms not joined. */
	hierarchy(spaceId, opts = {}) {
		return this.client.api.endpoint("GET /v1/rooms/:roomId/hierarchy", { roomId: spaceId }, { query: {
			suggested_only: opts.suggestedOnly,
			max_depth: opts.maxDepth,
			limit: opts.limit,
			from: opts.from
		} });
	}
	/** The whole hierarchy (every page, up to `maxRooms`). */
	async fullHierarchy(spaceId, opts = {}) {
		const rooms = [];
		const max = opts.maxRooms ?? 1e3;
		let from;
		do {
			const page = await this.hierarchy(spaceId, {
				suggestedOnly: opts.suggestedOnly,
				maxDepth: opts.maxDepth,
				from
			});
			rooms.push(...page.rooms ?? []);
			from = page.next_batch;
		} while (from && rooms.length < max);
		return rooms.slice(0, max);
	}
};
export { SpacesApi };

//# sourceMappingURL=spaces.js.map