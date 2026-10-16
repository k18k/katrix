import { MatrixError, errors } from "../core/errors.ts";
import { canonicalAddress, isMedium, type ThreepidPurpose } from "../core/threepid.ts";
import type { RequestContext, Router } from "../http/router.ts";
import { requireUia } from "./uia.ts";

// Third-party identifier management (spec "Adding Account Administrative Contact Information").

function notDelegated(ctx: RequestContext): void {
  // With delegated OAuth, the authorization server manages contact information.
  if (ctx.hs.oauth) throw errors.unrecognized("Managed by the OAuth provider");
}

export function registerThreepidRoutes(r: Router): void {
  const requestToken = (purpose: ThreepidPurpose, medium: "email" | "msisdn") => async (ctx: RequestContext) => {
    notDelegated(ctx);
    await ctx.rateLimit(purpose === "register" ? "register" : "login");
    return ctx.hs.threepids.requestToken(purpose, medium, await ctx.json());
  };
  for (const medium of ["email", "msisdn"] as const) {
    r.client("POST", `/register/${medium}/requestToken`, requestToken("register", medium));
    r.client("POST", `/account/password/${medium}/requestToken`, requestToken("password_reset", medium));
    r.client("POST", `/account/3pid/${medium}/requestToken`, requestToken("add_threepid", medium));
  }

  // The link in validation emails (GET), or a code typed into the client (POST to `submit_url`).
  const submitPath = "/_matrix/client/unstable/threepid/submit_token";
  r.get(submitPath, async (ctx) => {
    const q = ctx.query;
    let nextLink: string | null = null;
    let message = "Your address has been validated. You can return to your Matrix client.";
    let status = 200;
    try {
      nextLink = await ctx.hs.threepids.submitToken(q.get("sid") ?? "", q.get("client_secret") ?? "", q.get("token") ?? "");
    } catch (err) {
      message = err instanceof MatrixError ? `Validation failed: ${err.message}.` : "Validation failed.";
      status = 400;
    }
    if (nextLink && status === 200) return Response.redirect(nextLink, 302);
    return new Response(`<!doctype html><meta charset="utf-8"><title>${ctx.hs.serverName}</title><p>${message}</p>`, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
  r.post(submitPath, async (ctx) => {
    const body = await ctx.json();
    if (typeof body.sid !== "string" || typeof body.client_secret !== "string" || typeof body.token !== "string") {
      throw errors.missingParam("sid, client_secret and token are required");
    }
    await ctx.hs.threepids.submitToken(body.sid, body.client_secret, body.token);
    return { success: true };
  });

  r.client("GET", "/account/3pid", async (ctx) => {
    const s = await ctx.auth();
    return { threepids: await ctx.hs.threepids.list(s.userId) };
  });

  r.client("POST", "/account/3pid/add", async (ctx) => {
    notDelegated(ctx);
    const s = await ctx.auth();
    const body = await ctx.json();
    await requireUia(ctx.hs, body, [["m.login.password"]], s.userId);
    const validated = await ctx.hs.threepids.validated({ sid: body.sid, client_secret: body.client_secret });
    if (!validated) throw new MatrixError(400, "M_THREEPID_AUTH_FAILED", "The address has not been validated");
    await ctx.hs.threepids.add(s.userId, validated);
    return {};
  });

  r.client("POST", "/account/3pid/bind", async (ctx) => {
    const s = await ctx.auth();
    const body = await ctx.json();
    for (const k of ["client_secret", "id_access_token", "id_server", "sid"]) {
      if (typeof body[k] !== "string") throw errors.missingParam(`Missing ${k}`);
    }
    const res = await ctx.hs.identityServers.bind(body.id_server, body.id_access_token, body.sid, body.client_secret, s.userId);
    // Remember the binding so that it can be removed when the address or account goes away.
    if (res && isMedium(res.medium) && typeof res.address === "string") {
      await ctx.hs.db.upsert("threepid_bindings", {
        user_id: s.userId,
        medium: res.medium,
        address: res.address,
        id_server: body.id_server,
      });
    }
    return {};
  });

  const parseThreepid = (body: Record<string, any>) => {
    if (!isMedium(body.medium)) throw errors.invalidParam("Unsupported medium");
    const address = typeof body.address === "string" ? canonicalAddress(body.medium, body.address) : null;
    if (!address) throw errors.invalidParam("Invalid address");
    if (body.id_server !== undefined && typeof body.id_server !== "string") throw errors.invalidParam("id_server must be a string");
    return { medium: body.medium, address, idServer: body.id_server as string | undefined };
  };

  r.client("POST", "/account/3pid/delete", async (ctx) => {
    notDelegated(ctx);
    const s = await ctx.auth();
    const { medium, address, idServer } = parseThreepid(await ctx.json());
    const result = await ctx.hs.threepids.unbindAll(s.userId, medium, address, idServer);
    await ctx.hs.threepids.remove(s.userId, medium, address);
    return { id_server_unbind_result: result };
  });

  r.client("POST", "/account/3pid/unbind", async (ctx) => {
    const s = await ctx.auth();
    const { medium, address, idServer } = parseThreepid(await ctx.json());
    return { id_server_unbind_result: await ctx.hs.threepids.unbindAll(s.userId, medium, address, idServer) };
  });

  // Deprecated: adding an address validated by an identity server is not supported.
  r.client("POST", "/account/3pid", async (ctx) => {
    await ctx.auth();
    throw errors.threepidDenied();
  });
}
