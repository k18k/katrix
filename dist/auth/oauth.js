import { MatrixError } from "../http/errors.js";
import { encodeQuery, parseQuery } from "../util/query.js";
import { encodeBase64 } from "../shared/base64.js";
import { encodeUtf8 } from "../shared/utf8.js";
import { isObject } from "../shared/json.js";
// src/auth/oauth.ts
/**
* OAuth 2.0 login, the "next-generation auth" of the Matrix spec
* (https://spec.matrix.org/v1.16/client-server-api/#oauth-20-api): server metadata discovery,
* dynamic client registration, the authorization code flow with PKCE (S256), and refresh.
* The browser step (opening `url`, receiving the redirect) belongs to the app; the result plugs
* into CredentialsTokenProvider as Credentials with `refresh.kind = "oauth"`.
*/
async function getAuthMetadata(api) {
	return api.endpoint("GET /v1/auth_metadata", {}, { auth: false });
}
async function responseObject(res) {
	const text = await res.text();
	try {
		const value = JSON.parse(text);
		return isObject(value) ? value : {};
	} catch {
		return {};
	}
}
async function tokenRequest(http, endpoint, form) {
	const res = await http.request({
		method: "POST",
		url: endpoint,
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json"
		},
		body: encodeQuery(form)
	});
	const json = await responseObject(res);
	if (res.status < 200 || res.status >= 300 || typeof json.access_token !== "string") throw new MatrixError(res.status, {
		errcode: typeof json.error === "string" ? json.error : "M_UNKNOWN",
		error: json.error_description
	}, {
		method: "POST",
		path: "token endpoint"
	});
	return {
		accessToken: json.access_token,
		refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : void 0,
		expiresAt: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1e3 : void 0
	};
}
function refreshOAuthToken(http, tokenEndpoint, clientId, refreshToken) {
	return tokenRequest(http, tokenEndpoint, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId
	});
}
/** Dynamic client registration (RFC 7591), as the spec requires clients to do. */
async function registerClient(http, metadata, client) {
	if (!metadata.registration_endpoint) throw new Error("The server does not support dynamic client registration");
	const res = await http.request({
		method: "POST",
		url: metadata.registration_endpoint,
		headers: {
			"content-type": "application/json",
			accept: "application/json"
		},
		body: JSON.stringify(client)
	});
	const json = await responseObject(res);
	if (res.status < 200 || res.status >= 300 || typeof json.client_id !== "string") throw new MatrixError(res.status, {
		errcode: typeof json.error === "string" ? json.error : "M_UNKNOWN",
		error: json.error_description
	}, {
		method: "POST",
		path: "registration endpoint"
	});
	return json.client_id;
}
const DEVICE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function createAuthorizationRequest(p, opts) {
	const deviceId = opts.deviceId ?? [...p.randomBytes(10)].map((b) => DEVICE_ID_ALPHABET[b % 26]).join("");
	const codeVerifier = encodeBase64(p.randomBytes(32), { urlSafe: true });
	const state = encodeBase64(p.randomBytes(16), { urlSafe: true });
	const challenge = encodeBase64(p.sha256(encodeUtf8(codeVerifier)), { urlSafe: true });
	const query = encodeQuery({
		response_type: "code",
		client_id: opts.clientId,
		redirect_uri: opts.redirectUri,
		scope: `urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`,
		state,
		response_mode: opts.responseMode ?? "fragment",
		code_challenge: challenge,
		code_challenge_method: "S256"
	});
	const sep = opts.metadata.authorization_endpoint.includes("?") ? "&" : "?";
	return {
		url: `${opts.metadata.authorization_endpoint}${sep}${query}`,
		state,
		codeVerifier,
		deviceId,
		redirectUri: opts.redirectUri
	};
}
/** Exchange the code from the redirect for tokens, after checking `state` (CSRF). */
async function completeAuthorization(http, opts) {
	const hash = opts.callbackUrl.indexOf("#");
	const params = {
		...parseQuery(opts.callbackUrl),
		...hash >= 0 ? parseQuery(opts.callbackUrl.slice(hash + 1)) : {}
	};
	if (params.state !== opts.request.state) throw new Error("OAuth state does not match this login attempt");
	if (params.error) throw new MatrixError(400, {
		errcode: params.error,
		error: params.error_description
	}, {
		method: "GET",
		path: "authorization"
	});
	if (!params.code) throw new Error("OAuth redirect has no code");
	return tokenRequest(http, opts.metadata.token_endpoint, {
		grant_type: "authorization_code",
		code: params.code,
		redirect_uri: opts.request.redirectUri,
		client_id: opts.clientId,
		code_verifier: opts.request.codeVerifier
	});
}
export { completeAuthorization, createAuthorizationRequest, getAuthMetadata, refreshOAuthToken, registerClient };

//# sourceMappingURL=oauth.js.map