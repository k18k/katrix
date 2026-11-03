import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { handleRequest, maxRequestBody } from "#http/handler.ts";
/** Paths this library serves. Framework adapters forward only these. */
export function isMatrixPath(pathname) {
    return pathname.startsWith("/_matrix/") || pathname.startsWith("/.well-known/matrix/") || pathname.startsWith("/_synapse/");
}
/** A web-standard fetch handler: `(Request) => Promise<Response>`. Works with Hono, Bun, Deno, workers… */
export function getFetchHandler(hs) {
    return (request) => handleRequest(hs, request);
}
/** The body of a Node request as a web stream that reads from the socket only when pulled, so nothing is read ahead. */
function bodyStream(chunks) {
    return new ReadableStream({
        async pull(controller) {
            const { done, value } = await chunks.next();
            if (done)
                controller.close();
            else
                controller.enqueue(value);
        },
    }, { highWaterMark: 0 });
}
/** Read and drop what is left of a request body; false when more than `budget` bytes are left. */
async function drain(req, chunks, budget, timeoutMs) {
    if (Number(req.headers["content-length"]) > budget)
        return false;
    let dropped = 0;
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs, false)));
    const read = (async () => {
        for (;;) {
            const { done, value } = await chunks.next();
            if (done)
                return true;
            dropped += value.length;
            if (dropped > budget)
                return false;
        }
    })().catch(() => false);
    try {
        return await Promise.race([read, late]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** How long a response waits, after it was sent, for the rest of a body nobody read (#103). */
const DRAIN_MS = 5_000;
async function toWebRequest(req, presetBody) {
    const proto = req.socket?.encrypted ? "https" : "http";
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.originalUrl ?? req.url ?? "/", `${proto}://${host}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || key.startsWith(":"))
            continue;
        if (Array.isArray(value))
            for (const v of value)
                headers.append(key, v);
        else
            headers.set(key, value);
    }
    const method = req.method ?? "GET";
    let body = undefined;
    let unread;
    if (method !== "GET" && method !== "HEAD") {
        const pre = presetBody !== undefined ? presetBody : req.body;
        if (pre !== undefined && pre !== null && req.readableEnded !== false) {
            // A framework body-parser already consumed the stream.
            if (pre instanceof Uint8Array || typeof pre === "string")
                body = pre;
            else if (typeof pre === "object" && Object.keys(pre).length === 0 && headers.get("content-length") === null)
                body = undefined;
            else
                body = JSON.stringify(pre);
            headers.delete("content-length");
        }
        else {
            // https://github.com/k18k/katrix/issues/77 — uncontrolled resource consumption (CWE-400):
            // the whole body used to be buffered here, before routing and authentication, with no limit. It is now
            // passed on as a stream, read only by a handler that needs it, under the size limit in handler.ts.
            unread = req[Symbol.asyncIterator]();
            body = bodyStream(unread);
        }
    }
    return { request: new Request(url, { method, headers, body, duplex: "half" }), unread };
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
export function getNodeHandler(hs) {
    return (req, res, next) => {
        const path = (req.url ?? "/").split("?")[0];
        if (next && !isMatrixPath(path)) {
            next();
            return;
        }
        (async () => {
            const { request, unread } = await toWebRequest(req);
            const response = await handleRequest(hs, request, { ip: req.socket?.remoteAddress ?? null });
            // #77: the handler may answer without reading the whole body: refused as too large, or not needed, as when
            // authentication fails. Closing the connection with unread data resets it, and the client may lose the
            // response (and with it, say, the 401 that tells it to refresh its token). So the rest is read and dropped,
            // but only up to the body limit; past it the connection is closed instead, as Synapse does.
            // https://github.com/k18k/katrix/issues/103: the response waited for that, so a client that
            // stopped sending got no answer, even a ready 401, until Node's request timeout. The response now goes out at
            // once while the rest is dropped, within DRAIN_MS; the connection is closed once it is sent if that fails.
            const draining = unread ? drain(req, unread, maxRequestBody(hs), DRAIN_MS) : null;
            await writeWebResponse(res, response);
            if (draining)
                void Promise.all([draining, finished(res).catch(() => { })]).then(([drained]) => {
                    if (!drained)
                        req.socket?.destroy();
                });
        })().catch((err) => {
            if (next)
                next(err);
            else {
                hs.logger.error("Node handler failure", err);
                if (!res.headersSent)
                    res.statusCode = 500;
                res.end();
            }
        });
    };
}
/** Express / Connect middleware. Mount with `app.use(getExpressHandler(hs))`. */
export function getExpressHandler(hs) {
    return getNodeHandler(hs);
}
/**
 * Fastify plugin. Register with `fastify.register(getFastifyPlugin(hs))`.
 * The plugin is encapsulated so its raw body parser does not leak into your app.
 */
export function getFastifyPlugin(hs) {
    return async (fastify) => {
        fastify.removeAllContentTypeParsers();
        fastify.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
        const handler = async (request, reply) => {
            const { request: webRequest } = await toWebRequest(request.raw, request.body ?? new Uint8Array());
            const response = await handleRequest(hs, webRequest, { ip: request.ip ?? null });
            reply.status(response.status);
            response.headers.forEach((value, key) => reply.header(key, value));
            return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
        };
        const methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"];
        for (const url of ["/_matrix/*", "/.well-known/matrix/*", "/_synapse/*"]) {
            fastify.route({ method: methods, url, handler });
        }
    };
}
/**
 * Hono handler. Mount with `app.all("*", getHonoHandler(hs))` or
 * `app.mount("/", getFetchHandler(hs))`. Non-Matrix paths call `next()`.
 */
export function getHonoHandler(hs) {
    return async (c, next) => {
        const request = c.req.raw;
        if (!isMatrixPath(new URL(request.url).pathname))
            return next();
        const ip = c.env?.incoming?.socket?.remoteAddress ?? null;
        return handleRequest(hs, request, { ip });
    };
}
