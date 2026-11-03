import type { IncomingMessage, ServerResponse } from "node:http";
import type { Homeserver } from "#homeserver.ts";
/** Paths this library serves. Framework adapters forward only these. */
export declare function isMatrixPath(pathname: string): boolean;
/** A web-standard fetch handler: `(Request) => Promise<Response>`. Works with Hono, Bun, Deno, workers… */
export declare function getFetchHandler(hs: Homeserver): (request: Request) => Promise<Response>;
export type NodeHandler = (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void;
/**
 * A request listener for `node:http` / `node:https` / `node:http2` (compat).
 * Also usable directly as Express/Connect middleware: non-Matrix paths are
 * passed to `next()` when it is provided, otherwise answered with 404.
 */
export declare function getNodeHandler(hs: Homeserver): NodeHandler;
/** Express / Connect middleware. Mount with `app.use(getExpressHandler(hs))`. */
export declare function getExpressHandler(hs: Homeserver): (req: any, res: any, next: (err?: unknown) => void) => void;
/** Minimal structural Fastify types so that fastify is not a dependency. */
interface FastifyLike {
    removeAllContentTypeParsers(): void;
    addContentTypeParser(type: string, opts: {
        parseAs: "buffer";
    }, parser: (req: any, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void): void;
    route(opts: {
        method: string[];
        url: string;
        handler: (request: any, reply: any) => unknown;
    }): void;
}
/**
 * Fastify plugin. Register with `fastify.register(getFastifyPlugin(hs))`.
 * The plugin is encapsulated so its raw body parser does not leak into your app.
 */
export declare function getFastifyPlugin(hs: Homeserver): (fastify: FastifyLike, opts: unknown, done?: (err?: Error) => void) => Promise<void>;
/**
 * Hono handler. Mount with `app.all("*", getHonoHandler(hs))` or
 * `app.mount("/", getFetchHandler(hs))`. Non-Matrix paths call `next()`.
 */
export declare function getHonoHandler(hs: Homeserver): (c: any, next: () => Promise<void>) => Promise<Response | void>;
export {};
