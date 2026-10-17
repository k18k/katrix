import { createHmac } from "node:crypto";
import { errors } from "#core/errors.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { z } from "zod";
import { body, fail } from "#http/input.ts";

/** Credentials for `/voip/turnServer`. */
export interface TurnCredentials {
  username: string;
  password: string;
  uris: string[];
  ttl: number;
}

export interface TurnOptions {
  /** TURN URIs. Not needed with `credentials`, which returns its own. */
  uris?: string[];
  /** coturn `static-auth-secret`: time-limited credentials are derived from it. */
  sharedSecret?: string;
  /** Static credentials, when not using a shared secret. */
  username?: string;
  password?: string;
  /** Credential lifetime in seconds. Default: 86400. */
  ttlSeconds?: number;
  /** Whether guests may obtain credentials. Default: false. */
  allowGuests?: boolean;
  /** Credentials from a service, e.g. a managed TURN provider (see `cloudflareTurn`). */
  credentials?: (userId: string) => Promise<TurnCredentials>;
}

/**
 * Cloudflare's managed TURN service (Realtime TURN): credentials come from its API, so no TURN
 * server has to run, and no port has to be open, on the homeserver's host. `keyId` and `apiToken`
 * are the TURN key's ID and API token from the Cloudflare dashboard.
 *
 * Credentials are kept per user for half their lifetime (at most 10 000 users), so that clients
 * asking again do not each cost an API call.
 */
export function cloudflareTurn(opts: { keyId: string; apiToken: string; ttlSeconds?: number; fetch?: typeof fetch }): TurnOptions {
  const ttl = opts.ttlSeconds ?? 86400;
  const cache = new Map<string, { value: TurnCredentials; until: number }>();
  const doFetch = opts.fetch ?? fetch;
  return {
    ttlSeconds: ttl,
    async credentials(userId) {
      const hit = cache.get(userId);
      if (hit && hit.until > Date.now()) return hit.value;
      const res = await doFetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(opts.keyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiToken}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}`);
      const { iceServers } = (await res.json()) as { iceServers: { urls: string | string[]; username?: string; credential?: string }[] };
      const turn = iceServers.find((s) => s.username && s.credential);
      if (!turn) throw new Error("Cloudflare TURN returned no credentials");
      // Browsers block port 53, and a client without trickle ICE would wait for it to time out.
      const uris = (Array.isArray(turn.urls) ? turn.urls : [turn.urls]).filter((u) => /^turns?:/.test(u) && !/:53(\?|$)/.test(u));
      const value = { username: turn.username!, password: turn.credential!, uris, ttl };
      if (cache.size >= 10_000) cache.clear();
      cache.set(userId, { value, until: Date.now() + (ttl * 1000) / 2 });
      return value;
    },
  };
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
  r.client(
    "GET",
    "/voip/turnServer",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const turn = ctx.hs.config.rtc.turn;
        if (!turn || (!turn.credentials && !turn.uris?.length)) return {};
        if (s.isGuest && !turn.allowGuests) throw errors.forbidden("Guests may not use TURN");
        if (turn.credentials) return turn.credentials(s.userId);
        const uris = turn.uris!;
        const ttl = turn.ttlSeconds ?? 86400;
        if (turn.sharedSecret) {
          // coturn REST API: username = "<expiry>:<user>", password = base64(HMAC-SHA1(secret, username)).
          const username = `${Math.floor(Date.now() / 1000) + ttl}:${s.userId}`;
          const password = createHmac("sha1", turn.sharedSecret).update(username).digest("base64");
          return { username, password, uris, ttl };
        }
        return { username: turn.username ?? "", password: turn.password ?? "", uris, ttl };
      },
    }),
  );

  const transports = async (ctx: RequestContext) => {
    await ctx.auth();
    return { rtc_transports: ctx.hs.config.rtc.transports ?? [] };
  };
  r.client("GET", "/rtc/transports", procedure({ handler: transports }), ["v1"]);
  r.get("/_matrix/client/unstable/org.matrix.msc4143/rtc/transports", procedure({ handler: transports }));

  // --- Delayed events (MSC4140) ---------------------------------------------------
  const base = "/_matrix/client/unstable/org.matrix.msc4140/delayed_events";
  r.get(
    base,
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        return { delayed_events: await ctx.hs.delayedEvents.list(s.userId) };
      },
    }),
  );
  r.post(
    `${base}/:delayId`,
    procedure({
      auth: "user",
      input: body({ action: z.string(fail("M_MISSING_PARAM", "Missing action")) }),
      handler: async (ctx) => {
        const s = ctx.session;
        await ctx.hs.delayedEvents.update(s.userId, ctx.params.delayId, ctx.input.action);
        return {};
      },
    }),
  );
  r.post(
    `${base}/:delayId/:action`,
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        await ctx.hs.delayedEvents.update(s.userId, ctx.params.delayId, ctx.params.action);
        return {};
      },
    }),
  );
}
