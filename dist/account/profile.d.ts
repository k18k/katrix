import { PresenceResponse, PresenceState } from "../shared/api/account.js";
import { ProfileResponse } from "../shared/api/rooms.js";
import { MatrixHttpApi } from "../http/api.js";
/**
 * Profiles (https://spec.matrix.org/v1.19/client-server-api/#profiles): the display name, the
 * avatar, the time zone (`m.tz`) and custom fields (v1.16; the server's `m.profile_fields`
 * capability says which it allows). The server copies the display name and avatar into the
 * user's member events in every room it is in.
 */
export declare class ProfileApi {
  private readonly api;
  private readonly userId;
  constructor(api: MatrixHttpApi, userId: string);
  /** A user's whole profile (this user's by default). */
  get(userId?: string): Promise<ProfileResponse>;
  /** One field of a profile; undefined when it is not set. */
  getField(key: string, userId?: string): Promise<unknown>;
  /** Set one field of this user's profile (a JSON value; `displayname` and `avatar_url` must be strings). */
  setField(key: string, value: unknown): Promise<void>;
  deleteField(key: string): Promise<void>;
  setDisplayName(name: string): Promise<void>;
  /** An mxc:// URI (MediaApi.upload). */
  setAvatarUrl(mxcUri: string): Promise<void>;
  /** An IANA time zone name, such as "Europe/Warsaw". */
  setTimeZone(tz: string): Promise<void>;
}
/** Presence (https://spec.matrix.org/v1.19/client-server-api/#presence). Updates for others arrive in /sync (the client's "presence" event). */
export declare class PresenceApi {
  private readonly api;
  private readonly userId;
  private readonly onSet?;
  constructor(api: MatrixHttpApi, userId: string, onSet?: (presence: PresenceState) => void);
  get(userId?: string): Promise<PresenceResponse>;
  /**
   * Set this user's presence. The client's /sync then keeps it (as set_presence): a sync without
   * it means "online" (spec), which would undo "unavailable" at the next round.
   */
  set(presence: PresenceState, statusMsg?: string): Promise<void>;
}
//# sourceMappingURL=profile.d.ts.map