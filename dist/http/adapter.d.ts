import { type AbortSignalLike, type FetchLike } from "../platform.ts";
/**
 * Level 4: HTTP. The client sends every request through this adapter; the default one wraps the
 * platform's fetch (Node.js 18+, browsers, React Native), and tests or apps can pass their own (a
 * homeserver's in-process fetch handler, a proxy, a mock).
 */
export interface HttpRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body?: string | Uint8Array;
    readonly signal?: AbortSignalLike;
}
export interface HttpResponse {
    readonly status: number;
    header(name: string): string | undefined;
    text(): Promise<string>;
    bytes(): Promise<Uint8Array>;
}
export interface HttpAdapter {
    request(req: HttpRequest): Promise<HttpResponse>;
}
/** An adapter on a fetch function (the platform's by default). */
export declare function fetchHttpAdapter(fetchFn?: FetchLike): HttpAdapter;
