import { randomToken } from "./crypto.js";
import { CLUSTER_RESYNC } from "./cluster.js";
import { errors } from "./errors.js";
import { generateDeviceId } from "./ids.js";
// src/core/auth.ts
var AuthService = class {
	hs;
	cache = /* @__PURE__ */ new Map();
	constructor(hs) {
		this.hs = hs;
		hs.cluster.subscribe("auth", (msg) => {
			if (msg?.from === hs.instanceId) return;
			if (msg.token) this.cache.delete(msg.token);
			if (msg.userId) {
				for (const [t, e] of this.cache) if (e.session.userId === msg.userId) this.cache.delete(t);
			}
		});
		hs.cluster.subscribe(CLUSTER_RESYNC, () => this.cache.clear());
	}
	async authenticate(token, ip) {
		const cached = this.cache.get(token);
		if (cached && cached.expires > Date.now()) return cached.session;
		const row = await this.hs.db.findOne("access_tokens", [{
			field: "token",
			value: token
		}]);
		if (!row) {
			if (this.hs.oauth) return this.hs.oauth.authenticate(token);
			throw errors.unknownToken();
		}
		if (row.expires_ts !== null && row.expires_ts <= Date.now()) throw errors.unknownToken("Access token expired", true);
		const user = await this.hs.db.findOne("users", [{
			field: "user_id",
			value: row.user_id
		}]);
		if (!user || user.deactivated) throw errors.unknownToken();
		const session = {
			userId: row.user_id,
			deviceId: row.device_id,
			accessToken: token,
			isGuest: !!user.is_guest,
			isAdmin: !!user.is_admin,
			locked: !!user.locked,
			suspended: !!user.suspended,
			...row.client_id ? { oauth: true } : {}
		};
		if (row.refresh_parent) {
			await this.hs.db.update("access_tokens", [{
				field: "token",
				value: row.refresh_parent
			}], { refresh_used: true });
			await this.hs.db.update("access_tokens", [{
				field: "token",
				value: token
			}], { refresh_parent: null });
		}
		if (this.cache.size > 1e5) this.cache.clear();
		this.cache.set(token, {
			session,
			expires: row.expires_ts ?? Infinity
		});
		await this.hs.db.update("devices", [{
			field: "user_id",
			value: row.user_id
		}, {
			field: "device_id",
			value: row.device_id
		}], {
			last_seen_ts: Date.now(),
			last_seen_ip: ip
		});
		return session;
	}
	/** Create (or reuse) a device and issue a fresh access token for it. */
	async createSession(userId, opts = {}) {
		if ((await this.hs.db.findOne("users", [{
			field: "user_id",
			value: userId
		}]))?.locked) throw errors.userLocked();
		const deviceId = opts.deviceId || generateDeviceId();
		if (await this.hs.db.findOne("devices", [{
			field: "user_id",
			value: userId
		}, {
			field: "device_id",
			value: deviceId
		}])) {
			await this.revokeDeviceTokens(userId, deviceId);
			if (opts.displayName) await this.hs.db.update("devices", [{
				field: "user_id",
				value: userId
			}, {
				field: "device_id",
				value: deviceId
			}], { display_name: opts.displayName });
		} else await this.createDevice(userId, deviceId, opts.displayName);
		return this.issueToken(userId, deviceId, !!opts.refreshToken, {
			clientId: opts.clientId,
			lifetimeMs: opts.lifetimeMs,
			scope: opts.scope
		});
	}
	/** Create a device without tokens (also used by application services, MSC4190). */
	async createDevice(userId, deviceId, displayName) {
		await this.hs.db.create("devices", {
			user_id: userId,
			device_id: deviceId,
			display_name: displayName ?? null,
			last_seen_ts: Date.now(),
			last_seen_ip: null
		});
		await this.hs.keys.deviceChanged(userId);
		await this.hs.audit.record({
			action: "device_create",
			actor: userId,
			target: deviceId
		});
	}
	async issueToken(userId, deviceId, withRefresh, opts = {}) {
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
			refresh_used: false
		});
		const out = {
			user_id: userId,
			device_id: deviceId,
			access_token: token
		};
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
	* https://github.com/k18k/katrix/issues/66: the old row used to be deleted
	* at once, so a client whose response was lost could not retry and was logged out, and a
	* refresh token used twice went unnoticed. As the OAuth 2.0 API asks (and the legacy API
	* allows): the old refresh token keeps working until the new access token is first used; a
	* retry before that replaces the unused tokens. Once the new token was used, the old refresh
	* token is spent, and presenting it again means it leaked, so the device is logged out.
	*/
	async refresh(refreshToken, opts = {}) {
		return this.hs.cluster.lock(`refresh:${refreshToken}`, async () => {
			const row = await this.hs.db.findOne("access_tokens", [{
				field: "refresh_token",
				value: refreshToken
			}]);
			if (!row) throw errors.unknownToken("Unknown refresh token");
			if (opts.clientId !== void 0 && (row.client_id ?? null) !== opts.clientId) throw errors.unknownToken("Unknown refresh token");
			if (row.refresh_used) {
				this.hs.logger.warn("A spent refresh token was used again; logging out", row.user_id, row.device_id);
				await this.hs.audit.record({
					action: "logout",
					actor: row.user_id,
					target: row.device_id,
					details: { refresh_token_reuse: true }
				});
				await this.deleteDevice(row.user_id, row.device_id);
				throw errors.unknownToken("Refresh token was already used");
			}
			for (const unused of await this.hs.db.findMany("access_tokens", { where: [{
				field: "refresh_parent",
				value: row.token
			}] })) await this.revokeToken(unused.token);
			if (row.expires_ts === null || row.expires_ts > Date.now()) {
				await this.hs.db.update("access_tokens", [{
					field: "token",
					value: row.token
				}], { expires_ts: Date.now() });
				this.cache.delete(row.token);
				await this.hs.cluster.publish("auth", {
					from: this.hs.instanceId,
					token: row.token
				});
			}
			return this.issueToken(row.user_id, row.device_id, true, {
				clientId: row.client_id,
				lifetimeMs: opts.lifetimeMs,
				parent: row.token,
				scope: row.scope
			});
		});
	}
	/** Drop cached sessions of a user (after admin/deactivation changes). */
	async invalidateUser(userId) {
		for (const [token, e] of this.cache) if (e.session.userId === userId) this.cache.delete(token);
		await this.hs.cluster.publish("auth", {
			from: this.hs.instanceId,
			userId
		});
	}
	/** Issue a short-lived single-use `m.login.token` for a user (SSO, or host-app sign-in). */
	async createLoginToken(userId, ttlMs = 12e4) {
		const token = `mlt_${randomToken()}`;
		await this.hs.db.create("login_tokens", {
			token,
			user_id: userId,
			expires_ts: Date.now() + ttlMs
		});
		return token;
	}
	/** Redeem a login token; returns the user ID or throws. */
	async consumeLoginToken(token) {
		const row = await this.hs.db.findOne("login_tokens", [{
			field: "token",
			value: token
		}]);
		const removed = row ? await this.hs.db.delete("login_tokens", [{
			field: "token",
			value: token
		}]) : 0;
		if (!row || !removed || row.expires_ts < Date.now()) throw errors.forbidden("Invalid or expired login token");
		return row.user_id;
	}
	async revokeToken(token) {
		this.hs.oauth?.forget(token);
		await this.hs.cluster.publish("auth", {
			from: this.hs.instanceId,
			token
		});
		this.cache.delete(token);
		await this.hs.db.delete("access_tokens", [{
			field: "token",
			value: token
		}]);
	}
	async revokeDeviceTokens(userId, deviceId) {
		const rows = await this.hs.db.findMany("access_tokens", { where: [{
			field: "user_id",
			value: userId
		}] });
		for (const row of rows) if (row.device_id === deviceId) await this.revokeToken(row.token);
	}
	async deleteDevice(userId, deviceId) {
		await this.revokeDeviceTokens(userId, deviceId);
		const where = [{
			field: "user_id",
			value: userId
		}, {
			field: "device_id",
			value: deviceId
		}];
		await this.hs.db.delete("devices", where);
		await this.hs.db.delete("device_keys", where);
		await this.hs.db.delete("one_time_keys", where);
		await this.hs.db.delete("fallback_keys", where);
		await this.hs.db.delete("to_device", where);
		await this.hs.db.delete("pushers", where);
		await this.hs.keys.deviceChanged(userId, deviceId);
		await this.hs.audit.record({
			action: "device_delete",
			actor: userId,
			target: deviceId
		});
		await this.hs.db.delete("account_data", [
			{
				field: "user_id",
				value: userId
			},
			{
				field: "room_id",
				value: ""
			},
			{
				field: "type",
				value: `org.matrix.msc3890.local_notification_settings.${deviceId}`
			}
		]);
		await this.hs.keys.markDeviceListChanged(userId);
	}
	async deleteAllDevices(userId, except) {
		const devices = await this.hs.db.findMany("devices", { where: [{
			field: "user_id",
			value: userId
		}] });
		for (const d of devices) if (d.device_id !== except) await this.deleteDevice(userId, d.device_id);
	}
};
/**
* Suspended accounts (spec "Account suspension") may read, leave, redact their own events, manage
* keys and devices, but not join, invite, send or change their profile. Rooms used to talk to the
* server administration (the admin room, server notices) stay writable.
*/
async function assertNotSuspended(hs, session, roomId) {
	if (!session.suspended) return;
	if (roomId && (roomId === await hs.adminRoom?.roomId() || await hs.admin.isNoticeRoom(roomId))) return;
	throw errors.userSuspended();
}
export { AuthService, assertNotSuspended };

//# sourceMappingURL=auth.js.map