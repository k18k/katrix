import type { HttpAdapter } from "../http/adapter.ts";
import type { Logger } from "../util/logger.ts";
import type { Credentials, CredentialsStore, TokenProvider } from "./types.ts";
export interface LoginOptions {
    deviceId?: string;
    initialDeviceDisplayName?: string;
    /** Ask for a refresh token (default true); servers that do not issue them ignore it. */
    refreshToken?: boolean;
}
export type UserIdentifier = {
    type: "m.id.user";
    user: string;
} | {
    type: "m.id.thirdparty";
    medium: string;
    address: string;
} | {
    type: "m.id.phone";
    country: string;
    phone: string;
};
/** Login API calls that need no access token (https://spec.matrix.org/v1.16/client-server-api/#login). */
export declare class Auth {
    private readonly api;
    constructor(opts: {
        baseUrl: string;
        http: HttpAdapter;
        logger?: Logger;
    });
    /** The login types the server offers (GET /v3/login). */
    loginFlows(): Promise<Array<{
        type: string;
        [k: string]: unknown;
    }>>;
    /** `user` is a localpart or a full user ID, or a full identifier for a third-party ID. */
    loginWithPassword(user: string | UserIdentifier, password: string, opts?: LoginOptions): Promise<Credentials>;
    /** The token an SSO redirect returns (m.login.token). */
    loginWithToken(token: string, opts?: LoginOptions): Promise<Credentials>;
    /**
     * Register an account (https://spec.matrix.org/v1.16/client-server-api/#post_matrixclientv3register).
     * Completes user-interactive authentication when the server offers a flow of stages this
     * method can do on its own (m.login.dummy, or none); other flows (CAPTCHA, email, terms) are
     * thrown as the server's 401 MatrixError, whose `data` holds the flows and session.
     */
    register(username: string, password: string, opts?: LoginOptions): Promise<Credentials>;
    /** The SSO redirect URL to open in a browser (https://spec.matrix.org/v1.16/client-server-api/#client-login-via-sso). */
    ssoRedirectUrl(redirectUrl: string, idpId?: string): string;
    private login;
    /** The base URL from /.well-known/matrix/client, checked against /versions (spec "Server Discovery"). */
    static discover(serverName: string, http: HttpAdapter): Promise<string>;
}
/**
 * Tokens from a login, refreshed with the refresh token when the server rejects the access token.
 * Concurrent requests that all see the expired token share one refresh.
 */
export declare class CredentialsTokenProvider implements TokenProvider {
    private credentials;
    private readonly http;
    private readonly baseUrl;
    private readonly store?;
    private readonly mutex;
    constructor(opts: {
        credentials: Credentials;
        baseUrl: string;
        http: HttpAdapter;
        store?: CredentialsStore;
    });
    current(): Credentials;
    accessToken(): string;
    refresh(): Promise<boolean>;
}
