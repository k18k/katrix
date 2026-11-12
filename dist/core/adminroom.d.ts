import { PDU } from "./events.js";
import { Homeserver } from "../homeserver.js";
export interface AdminRoomOptions {
  /** Enable the admin room and admin bot. Default: true when the option object is given. */
  enabled?: boolean;
  /** The first account registered on the server becomes a server admin. Default: true. */
  firstUserIsAdmin?: boolean;
  /** Let the very first account register even when registration is closed. Default: true. */
  firstUserCanRegister?: boolean;
  /** Localpart of the admin bot. Default: "admin". */
  botLocalpart?: string;
  botDisplayName?: string;
  roomName?: string;
  /** Localpart of the admin room alias (#admins:server). Default: "admins". */
  aliasLocalpart?: string;
}
/**
 * A tuwunel-style admin room: server admins chat with an admin bot to manage the
 * server. The first registered account becomes an admin and is put in the room.
 */
export declare class AdminRoomService {
  private hs;
  readonly options: Required<AdminRoomOptions>;
  private roomIdCache;
  constructor(hs: Homeserver, options: AdminRoomOptions);
  get botUserId(): string;
  get alias(): string;
  /** Whether no real (non-bot) account exists yet. */
  noUsersYet(): Promise<boolean>;
  roomId(): Promise<string | null>;
  /** Create the admin bot and room if needed. */
  ensureRoom(): Promise<string>;
  /** Called after an account was created. */
  onUserCreated(userId: string): Promise<void>;
  /** Put an admin into the admin room. */
  addAdmin(userId: string): Promise<void>;
  /** Remove a former admin from the admin room. */
  removeAdmin(userId: string): Promise<void>;
  /** Post a message from the admin bot. */
  say(text: string, replyTo?: string): Promise<void>;
  /** Called for every new event; handles commands posted in the admin room. */
  onEvent(event: PDU): Promise<void>;
  private resolveUser;
  private resolveRoom;
  /** Run one admin command; returns the reply text. */
  execute(actor: string, args: string[]): Promise<string>;
}
//# sourceMappingURL=adminroom.d.ts.map