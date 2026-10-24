import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup as lookupAsync } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { errors } from "#core/errors.ts";

// Outbound requests to addresses that users or remote servers choose: federation destinations,
// media locations named by remote servers, push gateways, identity servers, URL previews. Such an
// address must not lead the server into its own network (localhost, LAN, cloud metadata), or the
// requester reaches services that are not meant to be public (SSRF, CWE-918).
//
// Decision (https://github.com/k18k/katrix/issues/22): private addresses are
// refused by default for all of these, with one server-wide option, `allowPrivateAddresses`:
// `true` for test networks and LAN-only deployments, or a list of ranges such as
// `["127.0.0.1/32"]` for a push gateway on the same machine. Synapse does the same
// (`ip_range_blacklist`); a deployment that federates over a LAN has to opt in, which is the safer
// way round. Addresses the operator configures (SSO and OAuth providers, application services)
// are not checked: localhost is normal there and no user can change them.

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
  ["240.0.0.0", 4],
] as const) {
  privateRanges.addSubnet(net, prefix, "ipv4");
}
// https://github.com/k18k/katrix/issues/21: the list also had the IPv4-mapped
// range ::ffff:0:0/96, which BlockList treats as all of IPv4, so every IPv4 host counted as
// private. It is not needed: IPv4-mapped addresses are checked against the IPv4 ranges above.
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  privateRanges.addSubnet(net, prefix, "ipv6");
}

/** Whether an IP address is loopback, private, link-local, multicast or otherwise not public. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && privateRanges.check(address, family === 6 ? "ipv6" : "ipv4");
}

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
export function addressPolicy(allowPrivate: boolean | string[] | undefined): AddressPolicy {
  if (allowPrivate === true) return { allows: () => true };
  const allowed = new BlockList();
  for (const entry of Array.isArray(allowPrivate) ? allowPrivate : []) {
    const [address, prefix] = entry.split("/");
    const family = isIP(address);
    if (family === 0) throw new Error(`allowPrivateAddresses: not an IP address or range: ${entry}`);
    allowed.addSubnet(address, prefix === undefined ? (family === 6 ? 128 : 32) : Number(prefix), family === 6 ? "ipv6" : "ipv4");
  }
  const allows = (address: string) => !isPrivateAddress(address) || allowed.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
  return {
    allows,
    lookup: (hostname, options, callback) => {
      lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, []);
        if (addresses.length === 0 || !addresses.every((a) => allows(a.address))) return callback(privateAddressError(hostname), []);
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      });
    },
  };
}

function privateAddressError(host: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${host} resolves to a private address`), { code: "EPRIVATE" });
}

/** Refuse an IP literal the policy does not allow (literals are connected to without a lookup). */
export function checkLiteral(policy: AddressPolicy, host: string): void {
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
export function policyFetch(policy: AddressPolicy, custom?: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw errors.forbidden("Only http and https URLs can be fetched");
    checkLiteral(policy, url.hostname);
    if (custom) {
      if (policy.lookup && !isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
        const addresses = await lookupAsync(url.hostname, { all: true });
        if (!addresses.every((a) => policy.allows(a.address))) throw errors.forbidden("Address is private");
      }
      return custom(input, { ...init, redirect: "manual" });
    }
    return nodeFetch(url, init, policy);
  };
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function nodeFetch(url: URL, init: RequestInit, policy: AddressPolicy): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const body =
    init.body === undefined || init.body === null
      ? undefined
      : typeof init.body === "string" || init.body instanceof URLSearchParams
        ? Buffer.from(String(init.body))
        : Buffer.from(init.body as Uint8Array);
  if (body && init.body instanceof URLSearchParams && !headers.has("content-type"))
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method, headers: Object.fromEntries(headers), lookup: policy.lookup, signal: init.signal ?? undefined },
      (res) => {
        const out = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const status = res.statusCode ?? 502;
        const nullBody = NULL_BODY.has(status) || method === "HEAD";
        if (nullBody) res.resume();
        resolve(
          new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers: out }),
        );
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => reject(err.code === "EPRIVATE" ? errors.forbidden("Address is private") : err));
    req.end(body);
  });
}

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
export async function publicGet(
  fetchFn: typeof globalThis.fetch,
  rawUrl: string | URL,
  options: PublicGetOptions,
): Promise<PublicResponse> {
  let url = new URL(rawUrl);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  for (let redirects = 0; ; redirects++) {
    const res = await fetchFn(url, { redirect: "manual", signal, headers: options.headers });
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
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > options.maxBytes) {
        await res.body?.cancel().catch(() => {});
        if (!options.truncate) throw errors.tooLarge("Remote response is too large");
        chunks.push(chunk.subarray(0, chunk.length - (size - options.maxBytes)));
        break;
      }
      chunks.push(chunk);
    }
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks), url };
  }
}
