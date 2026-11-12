import { LookupAddress, LookupOptions } from "node:dns";
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
export {};
//# sourceMappingURL=outbound.d.ts.map