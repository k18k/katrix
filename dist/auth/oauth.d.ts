import { CryptoPrimitives } from "../crypto/primitives.js";
import { AuthMetadata } from "../shared/api/auth.js";
import { HttpAdapter } from "../http/adapter.js";
import { MatrixHttpApi } from "../http/api.js";
/**
 * OAuth 2.0 login, the "next-generation auth" of the Matrix spec
 * (https://spec.matrix.org/v1.16/client-server-api/#oauth-20-api): server metadata discovery,
 * dynamic client registration, the authorization code flow with PKCE (S256), and refresh.
 * The browser step (opening `url`, receiving the redirect) belongs to the app; the result plugs
 * into CredentialsTokenProvider as Credentials with `refresh.kind = "oauth"`.
 */
export declare function getAuthMetadata(api: MatrixHttpApi): Promise<AuthMetadata>;
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}
export declare function refreshOAuthToken(http: HttpAdapter, tokenEndpoint: string, clientId: string, refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number | undefined;
}>;
/** Dynamic client registration (RFC 7591), as the spec requires clients to do. */
export declare function registerClient(http: HttpAdapter, metadata: AuthMetadata, client: Record<string, unknown>): Promise<string>;
export interface AuthorizationRequest {
  url: string;
  /** Keep these until the redirect comes back; they are secrets of this login attempt. */
  state: string;
  codeVerifier: string;
  deviceId: string;
  redirectUri: string;
}
export declare function createAuthorizationRequest(p: CryptoPrimitives, opts: {
  metadata: AuthMetadata;
  clientId: string;
  redirectUri: string;
  deviceId?: string;
  responseMode?: "query" | "fragment";
}): {
  url: string;
  state: string;
  codeVerifier: string;
  deviceId: string;
  redirectUri: string;
};
/** Exchange the code from the redirect for tokens, after checking `state` (CSRF). */
export declare function completeAuthorization(http: HttpAdapter, opts: {
  metadata: AuthMetadata;
  clientId: string;
  request: AuthorizationRequest;
  callbackUrl: string;
}): Promise<{
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number | undefined;
}>;
//# sourceMappingURL=oauth.d.ts.map