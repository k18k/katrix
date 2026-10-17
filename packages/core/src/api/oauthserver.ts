import { timingSafeEqual } from "node:crypto";
import { MatrixError, errors } from "#core/errors.ts";
import { randomToken } from "#core/crypto.ts";
import { escapeHtml } from "#core/html.ts";
import { LOCALPART_RE } from "#core/ids.ts";
import { M } from "#core/m.ts";
import { setProfileField } from "#core/profile.ts";
import { legacyClientRedirect } from "#core/sso.ts";
import { OAUTH_PREFIX, OAuthError, allowCrossSigningReset, type ClientMetadata, type OAuthServer } from "#core/oauthserver.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import {
  checkPasswordLogin,
  createUser,
  redeemRegistrationToken,
  registrationFlows,
  registrationTokenValid,
  ssoConfirmPage,
  validateNewUsername,
} from "#api/account.ts";

// The OAuth 2.0 API's endpoints and the web pages users see (see src/core/oauthserver.ts).
//
// The pages keep a browser session in a cookie (HttpOnly, SameSite=Lax; `__Host-` and Secure
// when the server is on https). Every form carries the session's CSRF token, and a request with
// an Origin header from another site is refused. Pages may not be framed, so another site
// cannot click their buttons for the user.

/** A browser's session on the pages. */
export interface WebSession {
  sid: string;
  csrf: string;
  userId?: string;
  authTime?: number;
}

const P = OAUTH_PREFIX;

function server(hs: Homeserver): OAuthServer {
  if (!hs.oauthServer) throw errors.unrecognized("The OAuth 2.0 API is not enabled");
  return hs.oauthServer;
}

function cookieName(hs: Homeserver): string {
  return secure(hs) ? "__Host-oauth_session" : "oauth_session";
}

const secure = (hs: Homeserver) => server(hs).issuer.startsWith("https:");
const sessionTtl = (hs: Homeserver) => server(hs).options.webSessionLifetimeMs ?? 7 * 24 * 3600_000;

function readCookie(ctx: RequestContext, name: string): string | null {
  for (const part of (ctx.request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** The browser's session, if it has one. */
export async function readWebSession(ctx: RequestContext): Promise<WebSession | null> {
  if (!ctx.hs.oauthServer) return null;
  const sid = readCookie(ctx, cookieName(ctx.hs));
  if (!sid || !/^[A-Za-z0-9_-]{20,100}$/.test(sid)) return null;
  return ctx.hs.cluster.get<WebSession>(`oauth:web:${sid}`);
}

/** The browser's session, created (with a cookie to set) when it has none. */
async function webSession(ctx: RequestContext): Promise<{ web: WebSession; cookie?: string }> {
  const existing = await readWebSession(ctx);
  if (existing) return { web: existing };
  const web: WebSession = { sid: randomToken(32), csrf: randomToken(24) };
  await ctx.hs.cluster.set(`oauth:web:${web.sid}`, web, sessionTtl(ctx.hs));
  const attrs = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${Math.floor(sessionTtl(ctx.hs) / 1000)}`];
  if (secure(ctx.hs)) attrs.push("Secure");
  return { web, cookie: `${cookieName(ctx.hs)}=${web.sid}; ${attrs.join("; ")}` };
}

/** Log the browser session in (password, registration or an upstream provider). */
export async function setWebUser(hs: Homeserver, web: WebSession, userId: string | undefined): Promise<void> {
  const next: WebSession = { sid: web.sid, csrf: web.csrf };
  if (userId) Object.assign(next, { userId, authTime: Date.now() });
  Object.assign(web, next);
  await hs.cluster.set(`oauth:web:${web.sid}`, next, sessionTtl(hs));
}

/** A `next` value: a page of this server, nothing else (no open redirect). */
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith(`${P}/`) && !raw.includes("//") && !raw.includes("\\") && !raw.includes("..")) return raw;
  return `${P}/account`;
}

const pageUrl = (hs: Homeserver, path: string) => server(hs).url(path.startsWith(P) ? path.slice(P.length) : path);

function redirect(location: string, cookie?: string, status = 303): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
}

async function readForm(ctx: RequestContext): Promise<URLSearchParams> {
  return new URLSearchParams(new TextDecoder().decode(await ctx.bytes()));
}

function checkCsrf(ctx: RequestContext, web: WebSession, form: URLSearchParams): void {
  const origin = ctx.request.headers.get("origin");
  if (origin && origin !== new URL(server(ctx.hs).issuer).origin) throw errors.forbidden("Cross-site request");
  const given = Buffer.from(form.get("csrf") ?? "");
  const expected = Buffer.from(web.csrf);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw errors.forbidden("The form expired; reload the page");
}

// --- Rendering ----------------------------------------------------------------

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1b1f24;--muted:#5d6670;--line:#dde1e6;--accent:#0b7a55;--accent-text:#fff;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1e23;--text:#e8eaed;--muted:#9aa3ad;--line:#2c323a;--accent:#2fb37f;--accent-text:#06120d;--danger:#f97066}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:30rem;margin:2.5rem auto;padding:0 1rem}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.5rem;margin-bottom:1rem}
h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:0 0 .75rem}p{margin:.5rem 0}.muted{color:var(--muted);font-size:.9rem}
label{display:block;font-size:.9rem;margin:.75rem 0 .25rem}input[type=text],input[type=password]{width:100%;padding:.6rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
button,a.button{display:inline-block;margin-top:1rem;padding:.6rem 1.1rem;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit;cursor:pointer;text-decoration:none}
button.primary,a.button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}button.danger{color:var(--danger)}
.row{display:flex;gap:.5rem;flex-wrap:wrap}.error{color:var(--danger)}.notice{border-left:3px solid var(--accent);padding-left:.75rem}
ul.devices{list-style:none;padding:0;margin:0}ul.devices li{padding:.6rem 0;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:.5rem;align-items:center}
ul.devices li.focus{background:color-mix(in srgb,var(--accent) 10%,transparent)}ul.devices button{margin:0}code{font-size:.9em;word-break:break-all}
.client{display:flex;gap:.75rem;align-items:center}.client img{width:48px;height:48px;border-radius:8px}footer{text-align:center}footer a{color:var(--muted)}`;

function page(hs: Homeserver, title: string, body: string, opts: { status?: number; cookie?: string } = {}): Response {
  const o = server(hs).options;
  const links = [
    o.termsUrl && `<a href="${escapeHtml(o.termsUrl)}">Terms</a>`,
    o.policyUrl && `<a href="${escapeHtml(o.policyUrl)}">Privacy</a>`,
  ]
    .filter(Boolean)
    .join(" · ");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(hs.serverName)}</title><style>${STYLE}</style>
<main>${body}${links ? `<footer class="muted">${links}</footer>` : ""}</main></html>`;
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // https://github.com/k18k/matrix-nodejs-homeserver/issues/71: with no-referrer, Chrome sends
    // `Origin: null` on the pages' own form posts, which the Origin check refused. same-origin
    // keeps page URLs (they can hold codes) from other sites as well.
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https:; frame-ancestors 'none'; base-uri 'none'",
  });
  if (opts.cookie) headers.append("set-cookie", opts.cookie);
  return new Response(html, { status: opts.status ?? 200, headers });
}

function errorPage(hs: Homeserver, message: string, status = 400): Response {
  return page(hs, "Something went wrong", `<div class="card"><h1>Something went wrong</h1><p>${escapeHtml(message)}</p></div>`, { status });
}

const csrfField = (web: WebSession) => `<input type="hidden" name="csrf" value="${escapeHtml(web.csrf)}">`;

/** Who the client is, as far as its registration says. */
function clientCard(client: ClientMetadata): string {
  const host = new URL(client.client_uri).host;
  const name = client.client_name ?? host;
  const logo = client.logo_uri ? `<img src="${escapeHtml(client.logo_uri)}" alt="">` : "";
  const docs = [
    client.tos_uri && `<a href="${escapeHtml(client.tos_uri)}">terms</a>`,
    client.policy_uri && `<a href="${escapeHtml(client.policy_uri)}">privacy policy</a>`,
  ].filter(Boolean);
  return `<div class="client">${logo}<div><b>${escapeHtml(name)}</b><div class="muted"><a href="${escapeHtml(client.client_uri)}">${escapeHtml(host)}</a>${
    docs.length ? ` · ${docs.join(" · ")}` : ""
  }</div></div></div>`;
}

/** Wraps a page handler: Matrix errors (rate limits, bad input) become an error page. */
function pageRoute(handler: (ctx: RequestContext) => Promise<Response>) {
  return procedure({
    handler: async (ctx) => {
      server(ctx.hs);
      try {
        return await handler(ctx);
      } catch (err) {
        if (err instanceof MatrixError) return errorPage(ctx.hs, err.message, err.status);
        if (err instanceof OAuthError) return errorPage(ctx.hs, err.description, err.status);
        throw err;
      }
    },
  });
}

/** The logged-in user of the browser, or a redirect to the login page that comes back here. */
async function loggedIn(ctx: RequestContext, here: string): Promise<{ web: WebSession; userId: string; cookie?: string } | Response> {
  const { web, cookie } = await webSession(ctx);
  if (web.userId) {
    const user = await ctx.hs.db.findOne("users", [{ field: "user_id", value: web.userId }]);
    if (user && !user.deactivated) {
      if (user.locked) return errorPage(ctx.hs, "This account is locked.", 403);
      return { web, userId: web.userId, cookie };
    }
    await setWebUser(ctx.hs, web, undefined);
  }
  return redirect(`${pageUrl(ctx.hs, "/login")}?next=${encodeURIComponent(here)}`, cookie, 302);
}

/** Whether the registration page can create an account now, and whether it needs a token. */
async function registration(hs: Homeserver): Promise<{ open: boolean; token: boolean }> {
  if (!hs.userAuth.passwordLoginEnabled || !(await hs.registrationAllowed())) return { open: false, token: false };
  const flows = await registrationFlows(hs);
  // Registering with an email address needs a client that can validate it.
  if (flows.every((f) => f.includes(M.LOGIN.EMAIL.IDENTITY))) return { open: false, token: false };
  return { open: true, token: flows.every((f) => f.includes(M.LOGIN.REGISTRATION_TOKEN)) };
}

function providerButtons(hs: Homeserver, next: string): string {
  return (hs.sso?.providers ?? [])
    .map(
      (p) =>
        `<a class="button" href="${escapeHtml(`${pageUrl(hs, `/upstream/${encodeURIComponent(p.id)}`)}?next=${encodeURIComponent(next)}`)}">Continue with ${escapeHtml(p.name)}</a>`,
    )
    .join(" ");
}

async function loginPage(
  ctx: RequestContext,
  web: WebSession,
  next: string,
  opts: { error?: string; cookie?: string; username?: string } = {},
) {
  const hs = ctx.hs;
  const reg = await registration(hs);
  const password = hs.userAuth.passwordLoginEnabled
    ? `<form method="post" action="${escapeHtml(pageUrl(hs, "/login"))}">${csrfField(web)}<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="u">Username</label><input id="u" type="text" name="username" autocomplete="username" autocapitalize="none" required value="${escapeHtml(opts.username ?? "")}">
<label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required>
<button class="primary" type="submit">Sign in</button></form>`
    : "";
  const providers = providerButtons(hs, next);
  const body = `<div class="card"><h1>Sign in</h1><p class="muted">to <b>${escapeHtml(hs.serverName)}</b></p>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}${password}
${providers ? `<div class="row">${providers}</div>` : ""}
${!password && !providers ? "<p>No way to sign in is configured on this server.</p>" : ""}
${reg.open ? `<p class="muted">No account? <a href="${escapeHtml(`${pageUrl(hs, "/register-account")}?next=${encodeURIComponent(next)}`)}">Create one</a></p>` : ""}</div>`;
  return page(hs, "Sign in", body, { cookie: opts.cookie, status: opts.error ? 401 : 200 });
}

async function registerPage(
  ctx: RequestContext,
  web: WebSession,
  next: string,
  opts: { error?: string; cookie?: string; username?: string } = {},
) {
  const hs = ctx.hs;
  const reg = await registration(hs);
  const providers = providerButtons(hs, next);
  if (!reg.open) {
    const body = `<div class="card"><h1>Create an account</h1>${
      providers
        ? `<p>Sign in with one of these and an account is created for you:</p><div class="row">${providers}</div>`
        : "<p>This server does not take new accounts.</p>"
    }<p class="muted"><a href="${escapeHtml(`${pageUrl(hs, "/login")}?next=${encodeURIComponent(next)}`)}">Sign in instead</a></p></div>`;
    return page(hs, "Create an account", body, { cookie: opts.cookie });
  }
  const o = server(hs).options;
  const terms =
    o.termsUrl || o.policyUrl ? `<p class="muted">By creating an account you accept the terms and privacy policy linked below.</p>` : "";
  const body = `<div class="card"><h1>Create an account</h1><p class="muted">on <b>${escapeHtml(hs.serverName)}</b></p>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
<form method="post" action="${escapeHtml(pageUrl(hs, "/register-account"))}">${csrfField(web)}<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="u">Username</label><input id="u" type="text" name="username" autocomplete="username" autocapitalize="none" required value="${escapeHtml(opts.username ?? "")}">
<label for="p">Password</label><input id="p" type="password" name="password" autocomplete="new-password" required>
${reg.token ? `<label for="t">Registration token</label><input id="t" type="text" name="token" required>` : ""}
${terms}<button class="primary" type="submit">Create account</button></form>
${providers ? `<p class="muted">Or sign in with:</p><div class="row">${providers}</div>` : ""}
<p class="muted"><a href="${escapeHtml(`${pageUrl(hs, "/login")}?next=${encodeURIComponent(next)}`)}">I already have an account</a></p></div>`;
  return page(hs, "Create an account", body, { cookie: opts.cookie, status: opts.error ? 400 : 200 });
}

/** The approval form shared by the authorization code and device flows. */
function consentPage(
  hs: Homeserver,
  web: WebSession,
  opts: {
    client: ClientMetadata;
    userId: string;
    deviceId: string;
    action: string;
    hidden: Record<string, string>;
    here: string;
    cookie?: string;
  },
) {
  const hidden = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  const body = `<div class="card"><h1>Allow access?</h1>${clientCard(opts.client)}
<p>This app wants full access to your account <b>${escapeHtml(opts.userId)}</b>: your messages, rooms and keys. It will sign in as the device <code>${escapeHtml(opts.deviceId)}</code>.</p>
<p class="muted">Only continue if you just started signing in with this app.</p>
<form method="post" action="${escapeHtml(opts.action)}">${csrfField(web)}${hidden}<div class="row">
<button class="primary" type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Deny</button></div></form></div>
<form method="post" action="${escapeHtml(pageUrl(hs, "/logout"))}">${csrfField(web)}<input type="hidden" name="next" value="${escapeHtml(opts.here)}">
<p class="muted">Not ${escapeHtml(opts.userId)}? <button type="submit">Use another account</button></p></form>`;
  return page(hs, "Allow access", body, { cookie: opts.cookie });
}

function oauthJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" },
  });
}

/** OAuth endpoints answer with RFC 6749 errors, not Matrix ones. */
function oauthEndpoint(handler: (ctx: RequestContext, server: OAuthServer) => Promise<Response>) {
  return procedure({
    handler: async (ctx) => {
      const s = server(ctx.hs);
      try {
        return await handler(ctx, s);
      } catch (err) {
        if (err instanceof OAuthError) return oauthJson({ error: err.error, error_description: err.description }, err.status);
        throw err;
      }
    },
  });
}

/** The client of a token request: Basic credentials (RFC 6749 section 2.3.1) or `client_id`. */
function requestClientId(ctx: RequestContext, form: URLSearchParams): string | null {
  const header = ctx.request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    return decodeURIComponent(decoded.split(":")[0]);
  }
  return form.get("client_id");
}

const DONE: Record<string, string> = {
  device_deleted: "The device was signed out.",
  profile: "Your profile was saved.",
  password: "Your password was changed.",
  reset_allowed: "Resetting your identity is allowed for the next 10 minutes. Go back to your app to finish.",
};

export function registerOAuthServerRoutes(r: Router): void {
  // --- Endpoints for clients ----------------------------------------------------

  r.post(
    `${P}/register`,
    oauthEndpoint(async (ctx, s) => {
      await ctx.rateLimit("oauthClient");
      let raw: Record<string, unknown>;
      try {
        raw = await ctx.json();
      } catch {
        throw new OAuthError("invalid_client_metadata", "The body must be a JSON object");
      }
      return oauthJson(await s.registerClient(raw), 201);
    }),
  );

  r.post(
    `${P}/token`,
    oauthEndpoint(async (ctx, s) => {
      const form = await readForm(ctx);
      return oauthJson(await s.token(form, requestClientId(ctx, form)));
    }),
  );

  r.post(
    `${P}/revoke`,
    oauthEndpoint(async (ctx, s) => {
      await s.revoke((await readForm(ctx)).get("token"));
      return oauthJson({});
    }),
  );

  r.post(
    `${P}/device`,
    oauthEndpoint(async (ctx, s) => {
      await ctx.rateLimit("oauthClient");
      const form = await readForm(ctx);
      return oauthJson(await s.startDeviceGrant(requestClientId(ctx, form), form.get("scope")));
    }),
  );

  r.get(`${P}/keys.json`, procedure({ handler: (ctx) => server(ctx.hs).jwks() }));

  const userinfo = procedure({ auth: "user", handler: (ctx) => ({ sub: ctx.session.userId }) });
  r.get(`${P}/userinfo`, userinfo);
  r.post(`${P}/userinfo`, userinfo);

  // --- Authorization code flow ----------------------------------------------------

  r.get(
    `${P}/authorize`,
    pageRoute(async (ctx) => {
      const s = server(ctx.hs);
      let checked;
      try {
        checked = await s.checkAuthorizationRequest(ctx.query);
      } catch (err) {
        // The client or its redirect URI could not be verified: tell the user, do not redirect.
        if (err instanceof OAuthError) return errorPage(ctx.hs, `The app sent an invalid request: ${err.description}.`);
        throw err;
      }
      if ("error" in checked) return redirect(checked.redirect, undefined, 302);
      const id = await s.saveGrant(checked.grant);
      return redirect(pageUrl(ctx.hs, `/consent/${id}`), undefined, 302);
    }),
  );

  r.get(
    `${P}/consent/:id`,
    pageRoute(async (ctx) => {
      const s = server(ctx.hs);
      const grant = await s.grant(ctx.params.id);
      if (!grant) return errorPage(ctx.hs, "This sign-in request expired. Start again from your app.");
      const here = `${P}/consent/${ctx.params.id}`;
      const { web, cookie } = await webSession(ctx);
      if (!web.userId && grant.create && (await registration(ctx.hs)).open)
        return redirect(`${pageUrl(ctx.hs, "/register-account")}?next=${encodeURIComponent(here)}`, cookie, 302);
      const who = await loggedIn(ctx, here);
      if (who instanceof Response) return who;
      const client = await s.client(grant.clientId);
      if (!client) return errorPage(ctx.hs, "The app is no longer registered. Start again from your app.");
      return consentPage(ctx.hs, who.web, {
        client,
        userId: who.userId,
        deviceId: grant.deviceId,
        action: pageUrl(ctx.hs, here),
        hidden: {},
        here,
        cookie: who.cookie,
      });
    }),
  );

  r.post(
    `${P}/consent/:id`,
    pageRoute(async (ctx) => {
      const s = server(ctx.hs);
      const form = await readForm(ctx);
      const here = `${P}/consent/${ctx.params.id}`;
      const who = await loggedIn(ctx, here);
      if (who instanceof Response) return who;
      checkCsrf(ctx, who.web, form);
      const grant = await s.grant(ctx.params.id);
      if (!grant) return errorPage(ctx.hs, "This sign-in request expired. Start again from your app.");
      if (form.get("decision") !== "allow") return redirect(await s.denyGrant(ctx.params.id, grant));
      return redirect(await s.approveGrant(ctx.params.id, grant, who.userId, who.web.authTime ?? Date.now()));
    }),
  );

  // --- Device authorization flow --------------------------------------------------

  r.get(
    `${P}/link`,
    pageRoute(async (ctx) => {
      const s = server(ctx.hs);
      const code = ctx.query.get("code") ?? "";
      const here = `${P}/link${code ? `?code=${encodeURIComponent(code)}` : ""}`;
      const who = await loggedIn(ctx, here);
      if (who instanceof Response) return who;
      const found = code ? await s.deviceGrantByUserCode(code) : null;
      const client = found ? await s.client(found.grant.clientId) : null;
      if (found && client)
        return consentPage(ctx.hs, who.web, {
          client,
          userId: who.userId,
          deviceId: found.grant.deviceId,
          action: pageUrl(ctx.hs, "/link"),
          hidden: { code: found.grant.userCode },
          here,
          cookie: who.cookie,
        });
      const body = `<div class="card"><h1>Link a device</h1><p>Enter the code your device shows.</p>
${code ? `<p class="error">That code is unknown or expired.</p>` : ""}
<form method="get" action="${escapeHtml(pageUrl(ctx.hs, "/link"))}"><label for="c">Code</label><input id="c" type="text" name="code" autocomplete="off" autocapitalize="characters" required placeholder="ABCD-EFGH">
<button class="primary" type="submit">Continue</button></form></div>`;
      return page(ctx.hs, "Link a device", body, { cookie: who.cookie });
    }),
  );

  r.post(
    `${P}/link`,
    pageRoute(async (ctx) => {
      const s = server(ctx.hs);
      const form = await readForm(ctx);
      const who = await loggedIn(ctx, `${P}/link`);
      if (who instanceof Response) return who;
      checkCsrf(ctx, who.web, form);
      const found = await s.deviceGrantByUserCode(form.get("code") ?? "");
      if (!found) return errorPage(ctx.hs, "That code is unknown or expired. Start again on your device.");
      const allow = form.get("decision") === "allow";
      await s.decideDeviceGrant(found.deviceCode, found.grant, who.userId, allow);
      const text = allow ? "Your device is signed in. You can close this page." : "Access was denied. You can close this page.";
      return page(ctx.hs, "Link a device", `<div class="card"><h1>${allow ? "Done" : "Denied"}</h1><p>${text}</p></div>`);
    }),
  );

  // --- Login, registration, upstream providers --------------------------------------

  r.get(
    `${P}/login`,
    pageRoute(async (ctx) => {
      const next = safeNext(ctx.query.get("next"));
      const { web, cookie } = await webSession(ctx);
      if (web.userId) return redirect(pageUrl(ctx.hs, next), cookie, 302);
      return loginPage(ctx, web, next, { cookie });
    }),
  );

  r.post(
    `${P}/login`,
    pageRoute(async (ctx) => {
      const hs = ctx.hs;
      const form = await readForm(ctx);
      const { web, cookie } = await webSession(ctx);
      checkCsrf(ctx, web, form);
      const next = safeNext(form.get("next"));
      if (!hs.userAuth.passwordLoginEnabled) return errorPage(hs, "Password login is disabled on this server.", 403);
      await hs.rateLimits.check("login", ctx.ip ?? "unknown");
      const username = (form.get("username") ?? "").trim();
      const localpart = (username.startsWith("@") ? username.slice(1).split(":")[0] : username).toLowerCase();
      const userId = `@${localpart}:${hs.serverName}`;
      try {
        if (!LOCALPART_RE.test(localpart) || (username.includes(":") && !username.endsWith(`:${hs.serverName}`)))
          throw errors.forbidden("Invalid username or password");
        await checkPasswordLogin(hs, userId, form.get("password") ?? "", { ip: ctx.ip, userAgent: ctx.request.headers.get("user-agent") });
      } catch (err) {
        if (err instanceof MatrixError) return loginPage(ctx, web, next, { error: err.message, cookie, username });
        throw err;
      }
      await hs.audit.record({
        action: "login",
        actor: userId,
        ip: ctx.ip,
        userAgent: ctx.request.headers.get("user-agent"),
        details: { web: true },
      });
      await setWebUser(hs, web, userId);
      return redirect(pageUrl(hs, next), cookie);
    }),
  );

  r.get(
    `${P}/register-account`,
    pageRoute(async (ctx) => {
      const next = safeNext(ctx.query.get("next"));
      const { web, cookie } = await webSession(ctx);
      if (web.userId) return redirect(pageUrl(ctx.hs, next), cookie, 302);
      return registerPage(ctx, web, next, { cookie });
    }),
  );

  r.post(
    `${P}/register-account`,
    pageRoute(async (ctx) => {
      const hs = ctx.hs;
      const form = await readForm(ctx);
      const { web, cookie } = await webSession(ctx);
      checkCsrf(ctx, web, form);
      const next = safeNext(form.get("next"));
      const reg = await registration(hs);
      if (!reg.open) return errorPage(hs, "Registration is closed.", 403);
      await hs.rateLimits.check("register", ctx.ip ?? "unknown");
      const username = (form.get("username") ?? "").trim().toLowerCase();
      const password = form.get("password") ?? "";
      const token = form.get("token") ?? "";
      let userId: string;
      try {
        const localpart = await validateNewUsername(hs, username);
        if (hs.appservices.exclusiveUserOwner(`@${localpart}:${hs.serverName}`)) throw errors.exclusive("This username is reserved");
        const problem = await hs.userAuth.validatePassword(password);
        if (problem || !password) throw new MatrixError(400, "M_WEAK_PASSWORD", problem ?? "Choose a password");
        if (reg.token && !(await registrationTokenValid(hs, token))) throw errors.forbidden("Invalid registration token");
        if (reg.token) await redeemRegistrationToken(hs, token);
        userId = await createUser(hs, localpart, { password });
      } catch (err) {
        if (err instanceof MatrixError) return registerPage(ctx, web, next, { error: err.message, cookie, username });
        throw err;
      }
      await hs.audit.record({
        action: "register",
        actor: userId,
        ip: ctx.ip,
        userAgent: ctx.request.headers.get("user-agent"),
        details: { web: true, token: reg.token },
      });
      await setWebUser(hs, web, userId);
      return redirect(pageUrl(hs, next), cookie);
    }),
  );

  r.get(
    `${P}/upstream/:idp`,
    pageRoute(async (ctx) => {
      const hs = ctx.hs;
      if (!hs.sso?.providers.some((p) => p.id === ctx.params.idp)) return errorPage(hs, "Unknown sign-in provider.", 404);
      const { web, cookie } = await webSession(ctx);
      const next = safeNext(ctx.query.get("next"));
      return redirect(await hs.sso.startLogin(ctx.params.idp, { kind: "web", next, sid: web.sid }), cookie, 302);
    }),
  );

  r.post(
    `${P}/logout`,
    pageRoute(async (ctx) => {
      const form = await readForm(ctx);
      const { web, cookie } = await webSession(ctx);
      checkCsrf(ctx, web, form);
      await setWebUser(ctx.hs, web, undefined);
      return redirect(`${pageUrl(ctx.hs, "/login")}?next=${encodeURIComponent(safeNext(form.get("next")))}`, cookie);
    }),
  );

  // The legacy API's m.login.sso through these pages: a login token for the client.
  r.get(
    `${P}/legacy/:id`,
    pageRoute(async (ctx) => {
      const hs = ctx.hs;
      const key = `oauth:legacy:${ctx.params.id}`;
      const redirectUrl = await hs.cluster.get<string>(key);
      if (!redirectUrl) return errorPage(hs, "This sign-in request expired. Start again from your app.");
      const who = await loggedIn(ctx, `${P}/legacy/${ctx.params.id}`);
      if (who instanceof Response) return who;
      await hs.cluster.delete(key);
      const result = await legacyClientRedirect(hs, who.userId, redirectUrl);
      return result.confirm ? ssoConfirmPage(hs.serverName, result) : redirect(result.url, who.cookie, 302);
    }),
  );

  // --- Account management ---------------------------------------------------------

  r.get(
    `${P}/account`,
    pageRoute(async (ctx) => {
      const hs = ctx.hs;
      const action = ctx.query.get("action") ?? "";
      const focusDevice = ctx.query.get("device_id") ?? "";
      const who = await loggedIn(ctx, `${P}/account${ctx.url.search}`);
      if (who instanceof Response) return who;
      const { web, userId } = who;
      const user = (await hs.db.findOne("users", [{ field: "user_id", value: userId }]))!;
      const devices = await hs.db.findMany("devices", { where: [{ field: "user_id", value: userId }] });
      const self = pageUrl(hs, "/account");
      const form = (op: string, inner: string) =>
        `<form method="post" action="${escapeHtml(self)}">${csrfField(web)}<input type="hidden" name="op" value="${op}">${inner}</form>`;
      const done = DONE[ctx.query.get("done") ?? ""];
      const sections: string[] = [];
      sections.push(`<div class="card"><h1>Your account</h1><p><b>${escapeHtml(userId)}</b></p>${done ? `<p class="notice">${escapeHtml(done)}</p>` : ""}
${form("profile", `<label for="d">Display name</label><input id="d" type="text" name="displayname" value="${escapeHtml(user.displayname ?? "")}"><button type="submit">Save</button>`)}</div>`);
      if (action === "org.matrix.cross_signing_reset")
        sections.push(`<div class="card"><h2>Reset your identity</h2><p>Your app asks to replace your cross-signing keys. Do this only if you lost access to your other devices and your recovery key. Other people will see that your identity changed, and you will have to verify your devices again.</p>
${form("cross_signing_reset", `<button class="primary" type="submit">Allow the reset</button>`)}</div>`);
      const list = devices
        .sort((a, b) => (b.last_seen_ts ?? 0) - (a.last_seen_ts ?? 0))
        .map((d) => {
          const seen = d.last_seen_ts ? new Date(d.last_seen_ts).toISOString().slice(0, 16).replace("T", " ") : "never";
          const focus = d.device_id === focusDevice ? ' class="focus"' : "";
          return `<li${focus}><div><b>${escapeHtml(d.display_name ?? d.device_id)}</b><div class="muted"><code>${escapeHtml(d.device_id)}</code> · last seen ${escapeHtml(seen)}${
            d.last_seen_ip ? ` · ${escapeHtml(d.last_seen_ip)}` : ""
          }</div></div>${form("delete_device", `<input type="hidden" name="device_id" value="${escapeHtml(d.device_id)}"><button class="danger" type="submit">Sign out</button>`)}</li>`;
        })
        .join("");
      sections.push(
        `<div class="card"><h2>Devices</h2>${list ? `<ul class="devices">${list}</ul>` : '<p class="muted">No devices are signed in.</p>'}</div>`,
      );
      if (hs.userAuth.passwordLoginEnabled && user.password_hash)
        sections.push(
          `<div class="card"><h2>Change password</h2>${form(
            "password",
            `<label for="c">Current password</label><input id="c" type="password" name="current" autocomplete="current-password" required>
<label for="n">New password</label><input id="n" type="password" name="new" autocomplete="new-password" required><button type="submit">Change password</button>`,
          )}</div>`,
        );
      sections.push(
        action === "org.matrix.account_deactivate"
          ? `<div class="card"><h2>Deactivate your account</h2><p>This cannot be undone. You leave every room, all devices are signed out, and nobody can use the username <b>${escapeHtml(userId)}</b> again.</p>
${form("deactivate", `<label for="x">Type your user ID to confirm</label><input id="x" type="text" name="confirm" autocomplete="off" required><button class="danger" type="submit">Deactivate account</button>`)}</div>`
          : `<p class="muted"><a href="${escapeHtml(`${self}?action=org.matrix.account_deactivate`)}">Deactivate account…</a></p>`,
      );
      sections.push(
        `<form method="post" action="${escapeHtml(pageUrl(hs, "/logout"))}">${csrfField(web)}<input type="hidden" name="next" value="${P}/account"><button type="submit">Sign out of this page</button></form>`,
      );
      return page(hs, "Your account", sections.join("\n"), { cookie: who.cookie });
    }),
  );

  r.post(
    `${P}/account`,
    pageRoute(async (ctx) => {
      const hs = ctx.hs;
      const form = await readForm(ctx);
      const who = await loggedIn(ctx, `${P}/account`);
      if (who instanceof Response) return who;
      checkCsrf(ctx, who.web, form);
      const { userId } = who;
      const back = (done: string) => redirect(`${pageUrl(hs, "/account")}?done=${done}`);
      switch (form.get("op")) {
        case "profile": {
          const name = (form.get("displayname") ?? "").trim().slice(0, 256);
          await setProfileField(hs, userId, "displayname", name || null);
          return back("profile");
        }
        case "delete_device": {
          const deviceId = form.get("device_id") ?? "";
          const device = await hs.db.findOne("devices", [
            { field: "user_id", value: userId },
            { field: "device_id", value: deviceId },
          ]);
          if (device) await hs.auth.deleteDevice(userId, deviceId);
          return back("device_deleted");
        }
        case "cross_signing_reset":
          await allowCrossSigningReset(hs, userId);
          await hs.audit.record({
            action: "admin_action",
            actor: userId,
            target: userId,
            ip: ctx.ip,
            details: { cross_signing_reset_allowed: true },
          });
          return back("reset_allowed");
        case "password": {
          await hs.rateLimits.check("login", ctx.ip ?? "unknown");
          await checkPasswordLogin(hs, userId, form.get("current") ?? "", { ip: ctx.ip, userAgent: ctx.request.headers.get("user-agent") });
          const password = form.get("new") ?? "";
          const problem = await hs.userAuth.validatePassword(password);
          if (problem || !password) throw new MatrixError(400, "M_WEAK_PASSWORD", problem ?? "Choose a password");
          await hs.db.update("users", [{ field: "user_id", value: userId }], { password_hash: await hs.userAuth.hashPassword(password) });
          await hs.audit.record({ action: "password_change", actor: userId, ip: ctx.ip, details: { web: true } });
          return back("password");
        }
        case "deactivate": {
          if ((form.get("confirm") ?? "").trim() !== userId) throw errors.invalidParam("The user ID you typed does not match");
          await hs.admin.deactivateUser(userId);
          await hs.audit.record({ action: "deactivate", actor: userId, target: userId, ip: ctx.ip, details: { web: true } });
          await setWebUser(hs, who.web, undefined);
          return page(
            hs,
            "Account deactivated",
            `<div class="card"><h1>Account deactivated</h1><p>${escapeHtml(userId)} is deactivated.</p></div>`,
          );
        }
        default:
          throw errors.invalidParam("Unknown action");
      }
    }),
  );
}
