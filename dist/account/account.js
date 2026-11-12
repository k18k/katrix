import { MatrixError } from "../http/errors.js";
import { withUserInteractiveAuth } from "../auth/uia.js";
// src/account/account.ts
/**
* The logged-in account (https://spec.matrix.org/v1.19/client-server-api/#account-registration-and-management):
* password, deactivation, third-party IDs, account data, filters, ignored users, OpenID and login
* tokens. Calls that need user-interactive authentication take a UiaCallback (passwordAuth for
* the common case).
*/
var AccountApi = class {
	api;
	userId;
	capabilitiesCache;
	constructor(api, userId) {
		this.api = api;
		this.userId = userId;
	}
	whoami() {
		return this.api.endpoint("GET /v3/account/whoami", {}, {});
	}
	/** What the server lets this account do (https://spec.matrix.org/v1.19/client-server-api/#capabilities-negotiation). */
	async capabilities(opts = {}) {
		if (!this.capabilitiesCache || opts.refresh) this.capabilitiesCache = (await this.api.endpoint("GET /v3/capabilities", {}, {})).capabilities ?? {};
		return this.capabilitiesCache;
	}
	/** Change the password. `logoutDevices` (default true on the server) logs out every other device. */
	async changePassword(newPassword, auth, opts = {}) {
		await withUserInteractiveAuth((a) => this.api.endpoint("POST /v3/account/password", {}, { body: {
			new_password: newPassword,
			logout_devices: opts.logoutDevices,
			auth: a
		} }), auth);
	}
	/**
	* Deactivate the account, for good. `erase` asks the server to forget what the user sent, as
	* far as it can. Resolves with whether the identity server unbound the account's 3PIDs.
	*/
	async deactivate(auth, opts = {}) {
		return (await withUserInteractiveAuth((a) => this.api.endpoint("POST /v3/account/deactivate", {}, { body: {
			auth: a,
			erase: opts.erase,
			id_server: opts.idServer
		} }), auth)).id_server_unbind_result;
	}
	async threePids() {
		return (await this.api.endpoint("GET /v3/account/3pid", {}, {})).threepids ?? [];
	}
	/** Start adding an email address: the server sends a link or code to it. */
	requestEmailToken(req) {
		return this.api.endpoint("POST /v3/account/3pid/email/requestToken", {}, { body: {
			client_secret: req.clientSecret,
			email: req.email,
			send_attempt: req.sendAttempt,
			next_link: req.nextLink
		} });
	}
	requestMsisdnToken(req) {
		return this.api.endpoint("POST /v3/account/3pid/msisdn/requestToken", {}, { body: {
			client_secret: req.clientSecret,
			country: req.country,
			phone_number: req.phoneNumber,
			send_attempt: req.sendAttempt,
			next_link: req.nextLink
		} });
	}
	/** Finish adding a validated 3PID to the account (`sid` from requestEmailToken or requestMsisdnToken). */
	async addThreePid(clientSecret, sid, auth) {
		await withUserInteractiveAuth((a) => this.api.endpoint("POST /v3/account/3pid/add", {}, { body: {
			client_secret: clientSecret,
			sid,
			auth: a
		} }), auth);
	}
	/** Publish a validated 3PID on an identity server. */
	async bindThreePid(req) {
		await this.api.endpoint("POST /v3/account/3pid/bind", {}, { body: {
			client_secret: req.clientSecret,
			sid: req.sid,
			id_server: req.idServer,
			id_access_token: req.idAccessToken
		} });
	}
	async deleteThreePid(medium, address, idServer) {
		return (await this.api.endpoint("POST /v3/account/3pid/delete", {}, { body: {
			medium,
			address,
			id_server: idServer
		} })).id_server_unbind_result;
	}
	async unbindThreePid(medium, address, idServer) {
		return (await this.api.endpoint("POST /v3/account/3pid/unbind", {}, { body: {
			medium,
			address,
			id_server: idServer
		} })).id_server_unbind_result;
	}
	/** Global account data from the server (MatrixClient.getAccountData has what sync delivered). Undefined when unset. */
	async getAccountData(type) {
		try {
			return await this.api.endpoint("GET /v3/user/:userId/account_data/:type", {
				userId: this.userId,
				type
			}, {});
		} catch (e) {
			if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return void 0;
			throw e;
		}
	}
	async setAccountData(type, content) {
		await this.api.endpoint("PUT /v3/user/:userId/account_data/:type", {
			userId: this.userId,
			type
		}, { body: content });
	}
	async getRoomAccountData(roomId, type) {
		try {
			return await this.api.endpoint("GET /v3/user/:userId/rooms/:roomId/account_data/:type", {
				userId: this.userId,
				roomId,
				type
			}, {});
		} catch (e) {
			if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return void 0;
			throw e;
		}
	}
	async setRoomAccountData(roomId, type, content) {
		await this.api.endpoint("PUT /v3/user/:userId/rooms/:roomId/account_data/:type", {
			userId: this.userId,
			roomId,
			type
		}, { body: content });
	}
	/** The users whose events the server hides from this account (m.ignored_user_list). */
	async ignoredUsers() {
		const ignored = (await this.getAccountData("m.ignored_user_list"))?.ignored_users;
		return typeof ignored === "object" && ignored !== null ? Object.keys(ignored) : [];
	}
	/**
	* Ignore or stop ignoring users. The list is one account data event, so this reads it from the
	* server and writes it back: two devices changing it at the same moment can lose one change.
	*/
	async setIgnored(userIds, ignored) {
		const list = new Set(await this.ignoredUsers());
		for (const id of userIds) if (ignored) list.add(id);
		else list.delete(id);
		await this.setAccountData("m.ignored_user_list", { ignored_users: Object.fromEntries([...list].map((id) => [id, {}])) });
	}
	/** Store a filter on the server; its ID can be passed to /sync as `filter`. */
	async createFilter(filter) {
		return (await this.api.endpoint("POST /v3/user/:userId/filter", { userId: this.userId }, { body: filter })).filter_id;
	}
	getFilter(filterId) {
		return this.api.endpoint("GET /v3/user/:userId/filter/:filterId", {
			userId: this.userId,
			filterId
		}, {});
	}
	/** An OpenID token that proves who the user is to a third party (an integration manager, a widget). */
	requestOpenIdToken() {
		return this.api.endpoint("POST /v3/user/:userId/openid/request_token", { userId: this.userId }, { body: {} });
	}
	/**
	* A short-lived m.login.token for logging in another device as this user (QR login, for
	* example; https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv1loginget_token).
	*/
	getLoginToken(auth) {
		return withUserInteractiveAuth((a) => this.api.endpoint("POST /v1/login/get_token", {}, { body: { auth: a } }), auth);
	}
	/** Log out every device of the account, this one included. */
	async logoutAll() {
		await this.api.endpoint("POST /v3/logout/all", {}, { body: {} });
	}
};
export { AccountApi };

//# sourceMappingURL=account.js.map