import type { MatrixHttpApi } from "../http/api.ts";
import { MatrixError } from "../http/errors.ts";
import type { PresenceResponse, PresenceState, ProfileResponse } from "@katrix/shared";

/**
 * Profiles (https://spec.matrix.org/v1.19/client-server-api/#profiles): the display name, the
 * avatar, the time zone (`m.tz`) and custom fields (v1.16; the server's `m.profile_fields`
 * capability says which it allows). The server copies the display name and avatar into the
 * user's member events in every room it is in.
 */
export class ProfileApi {
  private readonly api: MatrixHttpApi;
  private readonly userId: string;

  constructor(api: MatrixHttpApi, userId: string) {
    this.api = api;
    this.userId = userId;
  }

  /** A user's whole profile (this user's by default). */
  get(userId = this.userId): Promise<ProfileResponse> {
    return this.api.endpoint("GET /v3/profile/:userId", { userId }, {});
  }

  /** One field of a profile; undefined when it is not set. */
  async getField(key: string, userId = this.userId): Promise<unknown> {
    try {
      const res = await this.api.endpoint("GET /v3/profile/:userId/:keyName", { userId, keyName: key }, {});
      return res[key];
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return undefined;
      throw e;
    }
  }

  /** Set one field of this user's profile (a JSON value; `displayname` and `avatar_url` must be strings). */
  async setField(key: string, value: unknown): Promise<void> {
    await this.api.endpoint("PUT /v3/profile/:userId/:keyName", { userId: this.userId, keyName: key }, { body: { [key]: value } });
  }

  async deleteField(key: string): Promise<void> {
    await this.api.endpoint("DELETE /v3/profile/:userId/:keyName", { userId: this.userId, keyName: key }, {});
  }

  setDisplayName(name: string): Promise<void> {
    return this.setField("displayname", name);
  }

  /** An mxc:// URI (MediaApi.upload). */
  setAvatarUrl(mxcUri: string): Promise<void> {
    return this.setField("avatar_url", mxcUri);
  }

  /** An IANA time zone name, such as "Europe/Warsaw". */
  setTimeZone(tz: string): Promise<void> {
    return this.setField("m.tz", tz);
  }
}

/** Presence (https://spec.matrix.org/v1.19/client-server-api/#presence). Updates for others arrive in /sync (the client's "presence" event). */
export class PresenceApi {
  private readonly api: MatrixHttpApi;
  private readonly userId: string;
  private readonly onSet?: (presence: PresenceState) => void;

  constructor(api: MatrixHttpApi, userId: string, onSet?: (presence: PresenceState) => void) {
    this.api = api;
    this.userId = userId;
    this.onSet = onSet;
  }

  get(userId = this.userId): Promise<PresenceResponse> {
    return this.api.endpoint("GET /v3/presence/:userId/status", { userId }, {});
  }

  /**
   * Set this user's presence. The client's /sync then keeps it (as set_presence): a sync without
   * it means "online" (spec), which would undo "unavailable" at the next round.
   */
  async set(presence: PresenceState, statusMsg?: string): Promise<void> {
    await this.api.endpoint("PUT /v3/presence/:userId/status", { userId: this.userId }, { body: { presence, status_msg: statusMsg } });
    this.onSet?.(presence);
  }
}
