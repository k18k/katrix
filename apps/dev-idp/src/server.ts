// A development identity provider: Better Auth as an OpenID Connect provider, where signing in is
// a click on one of a few made-up users. The homeserver of apps/public uses it locally in place of
// GitHub, so the whole OAuth login can be tried without a GitHub app or real accounts.
//
// Never expose it: anyone who reaches it can sign in as any of its users. Everything lives in
// memory and is created again at every start.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";

export interface DevIdpOptions {
  /** The URL browsers and the homeserver both reach it at. Default: http://{host}:{port}. */
  baseUrl?: string;
  /** Where the homeserver receives the login: its `/_matrix/client/v3/login/sso/callback/{id}`. */
  redirectUris: string[];
  clientId?: string;
  clientSecret?: string;
  port?: number;
  host?: string;
}

/** The users to pick from. Their localpart on the homeserver comes from the email. */
export const DEV_USERS = [
  { email: "alice@dev.localhost", name: "Alice" },
  { email: "bob@dev.localhost", name: "Bob" },
  { email: "carol@dev.localhost", name: "Carol" },
];

// One password for everyone: the picker signs in with it, nobody types it.
const PASSWORD = "dev-idp-password";

// The memory adapter needs every table up front.
const TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "jwks",
  "oauthClient",
  "oauthClientAssertion",
  "oauthClientResource",
  "oauthResource",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
];

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function pickerPage(query: string): string {
  const buttons = DEV_USERS.map(
    (u) => `<form method="post" action="/pick"><input type="hidden" name="email" value="${escape(u.email)}">
<input type="hidden" name="oauth_query" value="${escape(query)}"><button type="submit">${escape(u.name)}<small>${escape(u.email)}</small></button></form>`,
  ).join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev login</title><style>
:root{color-scheme:light dark}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:24rem;margin:3rem auto;padding:0 1rem}h1{font-size:1.3rem}p{opacity:.75}
button{display:block;width:100%;margin:.5rem 0;padding:.8rem 1rem;border-radius:10px;border:1px solid #8885;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
button:hover{border-color:#2fb37f}small{display:block;opacity:.7;font-size:.85rem}</style>
<main><h1>Dev login</h1><p>Local development only. Pick who you are:</p>${buttons}</main></html>`;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

export async function startDevIdp(options: DevIdpOptions) {
  // Listen first, so that a random port can be part of the base URL.
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async (_req, res) => {
    res.writeHead(503);
    res.end();
  };
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal error");
    });
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = (options.baseUrl ?? `http://${host}:${port}`).replace(/\/$/, "");

  const db = Object.fromEntries(TABLES.map((t) => [t, [] as unknown[]]));
  const auth = betterAuth({
    baseURL: baseUrl,
    secret: randomBytes(32).toString("hex"),
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    disabledPaths: ["/token"],
    telemetry: { enabled: false },
    logger: { disabled: true },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        // The one client gets known credentials, so the homeserver can be configured with them.
        generateClientId: () => options.clientId ?? "matrix-dev",
        generateClientSecret: () => options.clientSecret ?? "matrix-dev-secret",
        silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
      }),
    ],
  });

  let firstCookie = "";
  for (const user of DEV_USERS) {
    const res = await auth.api.signUpEmail({ body: { ...user, password: PASSWORD }, returnHeaders: true });
    firstCookie ||= res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }
  // Creating a client needs a signed-in user.
  const client = await auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie: firstCookie }),
    body: { redirect_uris: options.redirectUris, skip_consent: true, client_name: "Matrix homeserver (dev)" },
  });

  const betterAuthHandler = toNodeHandler(auth);
  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", baseUrl);
    if (req.method === "GET" && url.pathname === "/sign-in") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(pickerPage(url.search.slice(1)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/pick") {
      const form = await readForm(req);
      const email = form.get("email") ?? "";
      if (!DEV_USERS.some((u) => u.email === email)) {
        res.writeHead(400);
        res.end("Unknown user");
        return;
      }
      // Signing in with the signed query of the login redirect continues the authorization. It
      // goes through Better Auth's HTTP handler, which the continuation needs (a direct
      // `auth.api` call has no request for it to work with).
      const query = form.get("oauth_query") || undefined;
      const signIn = await auth.handler(
        new Request(`${baseUrl}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseUrl, ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}) },
          body: JSON.stringify({ email, password: PASSWORD, ...(query ? { oauth_query: query } : {}) }),
        }),
      );
      const body = (await signIn.json().catch(() => ({}))) as { url?: string; redirect?: boolean };
      res.setHeader("set-cookie", signIn.headers.getSetCookie());
      res.writeHead(303, { location: signIn.headers.get("location") ?? body.url ?? "/" });
      res.end();
      return;
    }
    await betterAuthHandler(req, res);
  };

  return {
    server,
    port,
    baseUrl,
    issuer: `${baseUrl}/api/auth`,
    clientId: client.client_id,
    clientSecret: client.client_secret!,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
