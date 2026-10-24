import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { MatrixError, errors } from "#core/errors.ts";
import { randomString } from "#core/crypto.ts";
import { LOCALPART_RE } from "#core/ids.ts";
import { isObject } from "#core/json.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { requireUia } from "#api/uia.ts";
import { canonicalAddress, isMedium } from "#core/threepid.ts";
import { toMsisdn } from "#core/phone.ts";
import { v } from "#core/vpm.ts";
import { body, fail, lenient } from "#http/input.ts";
import { M, UNSTABLE } from "#core/m.ts";
import { checkRedirectUrl, legacyClientRedirect, type SsoResult } from "#core/sso.ts";
import { OAUTH_PREFIX } from "#core/oauthserver.ts";
import { readWebSession, setWebUser } from "#api/oauthserver.ts";
import { escapeHtml } from "#core/html.ts";

// Fields shared by login and registration requests.
const deviceFields = {
  device_id: lenient(v.string()),
  initial_device_display_name: lenient(v.string()),
  refresh_token: lenient(v.boolean()),
  inhibit_login: lenient(v.boolean()),
};
const loginBody = body({ type: lenient(v.string()), token: lenient(v.string()), password: lenient(v.string()), ...deviceFields });
const registerBody = body({
  type: lenient(v.string()),
  auth: lenient(v.looseObject({ type: lenient(v.string()) })),
  username: v.string(fail("M_INVALID_PARAM", "username must be a string")).optional(),
  password: v.string(fail("M_INVALID_PARAM", "password must be a string")).optional(),
  ...deviceFields,
});
const passwordBody = body({ new_password: lenient(v.string()), logout_devices: lenient(v.boolean()) });
const sharedSecretRegisterBody = body({
  nonce: lenient(v.string()),
  username: v.string(fail("M_INVALID_PARAM", "Invalid username/password")),
  password: v.string(fail("M_INVALID_PARAM", "Invalid username/password")),
  admin: lenient(v.boolean()),
  mac: lenient(v.string()),
  displayname: lenient(v.string()),
});

function loginFlows(hs: Homeserver): Record<string, unknown>[] {
  // With delegated OAuth, clients must use the authorization server instead.
  if (hs.oauth) return [];
  // The spec: a server without the legacy API answers 404 M_UNRECOGNIZED.
  if (hs.oauthServer && !hs.oauthServer.legacyApi) throw errors.unrecognized("Log in with the OAuth 2.0 API");
  const flows: Record<string, unknown>[] = [];
  if (hs.userAuth.passwordLoginEnabled) flows.push({ type: M.LOGIN.PASSWORD });
  if (hs.sso || hs.oauthServer) {
    flows.push({
      type: M.LOGIN.SSO,
      identity_providers: (hs.sso?.providers ?? []).map((p) => ({ id: p.id, name: p.name, icon: p.icon, brand: p.brand })),
      // OAuth 2.0 aware clients (spec v1.18): with the OAuth server, SSO goes through its login
      // page, which offers the password and every provider, so clients should only offer this.
      ...(hs.oauthServer ? { oauth_aware_preferred: true } : {}),
    });
  }
  flows.push({ type: M.LOGIN.TOKEN, ...(hs.config.loginViaExistingSession ? { get_login_token: true } : {}) });
  return flows;
}

/** Endpoints that manage passwords are unavailable when an OAuth provider owns the accounts. */
function rejectIfDelegated(hs: Homeserver): void {
  if (hs.oauthServer && !hs.oauthServer.legacyApi) throw errors.unrecognized("Use the OAuth 2.0 API");
  if (hs.oauth)
    throw new MatrixError(
      403,
      "M_FORBIDDEN",
      "Accounts are managed by the OAuth provider",
      hs.oauth.options.accountManagementUrl ? { account_management_uri: hs.oauth.options.accountManagementUrl } : {},
    );
}

export async function validateNewUsername(hs: Homeserver, raw: unknown): Promise<string> {
  if (typeof raw !== "string" || raw.length === 0) throw errors.invalidUsername("Username must be a non-empty string");
  const localpart = raw.startsWith("@") ? raw.slice(1).split(":")[0] : raw;
  if (!LOCALPART_RE.test(localpart)) throw errors.invalidUsername("Username contains invalid characters");
  if (`@${localpart}:${hs.serverName}`.length > 255) throw errors.invalidUsername("Username too long");
  if (!(await hs.userAuth.validateUsername(localpart))) throw errors.invalidUsername();
  if (await hs.db.findOne("users", [{ field: "user_id", value: `@${localpart}:${hs.serverName}` }])) throw errors.userInUse();
  return localpart;
}

async function generateLocalpart(hs: Homeserver): Promise<string> {
  for (;;) {
    // Security (https://github.com/k18k/katrix/issues/6): this used Math.random, so generated user IDs were predictable (CWE-338).
    const candidate = String(randomInt(1e9));
    if (!(await hs.db.findOne("users", [{ field: "localpart", value: candidate }]))) return candidate;
  }
}

export async function createUser(
  hs: Homeserver,
  localpart: string,
  opts: { password?: string; guest?: boolean; admin?: boolean; displayname?: string },
): Promise<string> {
  const userId = `@${localpart}:${hs.serverName}`;
  await hs.db.create("users", {
    user_id: userId,
    localpart,
    password_hash: opts.password ? await hs.userAuth.hashPassword(opts.password) : null,
    displayname: opts.displayname ?? localpart,
    avatar_url: null,
    is_guest: !!opts.guest,
    is_admin: !!opts.admin,
    deactivated: false,
    created_ts: Date.now(),
  });
  await hs.userAuth.onUserRegistered(userId);
  await hs.adminRoom?.onUserCreated(userId).catch((err) => hs.logger.error("Admin room setup failed", err));
  return userId;
}

/**
 * Check a password login, with the audit entries and automatic provisioning of `/login`; returns
 * the user ID. Shared with the OAuth server's login page.
 */
export async function checkPasswordLogin(
  hs: Homeserver,
  userId: string,
  password: string,
  request: { ip: string | null; userAgent: string | null },
): Promise<string> {
  let user = await hs.db.findOne("users", [{ field: "user_id", value: userId }]);
  const ok = await hs.userAuth.checkPassword({
    userId,
    localpart: userId.slice(1).split(":")[0],
    password,
    storedHash: user?.password_hash ?? null,
  });
  if (!ok) {
    await hs.audit.record({
      action: "login_failed",
      actor: userId,
      ip: request.ip,
      userAgent: request.userAgent,
      outcome: "failure",
      details: { type: M.LOGIN.PASSWORD },
    });
    throw errors.forbidden("Invalid username or password");
  }
  if (!user) {
    if (!(await hs.userAuth.autoProvision(userId))) throw errors.forbidden("Invalid username or password");
    await createUser(hs, userId.slice(1).split(":")[0], {});
    user = await hs.db.findOne("users", [{ field: "user_id", value: userId }]);
  }
  if (user!.deactivated) throw errors.userDeactivated();
  return userId;
}

async function resolveLoginUser(hs: Homeserver, body: Record<string, any>): Promise<string> {
  let user: unknown;
  // Third-party identifiers (and the legacy top-level medium/address) log in the account they belong to.
  const id = isObject(body.identifier) ? body.identifier : null;
  let threepid: { medium: string; address: string | null } | null = null;
  if (id?.type === M.ID.THIRDPARTY && typeof id.medium === "string" && typeof id.address === "string") {
    threepid = { medium: id.medium, address: isMedium(id.medium) ? canonicalAddress(id.medium, id.address) : null };
  } else if (id?.type === M.ID.PHONE && typeof id.country === "string" && typeof id.phone === "string") {
    threepid = { medium: "msisdn", address: toMsisdn(id.country, id.phone) };
  } else if (!id && typeof body.medium === "string" && typeof body.address === "string") {
    threepid = { medium: body.medium, address: isMedium(body.medium) ? canonicalAddress(body.medium, body.address) : null };
  }
  if (threepid) {
    const owner = threepid.address && isMedium(threepid.medium) ? await hs.threepids.userFor(threepid.medium, threepid.address) : null;
    if (!owner) throw errors.forbidden("Invalid username or password");
    return owner;
  }
  if (id) {
    if (id.type !== M.ID.USER) throw errors.unknown("Unsupported identifier type");
    user = id.user;
  } else {
    user = body.user;
  }
  if (typeof user !== "string" || !user) throw errors.missingParam("Missing user identifier");
  if (user.startsWith("@")) {
    const [lp, ...server] = user.slice(1).split(":");
    if (server.join(":") !== hs.serverName) throw errors.forbidden("Invalid username or password");
    return `@${lp.toLowerCase()}:${hs.serverName}`;
  }
  return `@${user.toLowerCase()}:${hs.serverName}`;
}

// https://github.com/k18k/katrix/issues/19: the page that hands the login
// token to a client the operator has not allowlisted. It names the client and only continues
// when the user clicks, and it may not be framed, so another site cannot click it for them.
export const ssoConfirmPage = (serverName: string, result: SsoResult) => {
  const client = escapeHtml(result.client);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Continue to ${client}</title>
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}a.button{display:inline-block;padding:.6rem 1.2rem;background:#0b7a55;color:#fff;border-radius:6px;text-decoration:none}</style>
<h1>Continue to ${client}?</h1>
<p>You signed in to <b>${escapeHtml(serverName)}</b>. <b>${client}</b> will get access to your account.</p>
<p>If you did not just sign in with this app, close this page.</p>
<p><a class="button" href="${escapeHtml(result.url)}">Continue to ${client}</a></p>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
};

// https://github.com/k18k/katrix/issues/73: clients use the stable discovery
// endpoints only when the server advertises spec v1.15. Others (Element X) ask at MSC2965's
// unstable paths, and without them found no OAuth and no way to sign in. Served at both, as
// Synapse does.
const OAUTH_DISCOVERY_VERSIONS = ["v1", "unstable/org.matrix.msc2965"];

export function registerAccountRoutes(r: Router): void {
  r.client("GET", "/login", procedure({ handler: (ctx) => ({ flows: loginFlows(ctx.hs) }) }));

  r.client(
    "GET",
    "/auth_metadata",
    procedure({
      handler: async (ctx) => {
        if (ctx.hs.oauthServer) return ctx.hs.oauthServer.metadata();
        if (!ctx.hs.oauth) throw errors.unrecognized("OAuth is not enabled");
        return ctx.hs.oauth.serverMetadata();
      },
    }),
    OAUTH_DISCOVERY_VERSIONS,
  );
  r.client(
    "GET",
    "/auth_issuer",
    procedure({
      handler: (ctx) => {
        if (ctx.hs.oauthServer) return { issuer: ctx.hs.oauthServer.issuer };
        if (!ctx.hs.oauth) throw errors.unrecognized("OAuth is not enabled");
        return { issuer: ctx.hs.oauth.options.issuer };
      },
    }),
    OAUTH_DISCOVERY_VERSIONS,
  );

  const ssoRedirect = async (ctx: RequestContext) => {
    const hs = ctx.hs;
    const redirectUrl = checkRedirectUrl(ctx.query.get("redirectUrl"));
    if (hs.oauthServer) {
      if (!hs.oauthServer.legacyApi) throw errors.unrecognized("Log in with the OAuth 2.0 API");
      if (!redirectUrl) throw errors.missingParam("Missing or invalid redirectUrl");
      // Through the OAuth server's pages, which then hand the client a login token.
      const id = randomString(24);
      await hs.cluster.set(`oauth:legacy:${id}`, redirectUrl, 30 * 60_000);
      const next = `${OAUTH_PREFIX}/legacy/${id}`;
      const idp = ctx.params.idpId;
      if (idp && !hs.sso?.providers.some((p) => p.id === idp)) throw errors.notFound("Unknown identity provider");
      const page = idp ? `/upstream/${encodeURIComponent(idp)}` : ctx.query.get("action") === "register" ? "/register-account" : "/login";
      return Response.redirect(`${hs.oauthServer.url(page)}?next=${encodeURIComponent(next)}`, 302);
    }
    if (!hs.sso) throw errors.unrecognized("SSO is not enabled");
    if (!redirectUrl) throw errors.missingParam("Missing or invalid redirectUrl");
    return Response.redirect(await hs.sso.startLogin(ctx.params.idpId ?? null, { kind: "client", redirectUrl }), 302);
  };
  // A logged-in client hands a one-time token to a new device (spec "Login via an existing session").
  r.client(
    "POST",
    "/login/get_token",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        if (!ctx.hs.config.loginViaExistingSession || ctx.hs.oauth || s.oauth || s.isGuest) throw errors.unrecognized();
        await ctx.rateLimit("login");
        await requireUia(ctx.hs, await ctx.json(), [[M.LOGIN.PASSWORD]], s.userId, { session: s });
        const ttl = 2 * 60_000;
        return { login_token: await ctx.hs.auth.createLoginToken(s.userId, ttl), expires_in_ms: ttl };
      },
    }),
    ["v1"],
  );

  r.client("GET", "/login/sso/redirect", procedure({ handler: ssoRedirect }));
  r.client("GET", "/login/sso/redirect/:idpId", procedure({ handler: ssoRedirect }));
  r.client(
    "GET",
    "/login/sso/callback/:idpId",
    procedure({
      handler: async (ctx) => {
        const hs = ctx.hs;
        if (!hs.sso) throw errors.unrecognized("SSO is not enabled");
        const { userId, target } = await hs.sso.finishLogin(ctx.params.idpId, ctx.query);
        if (target.kind === "web") {
          // The login was started in this browser's session of the OAuth server's pages; another
          // browser may not finish it (it would log that browser in to this account).
          const web = await readWebSession(ctx);
          if (!web || web.sid !== target.sid) throw errors.forbidden("This login was started in another browser");
          await setWebUser(hs, web, userId);
          return Response.redirect(hs.oauthServer!.url(target.next.slice(OAUTH_PREFIX.length)), 302);
        }
        const result = await legacyClientRedirect(hs, userId, target.redirectUrl);
        return result.confirm ? ssoConfirmPage(hs.serverName, result) : Response.redirect(result.url, 302);
      },
    }),
  );

  r.client(
    "POST",
    "/login",
    procedure({
      rateLimit: "login",
      input: loginBody,
      handler: async (ctx) => {
        const body = ctx.input;
        const hs = ctx.hs;
        if (hs.oauth) throw errors.unrecognized("Log in through the OAuth provider");
        if (hs.oauthServer && !hs.oauthServer.legacyApi) throw errors.unrecognized("Log in with the OAuth 2.0 API");
        if (body.type === M.LOGIN.APPLICATION_SERVICE) {
          const reg = ctx.accessToken() ? hs.appservices.byToken(ctx.accessToken()!) : null;
          if (!reg) throw errors.unknownToken("An application service token is required");
          const userId = await resolveLoginUser(hs, body);
          if (!hs.appservices.isInterestedUser(reg, userId)) throw errors.forbidden("User is not in the application service's namespace");
          if (!(await hs.db.findOne("users", [{ field: "user_id", value: userId }]))) throw errors.forbidden("Unknown user");
          const session = await hs.auth.createSession(userId, {
            deviceId: body.device_id,
            displayName: body.initial_device_display_name,
          });
          return { ...session, home_server: hs.serverName };
        }
        if (body.type === M.LOGIN.TOKEN) {
          if (body.token === undefined) throw errors.missingParam("Missing token");
          const userId = await hs.auth.consumeLoginToken(body.token).catch(async (err) => {
            await hs.audit.record({
              action: "login_failed",
              actor: null,
              ip: ctx.ip,
              outcome: "failure",
              details: { type: M.LOGIN.TOKEN },
            });
            throw err;
          });
          const user = await hs.db.findOne("users", [{ field: "user_id", value: userId }]);
          if (!user || user.deactivated) throw errors.userDeactivated();
          const session = await hs.auth.createSession(userId, {
            deviceId: body.device_id,
            displayName: body.initial_device_display_name,
            refreshToken: body.refresh_token === true,
          });
          await hs.audit.record({
            action: "login",
            actor: userId,
            target: session.device_id,
            ip: ctx.ip,
            userAgent: ctx.request.headers.get("user-agent"),
            details: { type: M.LOGIN.TOKEN },
          });
          return { ...session, home_server: hs.serverName, well_known: wellKnown(hs) ?? undefined };
        }
        if (body.type !== M.LOGIN.PASSWORD || !hs.userAuth.passwordLoginEnabled) throw errors.unknown("Unsupported login type");
        const userId = await resolveLoginUser(hs, body);
        if (body.password === undefined) throw errors.missingParam("Missing password");
        const ua = ctx.request.headers.get("user-agent");
        await checkPasswordLogin(hs, userId, body.password, { ip: ctx.ip, userAgent: ua });
        const session = await hs.auth.createSession(userId, {
          deviceId: body.device_id,
          displayName: body.initial_device_display_name,
          refreshToken: body.refresh_token === true,
        });
        await hs.audit.record({
          action: "login",
          actor: userId,
          target: session.device_id,
          ip: ctx.ip,
          userAgent: ua,
          details: { type: M.LOGIN.PASSWORD },
        });
        return { ...session, home_server: hs.serverName, well_known: wellKnown(hs) ?? undefined };
      },
    }),
  );

  r.client(
    "POST",
    "/refresh",
    procedure({
      input: body({ refresh_token: lenient(v.string()) }),
      handler: async (ctx) => {
        const body = ctx.input;
        if (body.refresh_token === undefined) throw errors.missingParam("Missing refresh_token");
        const { access_token, refresh_token, expires_in_ms } = await ctx.hs.auth.refresh(body.refresh_token, { clientId: null });
        return { access_token, refresh_token, expires_in_ms };
      },
    }),
  );

  r.client(
    "POST",
    "/logout",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        await ctx.hs.auth.deleteDevice(s.userId, s.deviceId);
        await ctx.hs.audit.record({ action: "logout", actor: s.userId, target: s.deviceId, ip: ctx.ip });
        return {};
      },
    }),
  );

  r.client(
    "POST",
    "/logout/all",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        await ctx.hs.auth.deleteAllDevices(s.userId);
        await ctx.hs.audit.record({ action: "logout", actor: s.userId, ip: ctx.ip, details: { all: true } });
        return {};
      },
    }),
  );

  r.client(
    "GET",
    "/account/whoami",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        return { user_id: s.userId, ...(s.deviceId ? { device_id: s.deviceId } : {}), is_guest: s.isGuest };
      },
    }),
  );

  r.client(
    "GET",
    "/register/available",
    procedure({
      handler: async (ctx) => {
        const username = ctx.query.get("username");
        if (!username) throw errors.missingParam("Missing username");
        await validateNewUsername(ctx.hs, username);
        return { available: true };
      },
    }),
  );

  r.client(
    "GET",
    "/register",
    procedure({ handler: async (ctx) => ({ flows: (await registrationFlows(ctx.hs)).map((stages) => ({ stages })), params: {} }) }),
  );

  r.client(
    "GET",
    "/register/m.login.registration_token/validity",
    procedure({
      rateLimit: "register",
      handler: async (ctx) => {
        const token = ctx.query.get("token");
        if (!token) throw errors.missingParam("Missing token");
        return { valid: await registrationTokenValid(ctx.hs, token) };
      },
    }),
    ["v1"],
  );

  r.client(
    "POST",
    "/register",
    procedure({
      input: registerBody,
      handler: async (ctx) => {
        const hs = ctx.hs;
        const body = ctx.input;
        const kind = ctx.query.get("kind") ?? "user";
        if (kind === "guest") {
          if (!hs.userAuth.guestAccessEnabled) throw errors.forbidden("Guest access is disabled");
          const userId = await createUser(hs, await generateLocalpart(hs), { guest: true });
          const session = await hs.auth.createSession(userId, { displayName: body.initial_device_display_name });
          return { ...session, home_server: hs.serverName };
        }
        if (kind !== "user") throw errors.invalidParam("Unknown kind");
        // Application services register users in their namespace without UIA.
        if (body.type === M.LOGIN.APPLICATION_SERVICE || body.auth?.type === M.LOGIN.APPLICATION_SERVICE) {
          const s = await ctx.auth();
          if (!s.appservice) throw errors.forbidden("An application service token is required");
          if (body.username === undefined) throw errors.missingParam("Missing username");
          const localpart = body.username.toLowerCase();
          const userId = `@${localpart}:${hs.serverName}`;
          if (!hs.appservices.isInterestedUser(s.appservice, userId))
            throw errors.exclusive("User is not in the application service's namespace");
          if (!LOCALPART_RE.test(localpart)) throw errors.invalidUsername();
          if (await hs.db.findOne("users", [{ field: "user_id", value: userId }])) throw errors.userInUse();
          await createUser(hs, localpart, {});
          if (body.inhibit_login === true) return { user_id: userId, home_server: hs.serverName };
          return {
            ...(await hs.auth.createSession(userId, {
              deviceId: body.device_id,
              displayName: body.initial_device_display_name,
            })),
            home_server: hs.serverName,
          };
        }
        if (ctx.accessToken() && hs.appservices.byToken(ctx.accessToken()!))
          throw errors.missingParam("Application services must use type m.login.application_service");
        rejectIfDelegated(hs);
        if (!(await hs.registrationAllowed())) throw errors.forbidden("Registration is disabled");
        await ctx.rateLimit("register");
        const localpart =
          body.username !== undefined ? await validateNewUsername(hs, body.username.toLowerCase()) : await generateLocalpart(hs);
        if (hs.appservices.exclusiveUserOwner(`@${localpart}:${hs.serverName}`))
          throw errors.exclusive("This user ID is reserved by an application service");
        if (body.password !== undefined) {
          const problem = await hs.userAuth.validatePassword(body.password);
          if (problem) throw new MatrixError(400, "M_WEAK_PASSWORD", problem);
        }
        const flows = await registrationFlows(hs);
        const { threepids, registrationToken } = await requireUia(hs, body, flows, null);
        if (registrationToken) await redeemRegistrationToken(hs, registrationToken);
        // Re-check after UIA in case of a race between two registrations.
        if (await hs.db.findOne("users", [{ field: "localpart", value: localpart }])) throw errors.userInUse();
        const userId = await createUser(hs, localpart, { password: body.password });
        for (const t of threepids)
          await hs.threepids.add(userId, t).catch((err) => hs.logger.warn("Could not attach", t.medium, "to", userId, err));
        await hs.audit.record({
          action: "register",
          actor: userId,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          details: { token: body.auth?.type === M.LOGIN.REGISTRATION_TOKEN },
        });
        if (body.inhibit_login === true) return { user_id: userId, home_server: hs.serverName };
        const session = await hs.auth.createSession(userId, {
          deviceId: body.device_id,
          displayName: body.initial_device_display_name,
          refreshToken: body.refresh_token === true,
        });
        return { ...session, home_server: hs.serverName };
      },
    }),
  );

  r.client(
    "POST",
    "/account/password",
    procedure({
      input: passwordBody,
      handler: async (ctx) => {
        const hs = ctx.hs;
        rejectIfDelegated(hs);
        const body = ctx.input;
        // Without an access token, the password is reset by proving ownership of an address of the account.
        let s: { userId: string; deviceId: string | null };
        if (ctx.accessToken()) {
          const session = await ctx.auth();
          await requireUia(hs, body, [[M.LOGIN.PASSWORD]], session.userId, { session });
          s = { userId: session.userId, deviceId: session.deviceId };
        } else {
          const { threepids } = await requireUia(hs, body, [[M.LOGIN.EMAIL.IDENTITY], [M.LOGIN.MSISDN]], null);
          const owner = threepids.length ? await hs.threepids.userFor(threepids[0].medium, threepids[0].address) : null;
          if (!owner) throw new MatrixError(400, "M_THREEPID_NOT_FOUND", "No account uses this address");
          s = { userId: owner, deviceId: null };
        }
        if (!body.new_password) throw errors.missingParam("Missing new_password");
        const problem = await hs.userAuth.validatePassword(body.new_password);
        if (problem) throw new MatrixError(400, "M_WEAK_PASSWORD", problem);
        await hs.db.update("users", [{ field: "user_id", value: s.userId }], {
          password_hash: await hs.userAuth.hashPassword(body.new_password),
        });
        await hs.audit.record({
          action: "password_change",
          actor: s.userId,
          ip: ctx.ip,
          details: { logout_devices: body.logout_devices !== false },
        });
        if (body.logout_devices !== false) await hs.auth.deleteAllDevices(s.userId, s.deviceId ?? undefined);
        return {};
      },
    }),
  );

  r.client(
    "POST",
    "/account/deactivate",
    procedure({
      input: body({}),
      handler: async (ctx) => {
        const hs = ctx.hs;
        rejectIfDelegated(hs);
        const s = await ctx.auth();
        await requireUia(hs, ctx.input, [[M.LOGIN.PASSWORD]], s.userId, { session: s });
        for (const membership of ["join", "invite", "knock"]) {
          for (const roomId of await hs.rooms.roomsForUser(s.userId, membership)) {
            try {
              await hs.rooms.setMembership(roomId, s.userId, s.userId, "leave");
            } catch {
              /* best effort */
            }
          }
        }
        await hs.auth.deleteAllDevices(s.userId);
        await hs.db.update("users", [{ field: "user_id", value: s.userId }], {
          deactivated: true,
          password_hash: null,
          displayname: null,
          avatar_url: null,
        });
        await hs.db.delete("profile_fields", [{ field: "user_id", value: s.userId }]);
        const unbind = await hs.threepids.removeAll(s.userId);
        await hs.audit.record({ action: "deactivate", actor: s.userId, target: s.userId, ip: ctx.ip });
        return { id_server_unbind_result: unbind };
      },
    }),
  );

  // Synapse-compatible shared-secret registration, used by Complement for admin users.
  r.get(
    "/_synapse/admin/v1/register",
    procedure({
      handler: async (ctx) => {
        if (!ctx.hs.config.registrationSharedSecret) throw errors.unrecognized();
        const nonce = randomString(32);
        await ctx.hs.cluster.set(`regnonce:${nonce}`, true, 60_000);
        return { nonce };
      },
    }),
  );
  r.post(
    "/_synapse/admin/v1/register",
    procedure({
      input: sharedSecretRegisterBody,
      handler: async (ctx) => {
        const hs = ctx.hs;
        const secret = hs.config.registrationSharedSecret;
        if (!secret) throw errors.unrecognized();
        const body = ctx.input;
        if (body.nonce === undefined || !(await hs.cluster.get(`regnonce:${body.nonce}`))) throw errors.unknown("Unrecognised nonce");
        await hs.cluster.delete(`regnonce:${body.nonce}`);
        const admin = body.admin === true;
        // HMAC-SHA1 is what Synapse's shared-secret registration protocol specifies (tools compute the
        // same MAC). It only authenticates this request; passwords are stored with scrypt.
        const expected = createHmac("sha1", secret)
          .update(`${body.nonce}\u0000${body.username}\u0000${body.password}\u0000${admin ? "admin" : "notadmin"}`)
          .digest("hex");
        const given = Buffer.from(body.mac ?? "", "utf8");
        if (given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected, "utf8")))
          throw errors.forbidden("HMAC incorrect");
        const localpart = await validateNewUsername(hs, body.username.toLowerCase());
        const userId = await createUser(hs, localpart, {
          password: body.password,
          admin,
          displayname: body.displayname,
        });
        const session = await hs.auth.createSession(userId);
        await hs.audit.record({ action: "register", actor: "server", target: userId, ip: ctx.ip, details: { shared_secret: true, admin } });
        return { ...session, home_server: hs.serverName };
      },
    }),
  );
}

export async function registrationFlows(hs: Homeserver): Promise<string[][]> {
  // The very first account (admin bootstrap) never needs a token.
  if (hs.adminRoom?.options.firstUserCanRegister && (await hs.adminRoom.noUsersYet())) return [[M.LOGIN.DUMMY]];
  const base = (await hs.registrationMode()) === "token" ? [M.LOGIN.REGISTRATION_TOKEN] : [M.LOGIN.DUMMY];
  // With email validation available, an address can be given at registration (or must be).
  if (!hs.threepids.canValidate("email")) return [base];
  const withEmail = [...base.filter((s) => s !== M.LOGIN.DUMMY), M.LOGIN.EMAIL.IDENTITY];
  return hs.config.threepid.requireEmailForRegistration ? [withEmail] : [base, withEmail];
}

export async function registrationTokenValid(hs: Homeserver, token: string): Promise<boolean> {
  const row = await hs.db.findOne("registration_tokens", [{ field: "token", value: token }]);
  if (!row) return false;
  if (row.expiry_time !== null && row.expiry_time < Date.now()) return false;
  return row.uses_allowed === null || row.completed < row.uses_allowed;
}

/**
 * Count one use of a registration token; throws when it has expired or has no uses left.
 *
 * https://github.com/k18k/katrix/issues/81 — race condition (CWE-362), limit bypass (CWE-841):
 * the use was checked at the UIA stage and counted later in a separate read and write, so concurrent registrations
 * all passed the check, and a use was not counted at all when the token stage was not the last one. The token now
 * comes from the UIA session, and the check and the count happen together under a lock per token.
 */
export async function redeemRegistrationToken(hs: Homeserver, token: string): Promise<void> {
  await hs.cluster.lock(`registration-token:${token}`, async () => {
    if (!(await registrationTokenValid(hs, token))) throw errors.forbidden("Invalid registration token");
    const row = (await hs.db.findOne("registration_tokens", [{ field: "token", value: token }]))!;
    await hs.db.update("registration_tokens", [{ field: "token", value: token }], { completed: row.completed + 1 });
  });
}

export function wellKnown(hs: Homeserver): Record<string, any> | null {
  if (!hs.config.publicBaseUrl) return null;
  const wk: Record<string, any> = { [M.HOMESERVER]: { base_url: hs.config.publicBaseUrl } };
  if (hs.config.rtc.transports?.length) wk[UNSTABLE.ORG.MATRIX.MSC4143.RTC_FOCI] = hs.config.rtc.transports;
  return wk;
}
