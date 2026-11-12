import { Row } from "../storage/types.js";
import { Homeserver } from "../homeserver.js";
export interface ServerNoticesOptions {
  /** Localpart of the user that sends server notices. Default: "server". */
  localpart?: string;
  displayName?: string;
  roomName?: string;
}
/** Programmatic administration, for embedding applications and the admin HTTP API. */
export declare class AdminService {
  private hs;
  constructor(hs: Homeserver);
  createUser(localpart: string, opts?: {
    password?: string;
    admin?: boolean;
    displayname?: string;
  }): Promise<string>;
  getUser(userId: string): Promise<Record<string, any> | null>;
  listUsers(opts?: {
    from?: number;
    limit?: number;
    search?: string;
    includeDeactivated?: boolean;
  }): Promise<{
    users: {
      [x: string]: any;
    }[];
    total: number;
    next: number | null;
  }>;
  setAdmin(userId: string, admin: boolean): Promise<void>;
  /** Lock or unlock an account (reversible; sessions are kept but unusable while locked). */
  setLocked(userId: string, locked: boolean, actor?: string): Promise<void>;
  /** Suspend or unsuspend an account (reversible; the user can still read, leave and log out). */
  setSuspended(userId: string, suspended: boolean, actor?: string): Promise<void>;
  resetPassword(userId: string, password: string, logoutDevices?: boolean): Promise<void>;
  /** Deactivate an account: leave all rooms, log out everywhere and (optionally) erase the profile. */
  deactivateUser(userId: string, opts?: {
    erase?: boolean;
  }): Promise<void>;
  createRegistrationToken(opts?: {
    token?: string;
    usesAllowed?: number | null;
    expiryTime?: number | null;
    length?: number;
  }): Promise<{
    token: string;
    uses_allowed: number | null;
    pending: number;
    completed: number;
    expiry_time: number | null;
  }>;
  listRegistrationTokens(): Promise<Row[]>;
  deleteRegistrationToken(token: string): Promise<void>;
  /**
   * Make a local user join a room, as Synapse's `POST /_synapse/admin/v1/join` does: public rooms
   * directly; otherwise a local member who may invite invites them first (the invite shows in the
   * room, so its members see who added them). Returns the room ID.
   */
  joinUser(userId: string, roomIdOrAlias: string): Promise<string>;
  listRooms(opts?: {
    from?: number;
    limit?: number;
  }): Promise<{
    rooms: Record<string, any>[];
    total: number;
  }>;
  /** Remove everyone from a room, delist it and drop its aliases. With `purge`, also delete its history. */
  deleteRoom(roomId: string, opts?: {
    actor?: string;
    reason?: string;
    purge?: boolean;
  }): Promise<{
    kicked: string[];
  }>;
  deleteMedia(mediaId: string): Promise<void>;
  /** Delete local media uploaded before `beforeTs`. Returns the deleted media IDs. */
  purgeMediaBefore(beforeTs: number): Promise<string[]>;
  get noticeUserId(): string;
  /** Whether `roomId` is a server notices room (members may not reject or leave its invites). */
  isNoticeRoom(roomId: string): Promise<boolean>;
  /** Send a message to a user in their server notices room, creating or re-inviting as needed. */
  sendServerNotice(userId: string, content: Record<string, any>, opts?: {
    type?: string;
    txnId?: string;
  }): Promise<string>;
  private noticeRoomFor;
}
//# sourceMappingURL=admin.d.ts.map