import { MatrixError, errors } from "../core/errors.ts";
import { randomString } from "../core/crypto.ts";
import { isObject } from "../core/json.ts";
import type { Homeserver } from "../homeserver.ts";

interface UiaSession {
  completed: string[];
  userId: string | null;
  /** Addresses validated through email/msisdn stages. */
  threepids?: ValidatedThreepid[];
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
 * `userId` binds password stages to an already-authenticated user.
 */
export async function requireUia(
  hs: Homeserver,
  body: Record<string, any>,
  flows: string[][],
  userId: string | null,
): Promise<{ threepids: ValidatedThreepid[] }> {
  // With delegated OAuth there are no passwords; sensitive actions are approved at the provider.
  if (hs.oauth && flows.some((f) => f.includes("m.login.password"))) {
    flows = [["m.oauth"], ["org.matrix.cross_signing_reset"]];
  }
  // Sessions live in the cluster KV so that any instance can continue them.
  const auth = isObject(body.auth) ? body.auth : null;
  let sessionId: string | undefined = typeof auth?.session === "string" ? auth.session : undefined;
  const stored = sessionId ? await hs.cluster.get<UiaSession>(`uia:${sessionId}`) : null;
  const session = {
    completed: new Set<string>(stored?.completed ?? []),
    userId: stored ? stored.userId : userId,
    threepids: stored?.threepids ?? [],
  };
  if (!stored) sessionId = randomString(24);
  const save = () =>
    hs.cluster.set(
      `uia:${sessionId}`,
      { completed: [...session.completed], userId: session.userId, threepids: session.threepids },
      UIA_TTL_MS,
    );
  const oauthUrl = hs.oauth?.options.accountManagementUrl ?? hs.oauth?.options.issuer;
  const params = hs.oauth ? { "m.oauth": { url: oauthUrl }, "org.matrix.cross_signing_reset": { url: oauthUrl } } : {};
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
  if (auth?.type === "m.login.dummy" && !auth.session && typeof body.username === "string" && !userId) {
    if (await hs.cluster.get(`uia-register:${body.username.toLowerCase()}`)) {
      throw challenge({ errcode: "M_FORBIDDEN", error: "Missing session" });
    }
  }
  if (auth?.type) {
    switch (auth.type) {
      case "m.login.dummy":
        session.completed.add("m.login.dummy");
        break;
      case "m.oauth":
      case "org.matrix.cross_signing_reset":
        // The client retries after the user approved the action at the provider.
        if (!hs.oauth) throw challenge({ errcode: "M_UNRECOGNIZED", error: "OAuth is not enabled" });
        session.completed.add(auth.type);
        break;
      case "m.login.registration_token": {
        const { registrationTokenValid } = await import("./account.ts");
        if (typeof auth.token !== "string" || !(await registrationTokenValid(hs, auth.token))) {
          throw challenge({ errcode: "M_FORBIDDEN", error: "Invalid registration token" });
        }
        session.completed.add("m.login.registration_token");
        break;
      }
      case "m.login.password": {
        const identifier = isObject(auth.identifier) ? auth.identifier : { type: "m.id.user", user: auth.user };
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
        session.completed.add("m.login.password");
        break;
      }
      case "m.login.email.identity":
      case "m.login.msisdn": {
        const validated = await hs.threepids.validated(auth.threepid_creds ?? auth.threepidCreds);
        const medium = auth.type === "m.login.email.identity" ? "email" : "msisdn";
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
  return { threepids: session.threepids };
}
