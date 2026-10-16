import { errors } from "./errors.ts";
import { randomToken } from "./crypto.ts";
import { generateDeviceId } from "./ids.ts";
import type { AppServiceRegistration } from "./appservices.ts";
import type { Homeserver } from "../homeserver.ts";

export interface Session {
  userId: string;
  deviceId: string;
  accessToken: string;
  isGuest: boolean;
  isAdmin: boolean;
  /** The account is locked: only logging out is allowed. */
  locked?: boolean;
  /** The account is suspended: see `assertNotSuspended`. */
  suspended?: boolean;
  /** Set when the request was made with an application service token. */
  appservice?: AppServiceRegistration;
}

export interface CreatedSession {
  user_id: string;
  device_id: string;
  access_token: string;
  refresh_token?: string;
  expires_in_ms?: number;
}

export class AuthService {
  private hs: Homeserver;
  private cache = new Map<string, Session>();

  constructor(hs: Homeserver) {
    this.hs = hs;
    hs.cluster.subscribe("auth", (msg: { from: string; token?: string; userId?: string }) => {
      if (msg?.from === hs.instanceId) return;
      if (msg.token) this.cache.delete(msg.token);
      if (msg.userId) for (const [t, s] of this.cache) if (s.userId === msg.userId) this.cache.delete(t);
    });
  }

  async authenticate(token: string, ip: string | null): Promise<Session> {
    const cached = this.cache.get(token);
    if (cached) return cached;
    const row = await this.hs.db.findOne("access_tokens", [{ field: "token", value: token }]);
    if (!row) {
      // Tokens issued by a delegated OAuth provider are validated by introspection.
      if (this.hs.oauth) return this.hs.oauth.authenticate(token);
      throw errors.unknownToken();
    }
    if (row.expires_ts !== null && row.expires_ts < Date.now()) throw errors.unknownToken("Access token expired", true);
    const user = await this.hs.db.findOne("users", [{ field: "user_id", value: row.user_id }]);
    if (!user || user.deactivated) throw errors.unknownToken();
    const session: Session = {
      userId: row.user_id,
      deviceId: row.device_id,
      accessToken: token,
      isGuest: !!user.is_guest,
      isAdmin: !!user.is_admin,
      locked: !!user.locked,
      suspended: !!user.suspended,
    };
    if (row.expires_ts === null) this.cache.set(token, session);
    await this.hs.db.update(
      "devices",
      [
        { field: "user_id", value: row.user_id },
        { field: "device_id", value: row.device_id },
      ],
      { last_seen_ts: Date.now(), last_seen_ip: ip },
    );
    return session;
  }

  /** Create (or reuse) a device and issue a fresh access token for it. */
  async createSession(
    userId: string,
    opts: { deviceId?: string; displayName?: string; refreshToken?: boolean } = {},
  ): Promise<CreatedSession> {
    // A locked account cannot obtain new access tokens.
    if ((await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]))?.locked) throw errors.userLocked();
    const deviceId = opts.deviceId || generateDeviceId();
    const existing = await this.hs.db.findOne("devices", [
      { field: "user_id", value: userId },
      { field: "device_id", value: deviceId },
    ]);
    if (existing) {
      // Logging in again with the same device ID invalidates the old tokens.
      await this.revokeDeviceTokens(userId, deviceId);
      if (opts.displayName) {
        await this.hs.db.update(
          "devices",
          [
            { field: "user_id", value: userId },
            { field: "device_id", value: deviceId },
          ],
          { display_name: opts.displayName },
        );
      }
    } else {
      await this.hs.db.create("devices", {
        user_id: userId,
        device_id: deviceId,
        display_name: opts.displayName ?? null,
        last_seen_ts: Date.now(),
        last_seen_ip: null,
      });
      await this.hs.keys.deviceChanged(userId);
      await this.hs.audit.record({ action: "device_create", actor: userId, target: deviceId });
    }
    return this.issueToken(userId, deviceId, !!opts.refreshToken);
  }

  async issueToken(userId: string, deviceId: string, withRefresh: boolean): Promise<CreatedSession> {
    const token = `mat_${randomToken()}`;
    const lifetime = this.hs.config.accessTokenLifetimeMs;
    const refresh = withRefresh ? `mar_${randomToken()}` : null;
    await this.hs.db.create("access_tokens", {
      token,
      user_id: userId,
      device_id: deviceId,
      refresh_token: refresh,
      expires_ts: refresh && lifetime ? Date.now() + lifetime : null,
    });
    const out: CreatedSession = { user_id: userId, device_id: deviceId, access_token: token };
    if (refresh) {
      out.refresh_token = refresh;
      if (lifetime) out.expires_in_ms = lifetime;
    }
    return out;
  }

  async refresh(refreshToken: string): Promise<CreatedSession> {
    const row = await this.hs.db.findOne("access_tokens", [{ field: "refresh_token", value: refreshToken }]);
    if (!row) throw errors.unknownToken("Unknown refresh token");
    await this.hs.db.delete("access_tokens", [{ field: "token", value: row.token }]);
    this.cache.delete(row.token);
    return this.issueToken(row.user_id, row.device_id, true);
  }

  /** Drop cached sessions of a user (after admin/deactivation changes). */
  async invalidateUser(userId: string): Promise<void> {
    for (const [token, s] of this.cache) if (s.userId === userId) this.cache.delete(token);
    await this.hs.cluster.publish("auth", { from: this.hs.instanceId, userId });
  }

  /** Issue a short-lived single-use `m.login.token` for a user (SSO, or host-app sign-in). */
  async createLoginToken(userId: string, ttlMs = 2 * 60_000): Promise<string> {
    const token = `mlt_${randomToken()}`;
    await this.hs.db.create("login_tokens", { token, user_id: userId, expires_ts: Date.now() + ttlMs });
    return token;
  }

  /** Redeem a login token; returns the user ID or throws. */
  async consumeLoginToken(token: string): Promise<string> {
    const row = await this.hs.db.findOne("login_tokens", [{ field: "token", value: token }]);
    if (row) await this.hs.db.delete("login_tokens", [{ field: "token", value: token }]);
    if (!row || row.expires_ts < Date.now()) throw errors.forbidden("Invalid or expired login token");
    return row.user_id;
  }

  async revokeToken(token: string): Promise<void> {
    this.hs.oauth?.forget(token);
    await this.hs.cluster.publish("auth", { from: this.hs.instanceId, token });
    this.cache.delete(token);
    await this.hs.db.delete("access_tokens", [{ field: "token", value: token }]);
  }

  async revokeDeviceTokens(userId: string, deviceId: string): Promise<void> {
    const rows = await this.hs.db.findMany("access_tokens", { where: [{ field: "user_id", value: userId }] });
    for (const row of rows) if (row.device_id === deviceId) await this.revokeToken(row.token);
  }

  async deleteDevice(userId: string, deviceId: string): Promise<void> {
    await this.revokeDeviceTokens(userId, deviceId);
    const where = [
      { field: "user_id", value: userId },
      { field: "device_id", value: deviceId },
    ];
    await this.hs.db.delete("devices", where);
    await this.hs.db.delete("device_keys", where);
    await this.hs.db.delete("one_time_keys", where);
    await this.hs.db.delete("fallback_keys", where);
    await this.hs.db.delete("to_device", where);
    await this.hs.db.delete("pushers", where);
    await this.hs.keys.deviceChanged(userId, deviceId);
    await this.hs.audit.record({ action: "device_delete", actor: userId, target: deviceId });
    await this.hs.db.delete("account_data", [
      { field: "user_id", value: userId },
      { field: "room_id", value: "" },
      { field: "type", value: `org.matrix.msc3890.local_notification_settings.${deviceId}` },
    ]);
    await this.hs.keys.markDeviceListChanged(userId);
  }

  async deleteAllDevices(userId: string, except?: string): Promise<void> {
    const devices = await this.hs.db.findMany("devices", { where: [{ field: "user_id", value: userId }] });
    for (const d of devices) if (d.device_id !== except) await this.deleteDevice(userId, d.device_id);
  }
}

/**
 * Suspended accounts (spec "Account suspension") may read, leave, redact their own events, manage
 * keys and devices, but not join, invite, send or change their profile. Rooms used to talk to the
 * server administration (the admin room, server notices) stay writable.
 */
export async function assertNotSuspended(hs: Homeserver, session: Session, roomId?: string): Promise<void> {
  if (!session.suspended) return;
  if (roomId && (roomId === (await hs.adminRoom?.roomId()) || (await hs.admin.isNoticeRoom(roomId)))) return;
  throw errors.userSuspended();
}
