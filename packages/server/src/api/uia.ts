import { MatrixError, errors } from "#core/errors.ts";
import { randomString } from "#core/crypto.ts";
import { isObject } from "#core/json.ts";
import type { Homeserver } from "#homeserver.ts";
import { M, UNSTABLE } from "#core/m.ts";
import type { Session } from "#core/auth.ts";
import { crossSigningResetAllowed } from "#core/oauthserver.ts";

interface UiaSession {
  completed: string[];
  userId: string | null;
  /** Addresses validated through email/msisdn stages. */
  threepids?: ValidatedThreepid[];
  /** The token of a completed `m.login.registration_token` stage, redeemed when the account is created (#81). */
  registrationToken?: string;
}

export interface ValidatedThreepid {
  medium: "email" | "msisdn";
  address: string;
  validatedTs: number;
}

const UIA_TTL_MS = 10 * 60_000;

/**
 * User-interactive authentication. Resolves when one of `flows` has been
 * completed; otherwise throws the 401 response describing what is required.
 * `userId` binds password stages to an already-authenticated user. `session` is the caller's,
 * and `crossSigningReset` marks `/keys/device_signing/upload`, the one endpoint where tokens of
 * the OAuth 2.0 API may use UIA (the `m.oauth` stage).
 */
export async function requireUia(
  hs: Homeserver,
  body: Record<string, any>,
  flows: string[][],
  userId: string | null,
  opts: { session?: Session; crossSigningReset?: boolean } = {},
): Promise<{ threepids: ValidatedThreepid[]; registrationToken?: string }> {
  // With OAuth (this server's or a delegated one) there are no passwords to ask for.
  const viaOAuth = !!opts.session?.oauth || (!!hs.oauth && flows.some((f) => f.includes(M.LOGIN.PASSWORD)));
  let oauthUrl: string | undefined;
  if (viaOAuth) {
    // The spec: UIA does not work with OAuth tokens, apart from m.oauth for cross-signing.
    // Everything else is done on the account management page.
    const accountUri = hs.oauthServer?.accountManagementUri ?? hs.oauth?.options.accountManagementUrl;
    if (!opts.crossSigningReset)
      throw new MatrixError(
        403,
        "M_FORBIDDEN",
        "Do this on the account management page",
        accountUri ? { account_management_uri: accountUri } : {},
      );
    // https://github.com/k18k/katrix/issues/65: the stage completed as soon as
    // the client named it. It completes now only after the user approved the reset (on the
    // account page, or at the delegated provider through the admin API), and the client retries
    // with just the session, as the spec describes.
    if (userId && (await crossSigningResetAllowed(hs, userId))) return { threepids: [] };
    flows = [[M.OAUTH], [UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET]];
    oauthUrl = hs.oauthServer
      ? `${hs.oauthServer.accountManagementUri}?action=org.matrix.cross_signing_reset`
      : (hs.oauth!.options.accountManagementUrl ?? hs.oauth!.options.issuer);
  }
  // Sessions live in the cluster KV so that any instance can continue them.
  const auth = isObject(body.auth) ? body.auth : null;
  let sessionId: string | undefined = typeof auth?.session === "string" ? auth.session : undefined;
  const stored = sessionId ? await hs.cluster.get<UiaSession>(`uia:${sessionId}`) : null;
  const session = {
    completed: new Set<string>(stored?.completed ?? []),
    userId: stored ? stored.userId : userId,
    threepids: stored?.threepids ?? [],
    registrationToken: stored?.registrationToken,
  };
  if (!stored) sessionId = randomString(24);
  const save = () =>
    hs.cluster.set(
      `uia:${sessionId}`,
      {
        completed: [...session.completed],
        userId: session.userId,
        threepids: session.threepids,
        registrationToken: session.registrationToken,
      },
      UIA_TTL_MS,
    );
  const params = oauthUrl ? { [M.OAUTH]: { url: oauthUrl }, [UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET]: { url: oauthUrl } } : {};
  const challenge = (extra: Record<string, unknown> = {}) =>
    new MatrixError(401, extra.errcode ? String(extra.errcode) : "M_FORBIDDEN", String(extra.error ?? "Authentication required"), {
      flows: flows.map((stages) => ({ stages })),
      params,
      session: sessionId,
      completed: [...session!.completed],
      ...extra,
    });

  // Like Synapse, m.login.dummy may be completed without a session, unless the client already
  // started one for this registration (then it must continue that session).
  if (auth?.type === M.LOGIN.DUMMY && !auth.session && typeof body.username === "string" && !userId) {
    if (await hs.cluster.get(`uia-register:${body.username.toLowerCase()}`)) {
      throw challenge({ errcode: "M_FORBIDDEN", error: "Missing session" });
    }
  }
  if (auth?.type) {
    switch (auth.type) {
      case M.LOGIN.DUMMY:
        session.completed.add(M.LOGIN.DUMMY);
        break;
      case M.OAUTH:
      case UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET:
        // Approved resets returned above (#65); naming the stage does not complete it.
        if (!viaOAuth) throw challenge({ errcode: "M_UNRECOGNIZED", error: "OAuth is not enabled" });
        throw challenge({ errcode: "M_FORBIDDEN", error: "The reset has not been approved on the account page" });
      case M.LOGIN.REGISTRATION_TOKEN: {
        const { registrationTokenValid } = await import("#api/account.ts");
        if (typeof auth.token !== "string" || !(await registrationTokenValid(hs, auth.token))) {
          throw challenge({ errcode: "M_FORBIDDEN", error: "Invalid registration token" });
        }
        session.completed.add(M.LOGIN.REGISTRATION_TOKEN);
        session.registrationToken = auth.token;
        break;
      }
      case M.LOGIN.PASSWORD: {
        const identifier = isObject(auth.identifier) ? auth.identifier : { type: M.ID.USER, user: auth.user };
        const user = typeof identifier.user === "string" ? identifier.user : "";
        const target = user.startsWith("@") ? user : `@${user.toLowerCase()}:${hs.serverName}`;
        if (userId && target !== userId) throw errors.forbidden("Credentials do not match the authenticated user");
        const row = await hs.db.findOne("users", [{ field: "user_id", value: target }]);
        const ok =
          row &&
          !row.deactivated &&
          typeof auth.password === "string" &&
          (await hs.userAuth.checkPassword({
            userId: target,
            localpart: target.slice(1).split(":")[0],
            password: auth.password,
            storedHash: row.password_hash,
          }));
        if (!ok) throw challenge({ errcode: "M_FORBIDDEN", error: "Invalid password" });
        session.completed.add(M.LOGIN.PASSWORD);
        break;
      }
      case M.LOGIN.EMAIL.IDENTITY:
      case M.LOGIN.MSISDN: {
        const validated = await hs.threepids.validated(auth.threepid_creds ?? auth.threepidCreds);
        const medium = auth.type === M.LOGIN.EMAIL.IDENTITY ? "email" : "msisdn";
        if (!validated || validated.medium !== medium)
          throw challenge({ errcode: "M_UNAUTHORIZED", error: "The address has not been validated" });
        // For an authenticated user, the address must be one of theirs.
        if (session.userId && (await hs.threepids.userFor(validated.medium, validated.address)) !== session.userId) {
          throw challenge({ errcode: "M_FORBIDDEN", error: "This address does not belong to your account" });
        }
        session.threepids = [...session.threepids.filter((t) => t.medium !== medium), validated];
        session.completed.add(auth.type);
        break;
      }
      default:
        throw challenge({ errcode: "M_UNRECOGNIZED", error: `Unsupported auth type ${auth.type}` });
    }
  }
  const done = flows.some((stages) => stages.every((s) => session!.completed.has(s)));
  if (!done) {
    await save();
    if (!userId && typeof body.username === "string")
      await hs.cluster.set(`uia-register:${body.username.toLowerCase()}`, sessionId, UIA_TTL_MS);
    if (auth?.type) throw challenge();
    const e = challenge();
    // A first request without `auth` gets a plain 401 without errcode.
    throw new MatrixError(401, "M_FORBIDDEN", "", { ...e.extra, errcode: undefined, error: undefined });
  }
  await hs.cluster.delete(`uia:${sessionId}`);
  return { threepids: session.threepids, registrationToken: session.registrationToken };
}
