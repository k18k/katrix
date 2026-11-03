/**
 * Authentication. The client itself only needs an access token for each request and, when the
 * server says it expired, a way to get a new one: a TokenProvider. How the tokens were obtained
 * (password login, SSO login token, OAuth 2.0 / OIDC with the next-generation auth API) is up to
 * the provider, so a new login method needs no change in the client.
 */
export {};
