/**
 * Query strings and form bodies without URL/URLSearchParams: React Native's versions are
 * incomplete (several methods throw "not implemented").
 */
export type QueryValue = string | number | boolean | undefined | null | ReadonlyArray<string>;
export declare function encodeQuery(params: Record<string, QueryValue>): string;
/** Parse the query of a URL (for example an OAuth redirect) into its first value per key. */
export declare function parseQuery(url: string): Record<string, string>;
/** `/rooms/${roomId}/send/…` with every interpolated value percent-encoded as one path segment. */
export declare function path(strings: TemplateStringsArray, ...values: Array<string | number>): string;
