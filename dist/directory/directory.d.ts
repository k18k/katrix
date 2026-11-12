import { PublicRoomsResponse, RoomSummaryResponse, ThirdPartyLocation, ThirdPartyProtocol, ThirdPartyUser, UserDirectorySearchResponse } from "../shared/api/rooms.js";
import { MatrixHttpApi } from "../http/api.js";
/**
 * Finding rooms and users: room aliases, the public room directory, room summaries, the user
 * directory and third-party networks (bridges).
 */
export declare class DirectoryApi {
  private readonly api;
  constructor(api: MatrixHttpApi);
  /** The room an alias points to and servers to join it through; undefined when the alias is unknown. */
  resolveAlias(alias: string): Promise<{
    roomId: string;
    servers: string[];
  } | undefined>;
  /** Point a local alias at a room (it is not published in m.room.canonical_alias by this alone). */
  createAlias(alias: string, roomId: string): Promise<void>;
  deleteAlias(alias: string): Promise<void>;
  /** The local aliases of a room on this server. */
  roomAliases(roomId: string): Promise<string[]>;
  getVisibility(roomId: string): Promise<"public" | "private">;
  setVisibility(roomId: string, visibility: "public" | "private"): Promise<void>;
  /** As an application service: publish a room in the directory of one of its third-party networks. */
  setAppserviceVisibility(networkId: string, roomId: string, visibility: "public" | "private"): Promise<void>;
  /**
   * One page of public rooms, of this server or of `server`. With a search term, room types or
   * third-party networks the request is a POST (the filtered form); otherwise a GET.
   */
  publicRooms(opts?: {
    server?: string;
    limit?: number;
    since?: string;
    searchTerm?: string;
    roomTypes?: Array<string | null>;
    includeAllNetworks?: boolean;
    thirdPartyInstanceId?: string;
  }): Promise<PublicRoomsResponse>;
  /**
   * What a room is, before joining it: name, topic, members, join rule, and this user's
   * membership (https://spec.matrix.org/v1.19/client-server-api/#get_matrixclientv1room_summaryroomidoralias).
   */
  roomSummary(roomIdOrAlias: string, via?: string[]): Promise<RoomSummaryResponse>;
  searchUsers(term: string, limit?: number): Promise<UserDirectorySearchResponse>;
  thirdPartyProtocols(): Promise<Record<string, ThirdPartyProtocol>>;
  thirdPartyProtocol(protocol: string): Promise<ThirdPartyProtocol>;
  /** Portal rooms of a protocol whose fields match (the protocol's `location_fields`). */
  thirdPartyLocations(protocol: string, fields?: Record<string, string>): Promise<ThirdPartyLocation[]>;
  /** Remote users of a protocol whose fields match (the protocol's `user_fields`). */
  thirdPartyUsers(protocol: string, fields?: Record<string, string>): Promise<ThirdPartyUser[]>;
  /** The third-party locations a Matrix room alias stands for. */
  thirdPartyLocationsForAlias(alias: string): Promise<ThirdPartyLocation[]>;
  /** The third-party users a Matrix user ID stands for. */
  thirdPartyUsersForUserId(userId: string): Promise<ThirdPartyUser[]>;
}
//# sourceMappingURL=directory.d.ts.map