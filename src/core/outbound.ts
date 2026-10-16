import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { errors } from "#core/errors.ts";

// Outbound requests to addresses that users or remote servers choose. Such an address must not
// lead the server to its own network (localhost, private ranges, cloud metadata): that would let
// the requester reach services that are not meant to be public (SSRF).

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
// https://github.com/k18k/matrix-nodejs-homeserver/issues/21: the list also had the IPv4-mapped
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

/**
 * A DNS lookup that refuses names resolving to non-public addresses. It runs when the connection
 * is made, so the address checked is the address connected to: a name cannot resolve to a public
 * address for a check and to a private one for the request (DNS rebinding).
 */
function publicLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" }), []);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

export interface PublicRequestOptions {
  /** Allow private addresses too (for deployments and test networks that need them). */
  allowPrivateAddresses?: boolean;
  /** Largest body to read; a longer response is refused. */
  maxBytes: number;
  maxRedirects?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface PublicResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The URL that answered, after redirects. */
  url: string;
}

/**
 * GET an http(s) URL that a user or a remote server supplied. Only public addresses are
 * connected to (unless `allowPrivateAddresses`), redirects are followed by hand and each target
 * is checked the same way, and the body is capped at `maxBytes`.
 */
export async function publicGet(rawUrl: string, options: PublicRequestOptions): Promise<PublicResponse> {
  let url = parseHttpUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    const res = await getOnce(url, options);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      if (redirects >= (options.maxRedirects ?? 5)) throw errors.notFound("Too many redirects");
      url = parseHttpUrl(new URL(location, url).toString());
      continue;
    }
    return res;
  }
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw errors.forbidden("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw errors.forbidden("Only http and https URLs can be fetched");
  return url;
}

function getOnce(url: URL, options: PublicRequestOptions): Promise<PublicResponse> {
  // An IP address in the URL is connected to without a lookup, so it is checked here.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (!options.allowPrivateAddresses && isPrivateAddress(literal))
    return Promise.reject(errors.forbidden("URL points to a private address"));
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: options.headers,
        lookup: options.allowPrivateAddresses ? undefined : publicLookup,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      },
      (res) => {
        const declared = Number(res.headers["content-length"]);
        if (declared > options.maxBytes) {
          res.destroy();
          return reject(errors.tooLarge("Remote response is too large"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            res.destroy();
            reject(errors.tooLarge("Remote response is too large"));
          } else chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), url: url.toString() }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EPRIVATE" ? errors.forbidden("URL resolves to a private address") : err),
    );
    req.end();
  });
}
