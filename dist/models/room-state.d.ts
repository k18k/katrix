import { MatrixEvent } from "./event.js";
import { ClientEvent, EventContentMap, Membership, PowerLevelsContent } from "../shared/events.js";
export interface RoomMember {
  userId: string;
  membership: Membership;
  /** The display name as set in the member event (may be missing or shared with others). */
  rawDisplayName?: string;
  /** A name to show: unique in the room (spec "Calculating the display name for a user"). */
  name: string;
  avatarUrl?: string;
  powerLevel: number;
}
/** The current state of a room: the latest state event per (type, state_key). */
export declare class RoomState {
  private events;
  /** For lazy-loaded member lists: whether all members have been fetched once. */
  membersLoaded: boolean;
  get<K extends keyof EventContentMap>(type: K, stateKey?: string): MatrixEvent<K> | undefined;
  get(type: string, stateKey?: string): MatrixEvent | undefined;
  getAll(type: string): MatrixEvent<string>[];
  /** Every state event (for persisting). */
  all(): MatrixEvent<string>[];
  /** Set a state event; returns the event it replaced. */
  set(event: MatrixEvent): MatrixEvent<string> | undefined;
  setRaw(raw: ClientEvent): MatrixEvent<string> | undefined;
  clear(): void;
  membership(userId: string): Membership | undefined;
  powerLevels(): PowerLevelsContent;
  /**
   * A user's power level. Without m.room.power_levels the creator has 100 and everyone else 0
   * (https://spec.matrix.org/v1.16/client-server-api/#mroompower_levels). Room version 12 makes
   * the creators' power infinite; they show as Infinity.
   */
  powerLevel(userId: string): number;
  /** Whether `userId` may send `type` (state or message) by the power levels. */
  maySend(userId: string, type: string, state: boolean): boolean;
  members(): {
    userId: string;
    membership: Membership;
    rawDisplayName: string | undefined;
    name: string;
    avatarUrl: string | undefined;
    powerLevel: number;
  }[];
  member(userId: string): {
    userId: string;
    membership: Membership;
    rawDisplayName: string | undefined;
    name: string;
    avatarUrl: string | undefined;
    powerLevel: number;
  } | undefined;
  isEncrypted(): boolean;
}
//# sourceMappingURL=room-state.d.ts.map