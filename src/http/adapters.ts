import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Homeserver } from "../homeserver.ts";
import { handleRequest } from "./handler.ts";

/** Paths this library serves. Framework adapters forward only these. */
export function isMatrixPath(pathname: string): boolean {
  return pathname.startsWith("/_matrix/") || pathname.startsWith("/.well-known/matrix/") || pathname.startsWith("/_synapse/");
}

/** A web-standard fetch handler: `(Request) => Promise<Response>`. Works with Hono, Bun, Deno, workers… */
export function getFetchHandler(hs: Homeserver): (request: Request) => Promise<Response> {
  return (request) => handleRequest(hs, request);
}

type NodeRequestWithBody = IncomingMessage & { body?: unknown; originalUrl?: string };

async function toWebRequest(req: NodeRequestWithBody, presetBody?: unknown): Promise<Request> {
  const proto = (req.socket as any)?.encrypted ? "https" : "http";
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.originalUrl ?? req.url ?? "/", `${proto}://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key.startsWith(":")) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const method = req.method ?? "GET";
  let body: any = undefined;
  if (method !== "GET" && method !== "HEAD") {
    const pre = presetBody !== undefined ? presetBody : req.body;
    if (pre !== undefined && pre !== null && (req as any).readableEnded !== false) {
      // A framework body-parser already consumed the stream.
      if (pre instanceof Uint8Array || typeof pre === "string") body = pre as any;
      else if (typeof pre === "object" && Object.keys(pre as object).length === 0 && headers.get("content-length") === null)
        body = undefined;
      else body = JSON.stringify(pre);
      headers.delete("content-length");
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = Buffer.concat(chunks);
    }
  }
  return new Request(url, { method, headers, body });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(response.body as any);
  nodeStream.on("error", () => res.destroy());
  nodeStream.pipe(res);
}

export type NodeHandler = (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void;

/**
 * A request listener for `node:http` / `node:https` / `node:http2` (compat).
 * Also usable directly as Express/Connect middleware: non-Matrix paths are
 * passed to `next()` when it is provided, otherwise answered with 404.
 */
export function getNodeHandler(hs: Homeserver): NodeHandler {
  return (req, res, next) => {
    const path = (req.url ?? "/").split("?")[0];
    if (next && !isMatrixPath(path)) {
      next();
      return;
    }
    (async () => {
      const request = await toWebRequest(req as NodeRequestWithBody);
      const response = await handleRequest(hs, request, { ip: req.socket?.remoteAddress ?? null });
      await writeWebResponse(res, response);
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
export function getExpressHandler(hs: Homeserver): (req: any, res: any, next: (err?: unknown) => void) => void {
  return getNodeHandler(hs) as any;
}

/** Minimal structural Fastify types so that fastify is not a dependency. */
interface FastifyLike {
  removeAllContentTypeParsers(): void;
  addContentTypeParser(
    type: string,
    opts: { parseAs: "buffer" },
    parser: (req: any, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void,
  ): void;
  route(opts: { method: string[]; url: string; handler: (request: any, reply: any) => unknown }): void;
}

/**
 * Fastify plugin. Register with `fastify.register(getFastifyPlugin(hs))`.
 * The plugin is encapsulated so its raw body parser does not leak into your app.
 */
export function getFastifyPlugin(hs: Homeserver): (fastify: FastifyLike, opts: unknown, done?: (err?: Error) => void) => Promise<void> {
  return async (fastify) => {
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const handler = async (request: any, reply: any) => {
      const webRequest = await toWebRequest(request.raw, request.body ?? new Uint8Array());
      const response = await handleRequest(hs, webRequest, { ip: request.ip ?? null });
      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => reply.header(key, value));
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
export function getHonoHandler(hs: Homeserver): (c: any, next: () => Promise<void>) => Promise<Response | void> {
  return async (c, next) => {
    const request: Request = c.req.raw;
    if (!isMatrixPath(new URL(request.url).pathname)) return next();
    const ip = c.env?.incoming?.socket?.remoteAddress ?? null;
    return handleRequest(hs, request, { ip });
  };
}
