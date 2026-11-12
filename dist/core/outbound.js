import { errors } from "./errors.js";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { lookup as lookup$1 } from "node:dns";
import { request as request$1 } from "node:http";
import { Readable } from "node:stream";
// src/core/outbound.ts
const privateRanges = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4]
]) privateRanges.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8]
]) privateRanges.addSubnet(net, prefix, "ipv6");
/** Whether an IP address is loopback, private, link-local, multicast or otherwise not public. */
function isPrivateAddress(address) {
	const family = isIP(address);
	return family !== 0 && privateRanges.check(address, family === 6 ? "ipv6" : "ipv4");
}
/** The policy for the `allowPrivateAddresses` option. */
function addressPolicy(allowPrivate) {
	if (allowPrivate === true) return { allows: () => true };
	const allowed = new BlockList();
	for (const entry of Array.isArray(allowPrivate) ? allowPrivate : []) {
		const [address, prefix] = entry.split("/");
		const family = isIP(address);
		if (family === 0) throw new Error(`allowPrivateAddresses: not an IP address or range: ${entry}`);
		allowed.addSubnet(address, prefix === void 0 ? family === 6 ? 128 : 32 : Number(prefix), family === 6 ? "ipv6" : "ipv4");
	}
	const allows = (address) => !isPrivateAddress(address) || allowed.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
	return {
		allows,
		lookup: (hostname, options, callback) => {
			lookup$1(hostname, {
				...options,
				all: true
			}, (err, addresses) => {
				if (err) return callback(err, []);
				if (addresses.length === 0 || !addresses.every((a) => allows(a.address))) return callback(privateAddressError(hostname), []);
				if (options.all) callback(null, addresses);
				else callback(null, addresses[0].address, addresses[0].family);
			});
		}
	};
}
function privateAddressError(host) {
	return Object.assign(/* @__PURE__ */ new Error(`${host} resolves to a private address`), { code: "EPRIVATE" });
}
/** Refuse an IP literal the policy does not allow (literals are connected to without a lookup). */
function checkLiteral(policy, host) {
	const literal = host.replace(/^\[|\]$/g, "");
	if (isIP(literal) && !policy.allows(literal)) throw errors.forbidden("Address is private");
}
/**
* A `fetch` for user- or remote-chosen URLs that connects only to addresses `policy` allows.
* Redirects are never followed: callers that follow them send the next request through this
* function again, so each target is checked. Only http(s) URLs are accepted.
*
* With a custom `fetch` (the `fetch` option, e.g. for a proxy), the host is resolved and checked
* before the request instead. That leaves the DNS-rebinding window open; the custom client is the
* operator's to secure.
*/
function policyFetch(policy, custom) {
	return async (input, init = {}) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.protocol !== "http:" && url.protocol !== "https:") throw errors.forbidden("Only http and https URLs can be fetched");
		checkLiteral(policy, url.hostname);
		if (custom) {
			if (policy.lookup && !isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
				if (!(await lookup(url.hostname, { all: true })).every((a) => policy.allows(a.address))) throw errors.forbidden("Address is private");
			}
			return custom(input, {
				...init,
				redirect: "manual"
			});
		}
		return nodeFetch(url, init, policy);
	};
}
const NULL_BODY = /* @__PURE__ */ new Set([
	101,
	103,
	204,
	205,
	304
]);
function nodeFetch(url, init, policy) {
	const method = (init.method ?? "GET").toUpperCase();
	const headers = new Headers(init.headers);
	const body = init.body === void 0 || init.body === null ? void 0 : typeof init.body === "string" || init.body instanceof URLSearchParams ? Buffer.from(String(init.body)) : Buffer.from(init.body);
	if (body && init.body instanceof URLSearchParams && !headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
	const request$2 = url.protocol === "https:" ? request : request$1;
	return new Promise((resolve, reject) => {
		const req = request$2(url, {
			method,
			headers: Object.fromEntries(headers),
			lookup: policy.lookup,
			signal: init.signal ?? void 0
		}, (res) => {
			const out = new Headers();
			for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
			const status = res.statusCode ?? 502;
			const nullBody = NULL_BODY.has(status) || method === "HEAD";
			if (nullBody) res.resume();
			resolve(new Response(nullBody ? null : Readable.toWeb(res), {
				status,
				statusText: res.statusMessage,
				headers: out
			}));
		});
		req.on("error", (err) => reject(err.code === "EPRIVATE" ? errors.forbidden("Address is private") : err));
		req.end(body);
	});
}
/** GET a URL through a `policyFetch`, following redirects (each one checked again) and capping the body. */
async function publicGet(fetchFn, rawUrl, options) {
	let url = new URL(rawUrl);
	const signal = AbortSignal.timeout(options.timeoutMs ?? 3e4);
	for (let redirects = 0;; redirects++) {
		const res = await fetchFn(url, {
			redirect: "manual",
			signal,
			headers: options.headers
		});
		const location = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && location) {
			await res.body?.cancel();
			if (redirects >= (options.maxRedirects ?? 5)) throw errors.notFound("Too many redirects");
			url = new URL(location, url);
			continue;
		}
		if (Number(res.headers.get("content-length")) > options.maxBytes && !options.truncate) {
			await res.body?.cancel();
			throw errors.tooLarge("Remote response is too large");
		}
		const chunks = [];
		let size = 0;
		for await (const chunk of res.body ?? []) {
			size += chunk.length;
			if (size > options.maxBytes) {
				await res.body?.cancel().catch(() => {});
				if (!options.truncate) throw errors.tooLarge("Remote response is too large");
				chunks.push(chunk.subarray(0, chunk.length - (size - options.maxBytes)));
				break;
			}
			chunks.push(chunk);
		}
		return {
			status: res.status,
			headers: res.headers,
			body: Buffer.concat(chunks),
			url
		};
	}
}
export { addressPolicy, checkLiteral, isPrivateAddress, policyFetch, publicGet };

//# sourceMappingURL=outbound.js.map