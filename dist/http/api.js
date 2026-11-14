import { describeError, noopLogger } from "../util/logger.js";
import { encodeQuery } from "../util/query.js";
import { abortError, clearTimer, isAbortError, newAbortController, setTimer, sleep } from "../platform.js";
import { ConnectionError, MatrixError } from "./errors.js";
import { endpointPath, endpointUrlPath } from "../shared/api/endpoints.js";
// src/http/api.ts
/** The endpoints of the map whose response is a file (MediaBody), not JSON. */
const MEDIA_RESPONSE = /^GET \/v1\/media\/(download|thumbnail)\//;
function isMediaBody(body) {
	return typeof body === "object" && body !== null && body.data instanceof Uint8Array;
}
/** The file name of a Content-Disposition header (`filename*=UTF-8''…` or `filename="…"`). */
function dispositionFilename(header) {
	if (!header) return void 0;
	const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
	if (star) try {
		return decodeURIComponent(star[1].trim());
	} catch {}
	const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/.exec(header);
	return plain ? plain[1]?.replace(/\\(.)/g, "$1") ?? plain[2] : void 0;
}
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RATE_LIMIT_WAIT_MS = 6e4;
/** JSON requests to the Client-Server API. */
var MatrixHttpApi = class {
	baseUrl;
	http;
	tokens;
	logger;
	constructor(opts) {
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.http = opts.http;
		this.tokens = opts.tokens;
		this.logger = opts.logger ?? noopLogger;
	}
	setTokenProvider(tokens) {
		this.tokens = tokens;
	}
	/**
	* Call an endpoint of the shared endpoint map: the body and the response are typed by it, and
	* path parameters are filled in from `params`, each percent-encoded as one segment.
	*/
	endpoint(key, params, opts) {
		const space = key.indexOf(" ");
		const template = key.slice(space + 1);
		return this.request(key.slice(0, space), endpointPath(endpointUrlPath(template), params), {
			...opts,
			prefix: "",
			responseType: opts.responseType ?? (MEDIA_RESPONSE.test(key) ? "bytes" : "json")
		});
	}
	/** The URL of a path under the server's base URL (for links the app opens itself, such as SSO redirects). */
	url(path, query) {
		const q = query ? encodeQuery(query) : "";
		return `${this.baseUrl}${path}${q ? `?${q}` : ""}`;
	}
	async request(method, path, opts = {}) {
		const prefix = opts.prefix ?? "/_matrix/client";
		let refreshed = false;
		for (let attempt = 0;; attempt++) try {
			return await this.once(method, prefix + path, opts);
		} catch (e) {
			if (!(e instanceof MatrixError)) throw e;
			if (e.errcode === "M_LIMIT_EXCEEDED" && opts.retryRateLimited !== false && attempt < MAX_RATE_LIMIT_RETRIES) {
				const wait = Math.min(e.retryAfterMs ?? 1e3 * 2 ** attempt, MAX_RATE_LIMIT_WAIT_MS);
				this.logger.debug("rate limited, retrying", {
					method,
					path,
					wait
				});
				await sleep(wait, opts.signal);
				continue;
			}
			if (e.status === 401 && e.errcode === "M_UNKNOWN_TOKEN" && opts.auth !== false && !refreshed && this.tokens?.refresh) {
				refreshed = true;
				if (await this.tokens.refresh()) continue;
			}
			throw e;
		}
	}
	async once(method, path, opts) {
		const query = opts.query ? encodeQuery(opts.query) : "";
		const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
		const headers = { accept: "application/json" };
		if (opts.auth !== false) {
			const token = this.tokens?.accessToken();
			if (token) headers.authorization = `Bearer ${token}`;
		}
		let body;
		if (isMediaBody(opts.body)) {
			headers["content-type"] = opts.body.contentType ?? "application/octet-stream";
			body = opts.body.data;
		} else if (opts.body !== void 0) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(opts.body);
		}
		if (opts.responseType === "bytes") headers.accept = "*/*";
		let controller;
		let timer;
		let onAbort;
		if (opts.signal || opts.timeoutMs) {
			controller = newAbortController();
			if (opts.signal) {
				if (opts.signal.aborted) throw abortError();
				const c = controller;
				onAbort = () => c.abort();
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
			if (opts.timeoutMs) {
				const c = controller;
				timer = setTimer(() => c.abort(), opts.timeoutMs);
			}
		}
		const request = {
			method,
			path
		};
		try {
			let res;
			try {
				res = await this.http.request({
					method,
					url,
					headers,
					body,
					signal: controller?.signal
				});
			} catch (e) {
				if (opts.signal?.aborted) throw abortError();
				if (isAbortError(e) || controller?.signal.aborted) throw new ConnectionError(request, /* @__PURE__ */ new Error("timeout"));
				this.logger.debug("request failed", {
					method,
					path,
					...describeError(e)
				});
				throw new ConnectionError(request, e);
			}
			if (opts.responseType === "bytes" && res.status >= 200 && res.status < 300) return {
				data: await res.bytes(),
				contentType: res.header("content-type"),
				filename: dispositionFilename(res.header("content-disposition"))
			};
			const text = await res.text();
			let json = {};
			if (text) try {
				json = JSON.parse(text);
			} catch {
				if (res.status >= 200 && res.status < 300) throw new MatrixError(res.status, {
					errcode: "M_NOT_JSON",
					error: "Response is not JSON"
				}, request);
				json = {};
			}
			if (res.status < 200 || res.status >= 300) {
				const data = typeof json === "object" && json !== null ? json : {};
				const retryAfter = res.header("retry-after");
				if (data.retry_after_ms === void 0 && retryAfter && /^\d+$/.test(retryAfter)) data.retry_after_ms = Number(retryAfter) * 1e3;
				if (res.status === 429 && data.errcode === void 0) data.errcode = "M_LIMIT_EXCEEDED";
				throw new MatrixError(res.status, data, request);
			}
			return json;
		} finally {
			if (timer !== void 0) clearTimer(timer);
			if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
		}
	}
};
export { MatrixHttpApi };

//# sourceMappingURL=api.js.map