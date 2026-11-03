import type { Homeserver } from "#homeserver.ts";
/**
 * An upstream identity provider: OpenID Connect (found through `issuer`), or plain OAuth 2.0 with
 * a user info endpoint (`endpoints`, e.g. GitHub; see `githubProvider`).
 */
export interface SsoProvider {
    /** Stable identifier, used in URLs and stored with linked accounts. */
    id: string;
    name: string;
    /** OpenID Connect issuer; its discovery document gives the endpoints. Required without `endpoints`. */
    issuer?: string;
    /** Endpoints of a provider without OpenID Connect discovery. */
    endpoints?: {
        authorization: string;
        token: string;
        userinfo?: string;
    };
    clientId: string;
    clientSecret?: string;
    /** Default: ["openid", "profile", "email"] with `issuer`, none with `endpoints`. */
    scopes?: string[];
    /** Claim that identifies the user at the provider. Default: "sub". */
    subjectClaim?: string;
    icon?: string;
    brand?: string;
    /**
     * Map ID token / userinfo claims to a Matrix account. Return a localpart and optional
     * display name, or null to refuse login. Default: sanitised `preferred_username`, then `sub`.
     */
    mapUser?: (claims: Record<string, any>) => {
        localpart: string;
        displayname?: string;
    } | null | Promise<{
        localpart: string;
        displayname?: string;
    } | null>;
    /** Create accounts for unknown users. Default: true. */
    allowRegistration?: boolean;
}
export interface SsoOptions {
    providers: SsoProvider[];
    /**
     * Clients that receive the login token straight away, as URL prefixes such as
     * `"https://app.element.io/"` (same scheme and host, path starting with the prefix's path).
     * Other clients get a page naming them, where the user confirms before the token is sent.
     */
    clientAllowlist?: string[];
}
/**
 * What a login through a provider is for: a client of the legacy API (`m.login.sso`, which gets a
 * login token at `redirectUrl`), or the server's own web pages (OAuth 2.0 API), which continue
 * at `next` in the browser session `sid`.
 */
export type SsoTarget = {
    kind: "client";
    redirectUrl: string;
} | {
    kind: "web";
    next: string;
    sid: string;
};
/** Where the browser goes after login, and whether the user has to confirm that client first. */
export interface SsoResult {
    url: string;
    confirm: boolean;
    /** The client as shown to the user: its host, or its scheme for app links. */
    client: string;
}
/** The client's redirect URL, if it is one the server may send a login token to. */
export declare function checkRedirectUrl(raw: string | null): string | null;
export declare function sanitizeLocalpart(raw: string): string;
/**
 * GitHub as an identity provider (an OAuth app or GitHub app; its callback URL is
 * `{publicBaseUrl}/_matrix/client/v3/login/sso/callback/github`). Users are matched by their
 * numeric GitHub ID, so renaming the GitHub account keeps the Matrix account; new accounts take
 * the GitHub login as their localpart.
 */
export declare function githubProvider(opts: {
    clientId: string;
    clientSecret: string;
    id?: string;
    name?: string;
    allowRegistration?: boolean;
    mapUser?: SsoProvider["mapUser"];
}): SsoProvider;
/** Upstream login (authorization code + PKCE) for the legacy `m.login.sso` and the OAuth 2.0 API's web pages. */
export declare class SsoService {
    private hs;
    readonly providers: SsoProvider[];
    readonly clientAllowlist: string[];
    private discovery;
    constructor(hs: Homeserver, options: SsoOptions);
    private callbackUrl;
    private discover;
    private scopes;
    /** URL to send the user's browser to. */
    startLogin(providerId: string | null, target: SsoTarget): Promise<string>;
    /** Handle the provider's redirect: the user who logged in, and what the login was for. */
    finishLogin(providerId: string, params: URLSearchParams): Promise<{
        userId: string;
        target: SsoTarget;
    }>;
    private resolveUser;
}
/**
 * The legacy API's last step: the client URL carrying a login token for `userId`, and whether
 * the user confirms the client first (clients not on `sso.clientAllowlist`).
 */
export declare function legacyClientRedirect(hs: Homeserver, userId: string, redirectUrl: string): Promise<SsoResult>;
