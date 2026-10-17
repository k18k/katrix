import { errors } from "#core/errors.ts";
import { randomToken } from "#core/crypto.ts";
import { generateDeviceId } from "#core/ids.ts";
import type { AppServiceRegistration } from "#core/appservices.ts";
import type { Homeserver } from "#homeserver.ts";

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
  /**
   * The token comes from the OAuth 2.0 API (this server's or a delegated one), so endpoints that
   * need User-Interactive Authentication send the user to account management instead.
   */
  oauth?: boolean;
}

export interface CreatedSession {
  user_id: string;
  device_id: string;
  access_token: string;
  refresh_token?: string;
  expires_in_ms?: number;
  /** OAuth 2.0 API: the scope the tokens were issued for. */
  scope?: string;
}

export class AuthService {
  private hs: Homeserver;
  // Sessions by access token, kept until the token expires (OAuth access tokens are short-lived,
  // and every request would read them from the database). At most 100k entries; revocations
  // reach other instances over the "auth" channel.
  private cache = new Map<string, { session: Session; expires: number }>();

  constructor(hs: Homeserver) {
    this.hs = hs;
    hs.cluster.subscribe("auth", (msg: { from: string; token?: string; userId?: string }) => {
      if (msg?.from === hs.instanceId) return;
      if (msg.token) this.cache.delete(msg.token);
      if (msg.userId) for (const [t, e] of this.cache) if (e.session.userId === msg.userId) this.cache.delete(t);
    });
  }

  async authenticate(token: string, ip: string | null): Promise<Session> {
    const cached = this.cache.get(token);
    if (cached && cached.expires > Date.now()) return cached.session;
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
      ...(row.client_id ? { oauth: true } : {}),
    };
    // The first use of a rotated token confirms the client got it, so the refresh token it
    // replaced stops working (see `refresh`).
    if (row.refresh_parent) {
      await this.hs.db.update("access_tokens", [{ field: "token", value: row.refresh_parent }], { refresh_used: true });
      await this.hs.db.update("access_tokens", [{ field: "token", value: token }], { refresh_parent: null });
    }
    if (this.cache.size > 100_000) this.cache.clear();
    this.cache.set(token, { session, expires: row.expires_ts ?? Infinity });
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
    opts: {
      deviceId?: string;
      displayName?: string;
      refreshToken?: boolean;
      /** OAuth 2.0 API: the client the tokens are issued to. */
      clientId?: string;
      /** Access token lifetime; default `accessTokenLifetimeMs` (for tokens with a refresh token). */
      lifetimeMs?: number;
      /** OAuth 2.0 API: the scope granted. */
      scope?: string;
    } = {},
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
    return this.issueToken(userId, deviceId, !!opts.refreshToken, {
      clientId: opts.clientId,
      lifetimeMs: opts.lifetimeMs,
      scope: opts.scope,
    });
  }

  async issueToken(
    userId: string,
    deviceId: string,
    withRefresh: boolean,
    opts: { clientId?: string | null; lifetimeMs?: number; parent?: string; scope?: string | null } = {},
  ): Promise<CreatedSession> {
    const token = `mat_${randomToken()}`;
    const lifetime = opts.lifetimeMs ?? this.hs.config.accessTokenLifetimeMs;
    const refresh = withRefresh ? `mar_${randomToken()}` : null;
    await this.hs.db.create("access_tokens", {
      token,
      user_id: userId,
      device_id: deviceId,
      refresh_token: refresh,
      expires_ts: refresh && lifetime ? Date.now() + lifetime : null,
      client_id: opts.clientId ?? null,
      scope: opts.scope ?? null,
      refresh_parent: opts.parent ?? null,
      refresh_used: false,
    });
    const out: CreatedSession = { user_id: userId, device_id: deviceId, access_token: token };
    if (opts.scope) out.scope = opts.scope;
    if (refresh) {
      out.refresh_token = refresh;
      if (lifetime) out.expires_in_ms = lifetime;
    }
    return out;
  }

  /**
   * Exchange a refresh token for new tokens.
   *
   * https://github.com/k18k/matrix-nodejs-homeserver/issues/66: the old row used to be deleted
   * at once, so a client whose response was lost could not retry and was logged out, and a
   * refresh token used twice went unnoticed. As the OAuth 2.0 API asks (and the legacy API
   * allows): the old refresh token keeps working until the new access token is first used; a
   * retry before that replaces the unused tokens. Once the new token was used, the old refresh
   * token is spent, and presenting it again means it leaked, so the device is logged out.
   */
  async refresh(refreshToken: string, opts: { clientId?: string | null; lifetimeMs?: number } = {}): Promise<CreatedSession> {
    return this.hs.cluster.lock(`refresh:${refreshToken}`, async () => {
      const row = await this.hs.db.findOne("access_tokens", [{ field: "refresh_token", value: refreshToken }]);
      if (!row) throw errors.unknownToken("Unknown refresh token");
      if (opts.clientId !== undefined && (row.client_id ?? null) !== opts.clientId) throw errors.unknownToken("Unknown refresh token");
      if (row.refresh_used) {
        this.hs.logger.warn("A spent refresh token was used again; logging out", row.user_id, row.device_id);
        await this.hs.audit.record({ action: "logout", actor: row.user_id, target: row.device_id, details: { refresh_token_reuse: true } });
        await this.deleteDevice(row.user_id, row.device_id);
        throw errors.unknownToken("Refresh token was already used");
      }
      for (const unused of await this.hs.db.findMany("access_tokens", { where: [{ field: "refresh_parent", value: row.token }] }))
        await this.revokeToken(unused.token);
      // The old access token stops working now; the row stays for its refresh token.
      if (row.expires_ts === null || row.expires_ts > Date.now()) {
        await this.hs.db.update("access_tokens", [{ field: "token", value: row.token }], { expires_ts: Date.now() });
        this.cache.delete(row.token);
        await this.hs.cluster.publish("auth", { from: this.hs.instanceId, token: row.token });
      }
      return this.issueToken(row.user_id, row.device_id, true, {
        clientId: row.client_id,
        lifetimeMs: opts.lifetimeMs,
        parent: row.token,
        scope: row.scope,
      });
    });
  }

  /** Drop cached sessions of a user (after admin/deactivation changes). */
  async invalidateUser(userId: string): Promise<void> {
    for (const [token, e] of this.cache) if (e.session.userId === userId) this.cache.delete(token);
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
