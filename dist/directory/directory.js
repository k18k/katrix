import { MatrixError } from "../http/errors.js";
// src/directory/directory.ts
/**
* Finding rooms and users: room aliases, the public room directory, room summaries, the user
* directory and third-party networks (bridges).
*/
var DirectoryApi = class {
	api;
	constructor(api) {
		this.api = api;
	}
	/** The room an alias points to and servers to join it through; undefined when the alias is unknown. */
	async resolveAlias(alias) {
		try {
			const res = await this.api.endpoint("GET /v3/directory/room/:roomAlias", { roomAlias: alias }, {});
			if (typeof res.room_id !== "string") return void 0;
			return {
				roomId: res.room_id,
				servers: Array.isArray(res.servers) ? res.servers : []
			};
		} catch (e) {
			if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return void 0;
			throw e;
		}
	}
	/** Point a local alias at a room (it is not published in m.room.canonical_alias by this alone). */
	async createAlias(alias, roomId) {
		await this.api.endpoint("PUT /v3/directory/room/:roomAlias", { roomAlias: alias }, { body: { room_id: roomId } });
	}
	async deleteAlias(alias) {
		await this.api.endpoint("DELETE /v3/directory/room/:roomAlias", { roomAlias: alias }, {});
	}
	/** The local aliases of a room on this server. */
	async roomAliases(roomId) {
		return (await this.api.endpoint("GET /v3/rooms/:roomId/aliases", { roomId }, {})).aliases ?? [];
	}
	async getVisibility(roomId) {
		return (await this.api.endpoint("GET /v3/directory/list/room/:roomId", { roomId }, {})).visibility ?? "private";
	}
	async setVisibility(roomId, visibility) {
		await this.api.endpoint("PUT /v3/directory/list/room/:roomId", { roomId }, { body: { visibility } });
	}
	/** As an application service: publish a room in the directory of one of its third-party networks. */
	async setAppserviceVisibility(networkId, roomId, visibility) {
		await this.api.endpoint("PUT /v3/directory/list/appservice/:networkId/:roomId", {
			networkId,
			roomId
		}, { body: { visibility } });
	}
	/**
	* One page of public rooms, of this server or of `server`. With a search term, room types or
	* third-party networks the request is a POST (the filtered form); otherwise a GET.
	*/
	publicRooms(opts = {}) {
		if (opts.searchTerm === void 0 && opts.roomTypes === void 0 && !opts.includeAllNetworks && !opts.thirdPartyInstanceId) return this.api.endpoint("GET /v3/publicRooms", {}, { query: {
			server: opts.server,
			limit: opts.limit,
			since: opts.since
		} });
		const body = {
			limit: opts.limit,
			since: opts.since,
			filter: opts.searchTerm !== void 0 || opts.roomTypes ? {
				generic_search_term: opts.searchTerm,
				room_types: opts.roomTypes
			} : void 0,
			include_all_networks: opts.includeAllNetworks,
			third_party_instance_id: opts.thirdPartyInstanceId
		};
		return this.api.endpoint("POST /v3/publicRooms", {}, {
			query: { server: opts.server },
			body
		});
	}
	/**
	* What a room is, before joining it: name, topic, members, join rule, and this user's
	* membership (https://spec.matrix.org/v1.19/client-server-api/#get_matrixclientv1room_summaryroomidoralias).
	*/
	roomSummary(roomIdOrAlias, via) {
		return this.api.endpoint("GET /v1/room_summary/:roomIdOrAlias", { roomIdOrAlias }, { query: { via } });
	}
	searchUsers(term, limit) {
		return this.api.endpoint("POST /v3/user_directory/search", {}, { body: {
			search_term: term,
			limit
		} });
	}
	thirdPartyProtocols() {
		return this.api.endpoint("GET /v3/thirdparty/protocols", {}, {});
	}
	thirdPartyProtocol(protocol) {
		return this.api.endpoint("GET /v3/thirdparty/protocol/:protocol", { protocol }, {});
	}
	/** Portal rooms of a protocol whose fields match (the protocol's `location_fields`). */
	thirdPartyLocations(protocol, fields = {}) {
		return this.api.endpoint("GET /v3/thirdparty/location/:protocol", { protocol }, { query: fields });
	}
	/** Remote users of a protocol whose fields match (the protocol's `user_fields`). */
	thirdPartyUsers(protocol, fields = {}) {
		return this.api.endpoint("GET /v3/thirdparty/user/:protocol", { protocol }, { query: fields });
	}
	/** The third-party locations a Matrix room alias stands for. */
	thirdPartyLocationsForAlias(alias) {
		return this.api.endpoint("GET /v3/thirdparty/location", {}, { query: { alias } });
	}
	/** The third-party users a Matrix user ID stands for. */
	thirdPartyUsersForUserId(userId) {
		return this.api.endpoint("GET /v3/thirdparty/user", {}, { query: { userid: userId } });
	}
};
export { DirectoryApi };

//# sourceMappingURL=directory.js.map