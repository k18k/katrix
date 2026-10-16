import { readFileSync } from "node:fs";
import { errors } from "#core/errors.ts";
import { signJson } from "#core/crypto.ts";
import { SUPPORTED_ROOM_VERSIONS } from "#core/events.ts";
import type { Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { canonicalJsonResponse } from "#http/handler.ts";
import { wellKnown } from "#api/account.ts";
import { M, UNSTABLE } from "#core/m.ts";

// https://github.com/k18k/matrix-nodejs-homeserver/issues/16: the federation version endpoint
// reported a hardcoded "0.1.0" whatever release was installed. The version now comes from the
// package's own package.json, which sits two levels up from both src/api/ and dist/api/.
const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };

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
          [UNSTABLE.ORG.MATRIX.SIMPLIFIED_MSC3575]: true,
          [UNSTABLE.ORG.MATRIX.MSC3916.STABLE]: true,
          [UNSTABLE.ORG.MATRIX.MSC4140._]: true,
          [UNSTABLE.ORG.MATRIX.MSC4143._]: true,
          [UNSTABLE.ORG.MATRIX.MSC4222._]: true,
          [UNSTABLE.ORG.MATRIX.MSC4306]: true,
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
        return { [M.SERVER]: ctx.hs.config.federationAddress };
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
            [M.CHANGE_PASSWORD]: { enabled: !ctx.hs.oauth && ctx.hs.userAuth.passwordLoginEnabled },
            [M.ROOM_VERSIONS]: { default: ctx.hs.config.defaultRoomVersion, available },
            [M.SET_DISPLAYNAME]: { enabled: true },
            [M.SET_AVATAR_URL]: { enabled: true },
            [M.PROFILE_FIELDS]: { enabled: true },
            [M.THREEPID_CHANGES]: { enabled: ctx.hs.threepids.enabled && !ctx.hs.oauth },
            [M.GET_LOGIN_TOKEN]: { enabled: ctx.hs.config.loginViaExistingSession && !ctx.hs.oauth },
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
        return { server: { name: PACKAGE.name, version: PACKAGE.version } };
      },
    }),
  );
}
