import { type LookupAddress, type LookupOptions } from "node:dns";
/** Whether an IP address is loopback, private, link-local, multicast or otherwise not public. */
export declare function isPrivateAddress(address: string): boolean;
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
/** Which addresses outbound requests to user- or remote-chosen destinations may connect to. */
export interface AddressPolicy {
    allows(address: string): boolean;
    /**
     * A `dns.lookup` for http(s) requests that refuses disallowed addresses. It runs when the
     * connection is made, so the address checked is the one connected to: a name cannot resolve to
     * a public address for a check and to a private one for the request (DNS rebinding).
     * Undefined when every address is allowed.
     */
    lookup?: (hostname: string, options: LookupOptions, callback: LookupCallback) => void;
}
/** The policy for the `allowPrivateAddresses` option. */
export declare function addressPolicy(allowPrivate: boolean | string[] | undefined): AddressPolicy;
/** Refuse an IP literal the policy does not allow (literals are connected to without a lookup). */
export declare function checkLiteral(policy: AddressPolicy, host: string): void;
/**
 * A `fetch` for user- or remote-chosen URLs that connects only to addresses `policy` allows.
 * Redirects are never followed: callers that follow them send the next request through this
 * function again, so each target is checked. Only http(s) URLs are accepted.
 *
 * With a custom `fetch` (the `fetch` option, e.g. for a proxy), the host is resolved and checked
 * before the request instead. That leaves the DNS-rebinding window open; the custom client is the
 * operator's to secure.
 */
export declare function policyFetch(policy: AddressPolicy, custom?: typeof globalThis.fetch): typeof globalThis.fetch;
export interface PublicGetOptions {
    /** Largest body to read. */
    maxBytes: number;
    /** Return the first `maxBytes` of a longer body instead of refusing it (e.g. HTML, whose head is enough). */
    truncate?: boolean;
    maxRedirects?: number;
    timeoutMs?: number;
    headers?: Record<string, string>;
}
export interface PublicResponse {
    status: number;
    headers: Headers;
    body: Buffer;
    /** The URL that answered, after redirects. */
    url: URL;
}
/** GET a URL through a `policyFetch`, following redirects (each one checked again) and capping the body. */
export declare function publicGet(fetchFn: typeof globalThis.fetch, rawUrl: string | URL, options: PublicGetOptions): Promise<PublicResponse>;
export {};
