import { HierarchyResponse, HierarchyRoom } from "../shared/api/rooms.js";
import { MatrixClient } from "../client.js";
export interface SpaceChild {
  roomId: string;
  via: string[];
  order?: string;
  suggested: boolean;
}
/**
 * Spaces (https://spec.matrix.org/v1.19/client-server-api/#spaces): rooms of type m.space whose
 * m.space.child state lists the rooms in them, and m.space.parent state in rooms pointing back.
 */
export declare class SpacesApi {
  private readonly client;
  constructor(client: MatrixClient);
  /**
   * Create a space. Only moderators can post messages in it (events_default 50): a space is a
   * list of rooms, not a chat, and other clients set them up the same way.
   */
  create(opts: {
    name: string;
    topic?: string;
    visibility?: "public" | "private";
    invite?: string[];
    roomAliasName?: string;
  }): Promise<string>;
  /**
   * Add a room to a space. `via` are servers to join the room through (default: this user's
   * server). `order` sorts children (printable ASCII, up to 50 characters).
   */
  addChild(spaceId: string, roomId: string, opts?: {
    via?: string[];
    order?: string;
    suggested?: boolean;
  }): Promise<void>;
  /** Remove a room from a space (its m.space.child is emptied, as the spec says). */
  removeChild(spaceId: string, roomId: string): Promise<void>;
  /** Point a room at its space. `canonical` marks the main parent. */
  setParent(roomId: string, spaceId: string, opts?: {
    via?: string[];
    canonical?: boolean;
  }): Promise<void>;
  removeParent(roomId: string, spaceId: string): Promise<void>;
  /**
   * The children of a synced space, in the spec's order: by `order` (rooms without one last),
   * then by when they were added, then by room ID. Children without `via` were removed.
   */
  children(spaceId: string): SpaceChild[];
  /** The spaces a synced room says it is in (m.space.parent with `via`), canonical first. */
  parents(roomId: string): Array<{
    spaceId: string;
    via: string[];
    canonical: boolean;
  }>;
  /** One page of a space's hierarchy from the server, depth first, including rooms not joined. */
  hierarchy(spaceId: string, opts?: {
    suggestedOnly?: boolean;
    maxDepth?: number;
    limit?: number;
    from?: string;
  }): Promise<HierarchyResponse>;
  /** The whole hierarchy (every page, up to `maxRooms`). */
  fullHierarchy(spaceId: string, opts?: {
    suggestedOnly?: boolean;
    maxDepth?: number;
    maxRooms?: number;
  }): Promise<HierarchyRoom[]>;
}
//# sourceMappingURL=spaces.d.ts.map