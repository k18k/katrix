/**
 * Authentication. The client itself only needs an access token for each request and, when the
 * server says it expired, a way to get a new one: a TokenProvider. How the tokens were obtained
 * (password login, SSO login token, OAuth 2.0 / OIDC with the next-generation auth API) is up to
 * the provider, so a new login method needs no change in the client.
 */

export interface TokenProvider {
  /** The current access token, if any. */
  accessToken(): string | undefined;
  /**
   * Get a new access token after the server rejected the current one (401 M_UNKNOWN_TOKEN).
   * Resolves true if there is a new token to retry with, false if the session is over.
   */
  refresh?(): Promise<boolean>;
}

/** What a login returns: who the client is and the tokens to act as them. */
export interface Credentials {
  readonly userId: string;
  readonly deviceId: string;
  readonly accessToken: string;
  /** With refresh tokens (https://spec.matrix.org/v1.16/client-server-api/#refreshing-access-tokens). */
  readonly refreshToken?: string;
  /** When the access token expires (ms since the epoch), if the server said. */
  readonly expiresAt?: number;
  /** How to refresh: the legacy /refresh endpoint, or the OAuth 2.0 token endpoint. */
  readonly refresh?: { readonly kind: "matrix" } | { readonly kind: "oauth"; readonly tokenEndpoint: string; readonly clientId: string };
}

/** A provider for fixed credentials, refreshing them when they have a refresh token. */
export interface CredentialsStore {
  /** Called with new tokens after a refresh: persist them (in the platform's secure storage). */
  onTokensRefreshed?(credentials: Credentials): void | Promise<void>;
}
