import { handleRequest, maxRequestBody } from "./handler.js";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
// src/http/adapters.ts
/** Paths this library serves. Framework adapters forward only these. */
function isMatrixPath(pathname) {
	return pathname.startsWith("/_matrix/") || pathname.startsWith("/.well-known/matrix/") || pathname.startsWith("/_synapse/");
}
/** A web-standard fetch handler: `(Request) => Promise<Response>`. Works with Hono, Bun, Deno, workers… */
function getFetchHandler(hs) {
	return (request) => handleRequest(hs, request);
}
/** The body of a Node request as a web stream that reads from the socket only when pulled, so nothing is read ahead. */
function bodyStream(chunks) {
	return new ReadableStream({ async pull(controller) {
		const { done, value } = await chunks.next();
		if (done) controller.close();
		else controller.enqueue(value);
	} }, { highWaterMark: 0 });
}
/** Read and drop what is left of a request body; false when more than `budget` bytes are left. */
async function drain(req, chunks, budget, timeoutMs) {
	if (Number(req.headers["content-length"]) > budget) return false;
	let dropped = 0;
	let timer;
	const late = new Promise((resolve) => timer = setTimeout(resolve, timeoutMs, false));
	const read = (async () => {
		for (;;) {
			const { done, value } = await chunks.next();
			if (done) return true;
			dropped += value.length;
			if (dropped > budget) return false;
		}
	})().catch(() => false);
	try {
		return await Promise.race([read, late]);
	} finally {
		clearTimeout(timer);
	}
}
/** How long a response waits, after it was sent, for the rest of a body nobody read (#103). */
const DRAIN_MS = 5e3;
async function toWebRequest(req) {
	const proto = req.socket?.encrypted ? "https" : "http";
	const host = req.headers.host ?? "localhost";
	const url = new URL(req.originalUrl ?? req.url ?? "/", `${proto}://${host}`);
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === void 0 || key.startsWith(":")) continue;
		if (Array.isArray(value)) for (const v of value) headers.append(key, v);
		else headers.set(key, value);
	}
	const method = req.method ?? "GET";
	let body = void 0;
	let unread;
	if (method !== "GET" && method !== "HEAD") {
		const pre = req.body;
		if (pre !== void 0 && pre !== null && req.readableEnded !== false) {
			if (pre instanceof Uint8Array || typeof pre === "string") body = pre;
			else if (typeof pre === "object" && Object.keys(pre).length === 0 && headers.get("content-length") === null) body = void 0;
			else body = JSON.stringify(pre);
			headers.delete("content-length");
		} else {
			unread = req[Symbol.asyncIterator]();
			body = bodyStream(unread);
		}
	}
	return {
		request: new Request(url, {
			method,
			headers,
			body,
			duplex: "half"
		}),
		unread
	};
}
async function writeWebResponse(res, response) {
	res.statusCode = response.status;
	response.headers.forEach((value, key) => res.setHeader(key, value));
	if (!response.body) {
		res.end();
		return;
	}
	const nodeStream = Readable.fromWeb(response.body);
	nodeStream.on("error", () => res.destroy());
	nodeStream.pipe(res);
}
/**
* A request listener for `node:http` / `node:https` / `node:http2` (compat).
* Also usable directly as Express/Connect middleware: non-Matrix paths are
* passed to `next()` when it is provided, otherwise answered with 404.
*/
function getNodeHandler(hs) {
	return (req, res, next) => {
		const path = (req.url ?? "/").split("?")[0];
		if (next && !isMatrixPath(path)) {
			next();
			return;
		}
		(async () => {
			const { request, unread } = await toWebRequest(req);
			const response = await handleRequest(hs, request, { ip: req.socket?.remoteAddress ?? null });
			const draining = unread ? drain(req, unread, maxRequestBody(hs), DRAIN_MS) : null;
			await writeWebResponse(res, response);
			if (draining) Promise.all([draining, finished(res).catch(() => {})]).then(([drained]) => {
				if (!drained) req.socket?.destroy();
			});
		})().catch((err) => {
			if (next) next(err);
			else {
				hs.logger.error("Node handler failure", err);
				if (!res.headersSent) res.statusCode = 500;
				res.end();
			}
		});
	};
}
/** Express / Connect middleware. Mount with `app.use(getExpressHandler(hs))`. */
function getExpressHandler(hs) {
	return getNodeHandler(hs);
}
/**
* Fastify plugin. Register with `fastify.register(getFastifyPlugin(hs))`.
* The plugin is encapsulated so its pass-through body parser does not leak into your app.
*/
function getFastifyPlugin(hs) {
	return async (fastify) => {
		fastify.removeAllContentTypeParsers();
		fastify.addContentTypeParser("*", { bodyLimit: maxRequestBody(hs) }, (_req, _payload, done) => done(null));
		const handler = async (request, reply) => {
			const { request: webRequest } = await toWebRequest(request.raw);
			const response = await handleRequest(hs, webRequest, { ip: request.ip ?? null });
			reply.status(response.status);
			response.headers.forEach((value, key) => reply.header(key, value));
			return reply.send(response.body ? Readable.fromWeb(response.body) : null);
		};
		const methods = [
			"GET",
			"POST",
			"PUT",
			"DELETE",
			"OPTIONS",
			"HEAD"
		];
		for (const url of [
			"/_matrix/*",
			"/.well-known/matrix/*",
			"/_synapse/*"
		]) fastify.route({
			method: methods,
			url,
			handler
		});
	};
}
/**
* Hono handler. Mount with `app.all("*", getHonoHandler(hs))` or
* `app.mount("/", getFetchHandler(hs))`. Non-Matrix paths call `next()`.
*/
function getHonoHandler(hs) {
	return async (c, next) => {
		const request = c.req.raw;
		if (!isMatrixPath(new URL(request.url).pathname)) return next();
		const ip = c.env?.incoming?.socket?.remoteAddress ?? null;
		return handleRequest(hs, request, { ip });
	};
}
export { getExpressHandler, getFastifyPlugin, getFetchHandler, getHonoHandler, getNodeHandler, isMatrixPath };

//# sourceMappingURL=adapters.js.map