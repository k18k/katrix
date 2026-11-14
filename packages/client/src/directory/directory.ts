import type { MatrixHttpApi } from "../http/api.ts";
import { MatrixError } from "../http/errors.ts";
import type { PublicRoomsRequest } from "@katrix/shared";

/**
 * Finding rooms and users: room aliases, the public room directory, room summaries, the user
 * directory and third-party networks (bridges).
 */
export class DirectoryApi {
  private readonly api: MatrixHttpApi;

  constructor(api: MatrixHttpApi) {
    this.api = api;
  }

  // ─── Aliases (https://spec.matrix.org/v1.19/client-server-api/#room-aliases) ──

  /** The room an alias points to and servers to join it through; undefined when the alias is unknown. */
  async resolveAlias(alias: string) {
    try {
      const res = await this.api.endpoint("GET /v3/directory/room/:roomAlias", { roomAlias: alias }, {});
      if (typeof res.room_id !== "string") return undefined;
      return { roomId: res.room_id, servers: Array.isArray(res.servers) ? res.servers : [] };
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return undefined;
      throw e;
    }
  }

  /** Point a local alias at a room (it is not published in m.room.canonical_alias by this alone). */
  async createAlias(alias: string, roomId: string) {
    await this.api.endpoint("PUT /v3/directory/room/:roomAlias", { roomAlias: alias }, { body: { room_id: roomId } });
  }

  async deleteAlias(alias: string) {
    await this.api.endpoint("DELETE /v3/directory/room/:roomAlias", { roomAlias: alias }, {});
  }

  /** The local aliases of a room on this server. */
  async roomAliases(roomId: string) {
    return (await this.api.endpoint("GET /v3/rooms/:roomId/aliases", { roomId }, {})).aliases ?? [];
  }

  // ─── The public room directory (https://spec.matrix.org/v1.19/client-server-api/#listing-rooms) ──

  async getVisibility(roomId: string) {
    return (await this.api.endpoint("GET /v3/directory/list/room/:roomId", { roomId }, {})).visibility ?? "private";
  }

  async setVisibility(roomId: string, visibility: "public" | "private") {
    await this.api.endpoint("PUT /v3/directory/list/room/:roomId", { roomId }, { body: { visibility } });
  }

  /** As an application service: publish a room in the directory of one of its third-party networks. */
  async setAppserviceVisibility(networkId: string, roomId: string, visibility: "public" | "private") {
    await this.api.endpoint("PUT /v3/directory/list/appservice/:networkId/:roomId", { networkId, roomId }, { body: { visibility } });
  }

  /**
   * One page of public rooms, of this server or of `server`. With a search term, room types or
   * third-party networks the request is a POST (the filtered form); otherwise a GET.
   */
  publicRooms(
    opts: {
      server?: string;
      limit?: number;
      since?: string;
      searchTerm?: string;
      roomTypes?: Array<string | null>;
      includeAllNetworks?: boolean;
      thirdPartyInstanceId?: string;
    } = {},
  ) {
    if (opts.searchTerm === undefined && opts.roomTypes === undefined && !opts.includeAllNetworks && !opts.thirdPartyInstanceId) {
      return this.api.endpoint("GET /v3/publicRooms", {}, { query: { server: opts.server, limit: opts.limit, since: opts.since } });
    }
    const body: PublicRoomsRequest = {
      limit: opts.limit,
      since: opts.since,
      filter:
        opts.searchTerm !== undefined || opts.roomTypes ? { generic_search_term: opts.searchTerm, room_types: opts.roomTypes } : undefined,
      include_all_networks: opts.includeAllNetworks,
      third_party_instance_id: opts.thirdPartyInstanceId,
    };
    return this.api.endpoint("POST /v3/publicRooms", {}, { query: { server: opts.server }, body });
  }

  /**
   * What a room is, before joining it: name, topic, members, join rule, and this user's
   * membership (https://spec.matrix.org/v1.19/client-server-api/#get_matrixclientv1room_summaryroomidoralias).
   */
  roomSummary(roomIdOrAlias: string, via?: string[]) {
    return this.api.endpoint("GET /v1/room_summary/:roomIdOrAlias", { roomIdOrAlias }, { query: { via } });
  }

  // ─── Users (https://spec.matrix.org/v1.19/client-server-api/#user-directory) ──

  searchUsers(term: string, limit?: number) {
    return this.api.endpoint("POST /v3/user_directory/search", {}, { body: { search_term: term, limit } });
  }

  // ─── Third-party networks (https://spec.matrix.org/v1.19/client-server-api/#third-party-networks) ──

  thirdPartyProtocols() {
    return this.api.endpoint("GET /v3/thirdparty/protocols", {}, {});
  }

  thirdPartyProtocol(protocol: string) {
    return this.api.endpoint("GET /v3/thirdparty/protocol/:protocol", { protocol }, {});
  }

  /** Portal rooms of a protocol whose fields match (the protocol's `location_fields`). */
  thirdPartyLocations(protocol: string, fields: Record<string, string> = {}) {
    return this.api.endpoint("GET /v3/thirdparty/location/:protocol", { protocol }, { query: fields });
  }

  /** Remote users of a protocol whose fields match (the protocol's `user_fields`). */
  thirdPartyUsers(protocol: string, fields: Record<string, string> = {}) {
    return this.api.endpoint("GET /v3/thirdparty/user/:protocol", { protocol }, { query: fields });
  }

  /** The third-party locations a Matrix room alias stands for. */
  thirdPartyLocationsForAlias(alias: string) {
    return this.api.endpoint("GET /v3/thirdparty/location", {}, { query: { alias } });
  }

  /** The third-party users a Matrix user ID stands for. */
  thirdPartyUsersForUserId(userId: string) {
    return this.api.endpoint("GET /v3/thirdparty/user", {}, { query: { userid: userId } });
  }
}
