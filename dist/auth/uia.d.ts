import { AuthenticationData } from "../shared/api/auth.js";
/**
 * User-interactive authentication (https://spec.matrix.org/v1.19/client-server-api/#user-interactive-authentication-api).
 * Endpoints such as deleting a device, changing the password or uploading cross-signing keys
 * answer 401 with the flows of stages the user has to complete; the request is then repeated with
 * an `auth` dict for the next stage, until the server accepts it.
 */
/** Where an interactive authentication stands, as the server's last 401 said. */
export interface UiaSession {
  /** Each flow is a list of stage types that together complete the authentication. */
  readonly flows: ReadonlyArray<{
    readonly stages: readonly string[];
  }>;
  /** Per stage type, what the client needs for it (a CAPTCHA public key, terms, an OAuth URL). */
  readonly params: Readonly<Record<string, unknown>>;
  readonly session?: string;
  readonly completed: readonly string[];
  /** Set when the previous attempt at a stage failed (for example M_FORBIDDEN for a wrong password). */
  readonly errcode?: string;
}
/**
 * Answers one round: the `auth` dict for the next stage, or undefined to give up (the 401 is then
 * thrown). The session ID is added when the answer has none. Returning `{}` retries with only
 * the session, for stages completed out of band (email links, `m.oauth` in a browser).
 */
export type UiaCallback = (session: UiaSession) => Promise<AuthenticationData | undefined> | AuthenticationData | undefined;
/**
 * Run `call`, completing user-interactive authentication with `onAuth` when the server asks for
 * it. `call` gets the `auth` dict to send (undefined on the first try).
 */
export declare function withUserInteractiveAuth<T>(call: (auth: AuthenticationData | undefined) => Promise<T>, onAuth: UiaCallback | undefined): Promise<T>;
/** The stages left in the first flow that `can` completes (each of its stages is one `can` knows). */
export declare function nextStage(session: UiaSession, can: (stage: string) => boolean): string | undefined;
/**
 * Answers `m.login.password` (and `m.login.dummy`) stages with the user's password. A wrong
 * password is not retried: the server's 401 (M_FORBIDDEN) is thrown. Other stages give up, unless
 * `fallback` answers them.
 */
export declare function passwordAuth(userId: string, password: string, fallback?: UiaCallback): UiaCallback;
/** Answers flows made only of `m.login.dummy` (open registration, some servers' device deletion). */
export declare const dummyAuth: UiaCallback;
//# sourceMappingURL=uia.d.ts.map