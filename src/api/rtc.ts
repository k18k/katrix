import { createHmac } from "node:crypto";
import { errors } from "../core/errors.ts";
import type { RequestContext, Router } from "../http/router.ts";
import { z } from "zod";
import { body, fail } from "../http/input.ts";

export interface TurnOptions {
  uris: string[];
  /** coturn `static-auth-secret`: time-limited credentials are derived from it. */
  sharedSecret?: string;
  /** Static credentials, when not using a shared secret. */
  username?: string;
  password?: string;
  /** Credential lifetime in seconds. Default: 86400. */
  ttlSeconds?: number;
  /** Whether guests may obtain credentials. Default: false. */
  allowGuests?: boolean;
}

export interface RtcOptions {
  /** VoIP TURN servers. */
  turn?: TurnOptions;
  /**
   * MatrixRTC transports (MSC4143), e.g. `[{ type: "livekit", livekit_service_url: "https://lk-jwt.example.com" }]`.
   * Advertised at /rtc/transports and in /.well-known/matrix/client.
   */
  transports?: Record<string, unknown>[];
}

export function registerRtcRoutes(r: Router): void {
  r.client("GET", "/voip/turnServer", async (ctx) => {
    const s = await ctx.auth();
    const turn = ctx.hs.config.rtc.turn;
    if (!turn || !turn.uris.length) return {};
    if (s.isGuest && !turn.allowGuests) throw errors.forbidden("Guests may not use TURN");
    const ttl = turn.ttlSeconds ?? 86400;
    if (turn.sharedSecret) {
      // coturn REST API: username = "<expiry>:<user>", password = base64(HMAC-SHA1(secret, username)).
      const username = `${Math.floor(Date.now() / 1000) + ttl}:${s.userId}`;
      const password = createHmac("sha1", turn.sharedSecret).update(username).digest("base64");
      return { username, password, uris: turn.uris, ttl };
    }
    return { username: turn.username ?? "", password: turn.password ?? "", uris: turn.uris, ttl };
  });

  const transports = async (ctx: RequestContext) => {
    await ctx.auth();
    return { rtc_transports: ctx.hs.config.rtc.transports ?? [] };
  };
  r.client("GET", "/rtc/transports", transports, ["v1"]);
  r.get("/_matrix/client/unstable/org.matrix.msc4143/rtc/transports", transports);

  // --- Delayed events (MSC4140) ---------------------------------------------------
  const base = "/_matrix/client/unstable/org.matrix.msc4140/delayed_events";
  r.get(base, async (ctx) => {
    const s = await ctx.auth();
    return { delayed_events: await ctx.hs.delayedEvents.list(s.userId) };
  });
  r.post(`${base}/:delayId`, { input: body({ action: z.string(fail("M_MISSING_PARAM", "Missing action")) }) }, async (ctx) => {
    const s = await ctx.auth();
    await ctx.hs.delayedEvents.update(s.userId, ctx.params.delayId, ctx.input.action);
    return {};
  });
  r.post(`${base}/:delayId/:action`, async (ctx) => {
    const s = await ctx.auth();
    await ctx.hs.delayedEvents.update(s.userId, ctx.params.delayId, ctx.params.action);
    return {};
  });
}
