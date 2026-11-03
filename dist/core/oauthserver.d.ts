import type { Homeserver } from "#homeserver.ts";
export interface OAuthServerOptions {
    /**
     * Keep the legacy login API (`/login`, `/register`) next to the OAuth 2.0 API. Its `m.login.sso`
     * flow then goes through the same web login and is marked `oauth_aware_preferred`. Default: true.
     */
    legacyApi?: boolean;
    /** Lifetime of access tokens issued through the OAuth 2.0 API, in ms. Default: 5 minutes. */
    accessTokenLifetimeMs?: number;
    /** Shown on the login and registration pages: the server's terms of service and privacy policy. */
    termsUrl?: string;
    policyUrl?: string;
    /** How long a browser stays logged in to the web pages, in ms. Default: 7 days. */
    webSessionLifetimeMs?: number;
}
/** Path prefix of every endpoint and page. Under `/_synapse/client`, which proxies already forward. */
export declare const OAUTH_PREFIX = "/_synapse/client/oauth2";
export declare const API_SCOPE = "urn:matrix:client:api:*";
export declare const GRANT_CODE = "authorization_code";
export declare const GRANT_REFRESH = "refresh_token";
export declare const GRANT_DEVICE = "urn:ietf:params:oauth:grant-type:device_code";
export declare const ACCOUNT_ACTIONS: readonly ["org.matrix.profile", "org.matrix.devices_list", "org.matrix.device_view", "org.matrix.device_delete", "org.matrix.account_deactivate", "org.matrix.cross_signing_reset"];
/** How long an approved cross-signing reset may be used (Synapse/MAS use the same window). */
export declare const CROSS_SIGNING_RESET_WINDOW_MS: number;
/** An OAuth error response (RFC 6749 section 5.2, RFC 7591 section 3.2.2). */
export declare class OAuthError extends Error {
    readonly error: string;
    readonly description: string;
    readonly status: number;
    constructor(error: string, description: string, status?: number);
}
export interface ClientMetadata {
    client_id: string;
    client_uri: string;
    client_name?: string;
    logo_uri?: string;
    tos_uri?: string;
    policy_uri?: string;
    redirect_uris: string[];
    response_types: string[];
    grant_types: string[];
    token_endpoint_auth_method: "none";
    application_type: "web" | "native";
}
/** A validated authorization request, waiting for the user to log in and consent. */
export interface PendingGrant {
    clientId: string;
    redirectUri: string;
    responseMode: "query" | "fragment";
    state?: string;
    scope: string;
    deviceId: string;
    codeChallenge: string;
    nonce?: string;
    /** The client asked for the registration page (`prompt=create`). */
    create: boolean;
}
export interface DeviceGrant {
    clientId: string;
    scope: string;
    deviceId: string;
    userCode: string;
    status: "pending" | "approved" | "denied";
    userId?: string;
    lastPoll: number;
    expires: number;
}
export interface TokenResponse {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    refresh_token: string;
    scope: string;
    id_token?: string;
}
/** Redirect URI validation of the spec ("Redirect URI validation", after RFC 8252 section 7). */
export declare function checkRedirectUri(raw: string, applicationType: "web" | "native", clientHost: string): void;
/** Whether `given` is one of the client's redirect URIs; loopback URIs match on any port. */
export declare function redirectUriMatches(registered: string[], given: string): boolean;
/** Validate a registration request and return the metadata as registered (RFC 7591 section 2). */
export declare function validateClientMetadata(raw: Record<string, unknown>): Omit<ClientMetadata, "client_id">;
/** The API scope and the one device ID a login scope must contain. */
export declare function parseScope(scope: string | null): {
    scope: string;
    deviceId: string;
    openid: boolean;
};
export declare class OAuthServer {
    private hs;
    readonly options: OAuthServerOptions;
    /** The issuer identifier: the public base URL with a trailing slash. */
    readonly issuer: string;
    constructor(hs: Homeserver, options: OAuthServerOptions, publicBaseUrl: string);
    get legacyApi(): boolean;
    get accessTokenLifetimeMs(): number;
    /** Absolute URL of a path under the OAuth prefix. */
    url(path: string): string;
    get accountManagementUri(): string;
    /** Authorization server metadata (RFC 8414), served at `/_matrix/client/v1/auth_metadata`. */
    metadata(): Record<string, unknown>;
    /** The server's signing key as a JWK set (RFC 8037), for ID tokens. */
    jwks(): {
        keys: Record<string, string>[];
    };
    /**
     * Register a client. Each login registers again (the spec asks clients to), so identical
     * metadata gets the same client ID, derived from it, instead of a new row every time.
     */
    registerClient(raw: Record<string, unknown>): Promise<ClientMetadata>;
    client(clientId: string | null): Promise<ClientMetadata | null>;
    /** Delete old registrations that no token uses (the spec forbids deleting ones in use). */
    prune(): Promise<void>;
    /**
     * Check an authorization request. Problems with the client or the redirect URI are thrown as
     * `OAuthError` with `redirect: false` semantics (shown to the user: RFC 6749 section 4.1.2.1
     * forbids redirecting to an unverified URI); the rest come back as `{ error }` to redirect.
     */
    checkAuthorizationRequest(params: URLSearchParams): Promise<{
        client: ClientMetadata;
        grant: PendingGrant;
    } | {
        client: ClientMetadata;
        redirect: string;
        error: OAuthError;
    }>;
    /** The client's redirect URI with the response parameters (and RFC 9207 `iss`). */
    callbackUrl(redirectUri: string, mode: "query" | "fragment", params: Record<string, string | undefined>): string;
    saveGrant(grant: PendingGrant): Promise<string>;
    grant(id: string): Promise<PendingGrant | null>;
    /** The user approved: issue a code and return where the browser goes next. */
    approveGrant(id: string, grant: PendingGrant, userId: string, authTime: number): Promise<string>;
    denyGrant(id: string, grant: PendingGrant): Promise<string>;
    token(params: URLSearchParams, clientId: string | null): Promise<TokenResponse>;
    private exchangeCode;
    private issue;
    private tokenResponse;
    /** An OpenID Connect ID token (EdDSA with the server's signing key). */
    private idToken;
    startDeviceGrant(clientId: string | null, scope: string | null): Promise<{
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
    }>;
    /** The device grant a user code belongs to (typed in any case, with or without the dash). */
    deviceGrantByUserCode(raw: string): Promise<{
        deviceCode: string;
        grant: DeviceGrant;
    } | null>;
    decideDeviceGrant(deviceCode: string, grant: DeviceGrant, userId: string, approve: boolean): Promise<void>;
    private pollDevice;
    /**
     * Revoke an access or refresh token (RFC 7009). The spec revokes both tokens of the pair; a
     * logout through this endpoint ends the device's session like `/logout` does. Unknown tokens
     * are not an error.
     */
    revoke(token: string | null): Promise<void>;
}
/** Approve a cross-signing reset for `userId`; returns when the approval runs out. */
export declare function allowCrossSigningReset(hs: Homeserver, userId: string): Promise<number>;
/**
 * Whether the user approved a cross-signing reset in the last few minutes. The approval is not
 * used up: a client may need several uploads (Synapse allows the same within the window).
 */
export declare function crossSigningResetAllowed(hs: Homeserver, userId: string): Promise<boolean>;
