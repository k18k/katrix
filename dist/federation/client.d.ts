import { Homeserver } from "../homeserver.js";
export interface FederationRequestOptions {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  /** Sign the request with X-Matrix auth. Default: true. */
  signed?: boolean;
  timeoutMs?: number;
}
export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
/** Signs and sends server-server requests, implementing Matrix server discovery. */
export declare class FederationClient {
  private hs;
  private resolved;
  /** One connection pool per destination, so a dead peer's sockets can be dropped without affecting others. */
  private agents;
  private rejectUnauthorized;
  constructor(hs: Homeserver, opts?: {
    rejectUnauthorized?: boolean;
  });
  private agentFor;
  /** Drop pooled connections to a destination (after errors, the peer may have restarted). */
  resetConnections(destination: string): void;
  /** Build the X-Matrix Authorization header value for a request. */
  authHeader(destination: string, method: string, uri: string, content?: unknown): string;
  resolve(serverName: string): Promise<{
    host: string;
    port: number;
    hostHeader: any;
    tlsName: string;
    expires: number;
  }>;
  private discover;
  private wellKnown;
  private srv;
  private raw;
  private pathWithQuery;
  /** Send a request and return the raw response (used for media). */
  requestRaw(destination: string, method: string, path: string, opts?: FederationRequestOptions): Promise<RawResponse>;
  /** Send a request and parse the JSON response; non-2xx responses throw a MatrixError. */
  request(destination: string, method: string, path: string, opts?: FederationRequestOptions): Promise<Record<string, unknown>>;
}
//# sourceMappingURL=client.d.ts.map