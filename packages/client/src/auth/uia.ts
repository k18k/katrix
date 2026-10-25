import { MatrixError } from "../http/errors.ts";
import type { AuthenticationData } from "@katrix/shared";

/**
 * User-interactive authentication (https://spec.matrix.org/v1.19/client-server-api/#user-interactive-authentication-api).
 * Endpoints such as deleting a device, changing the password or uploading cross-signing keys
 * answer 401 with the flows of stages the user has to complete; the request is then repeated with
 * an `auth` dict for the next stage, until the server accepts it.
 */

/** Where an interactive authentication stands, as the server's last 401 said. */
export interface UiaSession {
  /** Each flow is a list of stage types that together complete the authentication. */
  readonly flows: ReadonlyArray<{ readonly stages: readonly string[] }>;
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

const MAX_ROUNDS = 10;

function uiaSessionOf(e: unknown): UiaSession | undefined {
  if (!(e instanceof MatrixError) || e.status !== 401 || !Array.isArray(e.data.flows)) return undefined;
  const d = e.data;
  return {
    flows: (d.flows as Array<{ stages?: unknown }>).map((f) => ({
      stages: Array.isArray(f?.stages) ? f.stages.filter((s): s is string => typeof s === "string") : [],
    })),
    params: typeof d.params === "object" && d.params !== null ? (d.params as Record<string, unknown>) : {},
    session: typeof d.session === "string" ? d.session : undefined,
    completed: Array.isArray(d.completed) ? d.completed.filter((s): s is string => typeof s === "string") : [],
    // The first 401 has no errcode of its own; MatrixError reports M_UNKNOWN then.
    errcode: typeof d.errcode === "string" ? d.errcode : undefined,
  };
}

/**
 * Run `call`, completing user-interactive authentication with `onAuth` when the server asks for
 * it. `call` gets the `auth` dict to send (undefined on the first try).
 */
export async function withUserInteractiveAuth<T>(
  call: (auth: AuthenticationData | undefined) => Promise<T>,
  onAuth: UiaCallback | undefined,
): Promise<T> {
  let auth: AuthenticationData | undefined;
  for (let round = 0; ; round++) {
    try {
      return await call(auth);
    } catch (e) {
      const session = uiaSessionOf(e);
      if (!session || !onAuth || round >= MAX_ROUNDS) throw e;
      const next = await onAuth(session);
      if (!next) throw e;
      auth = next.session === undefined && session.session !== undefined ? { ...next, session: session.session } : next;
    }
  }
}

/** The stages left in the first flow that `can` completes (each of its stages is one `can` knows). */
export function nextStage(session: UiaSession, can: (stage: string) => boolean): string | undefined {
  for (const flow of session.flows) {
    if (!flow.stages.every(can)) continue;
    const left = flow.stages.filter((s) => !session.completed.includes(s));
    if (left.length > 0) return left[0];
  }
  return undefined;
}

/**
 * Answers `m.login.password` (and `m.login.dummy`) stages with the user's password. A wrong
 * password is not retried: the server's 401 (M_FORBIDDEN) is thrown. Other stages give up, unless
 * `fallback` answers them.
 */
export function passwordAuth(userId: string, password: string, fallback?: UiaCallback): UiaCallback {
  let tried = false;
  return (session) => {
    const stage = nextStage(session, (s) => s === "m.login.password" || s === "m.login.dummy");
    if (stage === "m.login.dummy") return { type: "m.login.dummy" };
    if (stage === "m.login.password" && !(tried && session.errcode)) {
      tried = true;
      return { type: "m.login.password", identifier: { type: "m.id.user", user: userId }, password };
    }
    return fallback?.(session);
  };
}

/** Answers flows made only of `m.login.dummy` (open registration, some servers' device deletion). */
export const dummyAuth: UiaCallback = (session) =>
  nextStage(session, (s) => s === "m.login.dummy") === "m.login.dummy" ? { type: "m.login.dummy" } : undefined;
