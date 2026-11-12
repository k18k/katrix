import { MatrixError } from "../http/errors.js";
import { dummyAuth, withUserInteractiveAuth } from "./uia.js";
import { MatrixHttpApi } from "../http/api.js";
import { Mutex } from "../util/mutex.js";
import { refreshOAuthToken } from "./oauth.js";
// src/auth/login.ts
function credentialsFrom(res) {
	if (typeof res.user_id !== "string" || typeof res.access_token !== "string" || typeof res.device_id !== "string") throw new Error("Login response is missing user_id, device_id or access_token");
	return {
		userId: res.user_id,
		deviceId: res.device_id,
		accessToken: res.access_token,
		refreshToken: typeof res.refresh_token === "string" ? res.refresh_token : void 0,
		expiresAt: typeof res.expires_in_ms === "number" ? Date.now() + res.expires_in_ms : void 0,
		refresh: typeof res.refresh_token === "string" ? { kind: "matrix" } : void 0
	};
}
/** Login API calls that need no access token (https://spec.matrix.org/v1.16/client-server-api/#login). */
var Auth = class {
	api;
	http;
	constructor(opts) {
		this.api = new MatrixHttpApi({ ...opts });
		this.http = opts.http;
	}
	/** The login types the server offers (GET /v3/login), with SSO identity providers. */
	async loginFlows() {
		return (await this.api.endpoint("GET /v3/login", {}, { auth: false })).flows ?? [];
	}
	/** `user` is a localpart or a full user ID, or a full identifier for a third-party ID. */
	loginWithPassword(user, password, opts = {}) {
		const identifier = typeof user === "string" ? {
			type: "m.id.user",
			user
		} : user;
		return this.login({
			type: "m.login.password",
			identifier,
			password
		}, opts);
	}
	/** The token an SSO redirect returns (m.login.token). */
	loginWithToken(token, opts = {}) {
		return this.login({
			type: "m.login.token",
			token
		}, opts);
	}
	/**
	* Register an account (https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv3register).
	* User-interactive authentication: flows made only of `m.login.dummy` are completed on their
	* own; for others (CAPTCHA, email, terms, registration tokens) pass `auth`, or the server's 401
	* is thrown as a MatrixError whose `data` holds the flows and session.
	*/
	async register(username, password, opts = {}) {
		const body = {
			username,
			password,
			device_id: opts.deviceId,
			initial_device_display_name: opts.initialDeviceDisplayName,
			refresh_token: opts.refreshToken ?? true
		};
		return credentialsFrom(await withUserInteractiveAuth((auth) => this.api.endpoint("POST /v3/register", {}, {
			auth: false,
			retryRateLimited: false,
			body: {
				...body,
				auth
			}
		}), (session) => dummyAuth(session) ?? opts.auth?.(session)));
	}
	/** Register a guest account (`kind=guest`): limited access, no password. */
	async registerGuest(opts = {}) {
		return credentialsFrom(await this.api.endpoint("POST /v3/register", {}, {
			auth: false,
			retryRateLimited: false,
			query: { kind: "guest" },
			body: {
				initial_device_display_name: opts.initialDeviceDisplayName,
				refresh_token: opts.refreshToken ?? true
			}
		}));
	}
	/** Whether a username is free to register; false when taken, throws M_INVALID_USERNAME or M_EXCLUSIVE when not allowed. */
	async isUsernameAvailable(username) {
		try {
			return (await this.api.endpoint("GET /v3/register/available", {}, {
				auth: false,
				query: { username }
			})).available === true;
		} catch (e) {
			if (e instanceof MatrixError && e.errcode === "M_USER_IN_USE") return false;
			throw e;
		}
	}
	/** Whether a registration token (m.login.registration_token) is still valid. */
	async isRegistrationTokenValid(token) {
		return (await this.api.endpoint("GET /v1/register/m.login.registration_token/validity", {}, {
			auth: false,
			query: { token }
		})).valid === true;
	}
	/**
	* Ask the server to send a validation token for the m.login.email.identity or
	* m.login.msisdn stage. `purpose` picks the endpoint: registration, a password reset, or adding
	* the address to an account (that one needs an access token: use MatrixClient.account).
	* Keep `clientSecret` and the returned `sid` for the stage's `threepid_creds`.
	*/
	requestEmailToken(purpose, req) {
		const body = {
			client_secret: req.clientSecret,
			email: req.email,
			send_attempt: req.sendAttempt,
			next_link: req.nextLink
		};
		return purpose === "register" ? this.api.endpoint("POST /v3/register/email/requestToken", {}, {
			auth: false,
			body
		}) : this.api.endpoint("POST /v3/account/password/email/requestToken", {}, {
			auth: false,
			body
		});
	}
	requestMsisdnToken(purpose, req) {
		const body = {
			client_secret: req.clientSecret,
			country: req.country,
			phone_number: req.phoneNumber,
			send_attempt: req.sendAttempt,
			next_link: req.nextLink
		};
		return purpose === "register" ? this.api.endpoint("POST /v3/register/msisdn/requestToken", {}, {
			auth: false,
			body
		}) : this.api.endpoint("POST /v3/account/password/msisdn/requestToken", {}, {
			auth: false,
			body
		});
	}
	/**
	* Reset a forgotten password: `auth` completes the m.login.email.identity (or msisdn) stage
	* with the `threepid_creds` of requestEmailToken("password", …).
	*/
	async resetPassword(newPassword, auth, opts = {}) {
		await withUserInteractiveAuth((a) => this.api.endpoint("POST /v3/account/password", {}, {
			auth: false,
			body: {
				new_password: newPassword,
				logout_devices: opts.logoutDevices,
				auth: a
			}
		}), auth);
	}
	/** The spec versions and unstable features the server supports. */
	versions() {
		return this.api.endpoint("GET /versions", {}, { auth: false });
	}
	/** The server's support contacts (/.well-known/matrix/support); undefined when it publishes none. */
	async support() {
		try {
			return await this.api.endpoint("GET /.well-known/matrix/support", {}, { auth: false });
		} catch (e) {
			if (e instanceof MatrixError && e.status === 404) return void 0;
			throw e;
		}
	}
	/**
	* The SSO redirect URL to open in a browser (https://spec.matrix.org/v1.19/client-server-api/#client-login-via-sso).
	* The server sends the browser back to `redirectUrl` with a `loginToken` for loginWithToken.
	* `action` hints whether the user means to log in or to sign up.
	*/
	ssoRedirectUrl(redirectUrl, idpId, action) {
		const path = `/_matrix/client/v3/login/sso/redirect${idpId ? `/${encodeURIComponent(idpId)}` : ""}`;
		return this.api.url(path, {
			redirectUrl,
			action
		});
	}
	/**
	* Log in as a user of an application service (m.login.application_service): the request
	* carries the appservice's `as_token`, which the caller passes.
	*/
	async loginAsApplicationService(asToken, user, opts = {}) {
		return credentialsFrom(await new MatrixHttpApi({
			baseUrl: this.api.baseUrl,
			http: this.http,
			tokens: { accessToken: () => asToken }
		}).endpoint("POST /v3/login", {}, {
			retryRateLimited: false,
			body: {
				type: "m.login.application_service",
				identifier: {
					type: "m.id.user",
					user
				},
				device_id: opts.deviceId,
				initial_device_display_name: opts.initialDeviceDisplayName,
				refresh_token: opts.refreshToken ?? false
			}
		}));
	}
	async login(body, opts) {
		return credentialsFrom(await this.api.endpoint("POST /v3/login", {}, {
			auth: false,
			retryRateLimited: false,
			body: {
				...body,
				device_id: opts.deviceId,
				initial_device_display_name: opts.initialDeviceDisplayName,
				refresh_token: opts.refreshToken ?? true
			}
		}));
	}
	/** The base URL from /.well-known/matrix/client, checked against /versions (spec "Server Discovery"). */
	static async discover(serverName, http) {
		const wellKnown = new MatrixHttpApi({
			baseUrl: `https://${serverName}`,
			http
		});
		let baseUrl = `https://${serverName}`;
		try {
			const url = (await wellKnown.endpoint("GET /.well-known/matrix/client", {}, { auth: false }))["m.homeserver"]?.base_url;
			if (typeof url !== "string" || !/^https?:\/\/[^/]+/.test(url)) throw new Error("FAIL_PROMPT: invalid m.homeserver.base_url");
			baseUrl = url.replace(/\/+$/, "");
		} catch (e) {
			if (!(e instanceof MatrixError && e.status === 404)) throw e;
		}
		const versions = await new MatrixHttpApi({
			baseUrl,
			http
		}).endpoint("GET /versions", {}, { auth: false });
		if (!Array.isArray(versions.versions)) throw new Error("FAIL_ERROR: not a Matrix homeserver");
		return baseUrl;
	}
};
/**
* Tokens from a login, refreshed with the refresh token when the server rejects the access token.
* Concurrent requests that all see the expired token share one refresh.
*/
var CredentialsTokenProvider = class {
	credentials;
	http;
	baseUrl;
	store;
	mutex = new Mutex();
	constructor(opts) {
		this.credentials = opts.credentials;
		this.http = opts.http;
		this.baseUrl = opts.baseUrl;
		this.store = opts.store;
	}
	current() {
		return this.credentials;
	}
	accessToken() {
		return this.credentials.accessToken;
	}
	refresh() {
		const before = this.credentials.accessToken;
		return this.mutex.run(async () => {
			if (this.credentials.accessToken !== before) return true;
			const c = this.credentials;
			if (!c.refreshToken || !c.refresh) return false;
			try {
				if (c.refresh.kind === "matrix") {
					const res = await new MatrixHttpApi({
						baseUrl: this.baseUrl,
						http: this.http
					}).endpoint("POST /v3/refresh", {}, {
						auth: false,
						body: { refresh_token: c.refreshToken }
					});
					this.credentials = {
						...c,
						accessToken: res.access_token,
						refreshToken: res.refresh_token ?? c.refreshToken,
						expiresAt: typeof res.expires_in_ms === "number" ? Date.now() + res.expires_in_ms : void 0
					};
				} else {
					const t = await refreshOAuthToken(this.http, c.refresh.tokenEndpoint, c.refresh.clientId, c.refreshToken);
					this.credentials = {
						...c,
						accessToken: t.accessToken,
						refreshToken: t.refreshToken ?? c.refreshToken,
						expiresAt: t.expiresAt
					};
				}
			} catch (e) {
				if (e instanceof MatrixError && (e.status === 401 || e.status === 400 || e.status === 403)) return false;
				throw e;
			}
			await this.store?.onTokensRefreshed?.(this.credentials);
			return true;
		});
	}
};
export { Auth, CredentialsTokenProvider };

//# sourceMappingURL=login.js.map