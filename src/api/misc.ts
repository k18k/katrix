import { errors } from "#core/errors.ts";
import { signJson } from "#core/crypto.ts";
import { SUPPORTED_ROOM_VERSIONS } from "#core/events.ts";
import type { Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { canonicalJsonResponse } from "#http/handler.ts";
import { wellKnown } from "#api/account.ts";

export const SPEC_VERSIONS = [
  "r0.0.1",
  "r0.1.0",
  "r0.2.0",
  "r0.3.0",
  "r0.4.0",
  "r0.5.0",
  "r0.6.0",
  "r0.6.1",
  "v1.1",
  "v1.2",
  "v1.3",
  "v1.4",
  "v1.5",
  "v1.6",
  "v1.7",
  "v1.8",
  "v1.9",
  "v1.10",
  "v1.11",
];

export function registerMiscRoutes(r: Router): void {
  r.get(
    "/_matrix/client/versions",
    procedure({
      handler: () => ({
        versions: SPEC_VERSIONS,
        unstable_features: {
          "org.matrix.simplified_msc3575": true,
          "org.matrix.msc3916.stable": true,
          "org.matrix.msc4140": true,
          "org.matrix.msc4143": true,
          "org.matrix.msc4222": true,
          "org.matrix.msc4306": true,
        },
      }),
    }),
  );

  r.get(
    "/.well-known/matrix/client",
    procedure({
      handler: (ctx) => {
        const wk = wellKnown(ctx.hs);
        if (!wk) throw errors.notFound("No well-known configured");
        return wk;
      },
    }),
  );

  r.get(
    "/.well-known/matrix/server",
    procedure({
      handler: (ctx) => {
        if (!ctx.hs.config.federationAddress) throw errors.notFound("No delegation configured");
        return { "m.server": ctx.hs.config.federationAddress };
      },
    }),
  );

  r.get(
    "/.well-known/matrix/support",
    procedure({
      handler: (ctx) => {
        if (!ctx.hs.config.support) throw errors.notFound("No support information configured");
        return ctx.hs.config.support;
      },
    }),
  );

  r.client(
    "GET",
    "/capabilities",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const available: Record<string, string> = {};
        for (const v of SUPPORTED_ROOM_VERSIONS) available[v] = /^\d+$/.test(v) ? "stable" : "unstable";
        return {
          capabilities: {
            "m.change_password": { enabled: !ctx.hs.oauth && ctx.hs.userAuth.passwordLoginEnabled },
            "m.room_versions": { default: ctx.hs.config.defaultRoomVersion, available },
            "m.set_displayname": { enabled: true },
            "m.set_avatar_url": { enabled: true },
            "m.profile_fields": { enabled: true },
            "m.3pid_changes": { enabled: ctx.hs.threepids.enabled && !ctx.hs.oauth },
            "m.get_login_token": { enabled: ctx.hs.config.loginViaExistingSession && !ctx.hs.oauth },
          },
        };
      },
    }),
  );

  // Server signing keys. Federation is not implemented, but the key endpoint is cheap and useful.
  r.get(
    "/_matrix/key/v2/server",
    procedure({
      handler: (ctx) => {
        const hs = ctx.hs;
        const key = hs.signingKey;
        return canonicalJsonResponse(
          signJson(
            {
              server_name: hs.serverName,
              valid_until_ts: Date.now() + 24 * 3600_000,
              verify_keys: { [`ed25519:${key.keyId}`]: { key: key.publicKeyBase64 } },
              old_verify_keys: {},
            },
            hs.serverName,
            key,
          ),
        );
      },
    }),
  );

  r.get(
    "/_matrix/federation/v1/version",
    procedure({
      handler: (ctx) => {
        if (!ctx.hs.federation.enabled) throw errors.unrecognized("Federation is disabled");
        return { server: { name: "matrix-nodejs-homeserver", version: "0.1.0" } };
      },
    }),
  );
}
