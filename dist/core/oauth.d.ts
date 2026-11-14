import { Homeserver } from "../homeserver.js";
import { Session } from "./auth.js";
/**
 * Delegate authentication to an external OAuth 2.0 / OpenID Connect provider
 * (Matrix "OAuth 2.0 API", e.g. matrix-authentication-service, Keycloak, Authentik).
 */
export interface OAuthDelegationOptions {
  /** Issuer URL of the authorization server. */
  issuer: string;
  /** Client credentials the homeserver uses for token introspection. */
  clientId: string;
  clientSecret: string;
  /** Override the introspection endpoint instead of discovering it. */
  introspectionEndpoint?: string;
  /** Where users manage their account (advertised to clients). */
  accountManagementUrl?: string;
  /** Map introspection claims to a Matrix localpart. Default: `username`, then `sub`. */
  localpartFromClaims?: (claims: Record<string, unknown>) => string | null;
  /** Scope granting server admin rights. Default: "urn:synapse:admin:*". */
  adminScope?: string;
  /** How long successful introspections are cached, in ms. Default: 60 000. */
  cacheTtlMs?: number;
}
export declare class OAuthDelegation {
  private hs;
  readonly options: OAuthDelegationOptions;
  private metadata;
  private metadataFetched;
  private cache;
  constructor(hs: Homeserver, options: OAuthDelegationOptions);
  /** Authorization server metadata (RFC 8414 / OIDC discovery), cached for an hour. */
  serverMetadata(): Promise<Record<string, unknown>>;
  /** Validate an access token by introspection, provisioning the user and device on first use. */
  authenticate(token: string): Promise<Session>;
  forget(token: string): void;
}
//# sourceMappingURL=oauth.d.ts.map