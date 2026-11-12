import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeysClaimRequest, KeysQueryRequest, LoginRequest, MembershipRequest, RegisterRequest } from "@katrix/shared";
import type { v } from "#core/vpm.ts";
import { loginBody, registerBody } from "#api/account.ts";
import { membershipBody } from "#api/membership.ts";
import { keysClaimBody, keysQueryBody } from "#api/user.ts";

// The server's body schemas against the request types of the shared endpoint map
// (@katrix/shared, which the client builds its requests from): every request the spec allows,
// the server must accept. Checked by the compiler (the assignments below) and at run time.

// A loose body schema takes any other key too (its input type has a string index signature, which
// interfaces like the shared request types never match): compare the known keys only.
type KnownKeys<T> = { [K in keyof T as string extends K ? never : K]: T[K] };
type Accepts<Schema, Spec> = [Spec] extends [KnownKeys<v.input<Schema>>] ? true : false;
const accepted: Array<true> = [
  true satisfies Accepts<typeof loginBody, LoginRequest>,
  true satisfies Accepts<typeof registerBody, RegisterRequest>,
  true satisfies Accepts<typeof membershipBody, MembershipRequest>,
  true satisfies Accepts<typeof keysQueryBody, KeysQueryRequest>,
  true satisfies Accepts<typeof keysClaimBody, KeysClaimRequest>,
];

test("the server's body schemas accept the shared request types", () => {
  assert.equal(accepted.length, 5);
  const samples: Array<[v.Schema, unknown]> = [
    [
      loginBody,
      {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "alice" },
        password: "p",
        refresh_token: true,
      } satisfies LoginRequest,
    ],
    [loginBody, { type: "m.login.token", token: "t", device_id: "D", initial_device_display_name: "Phone" } satisfies LoginRequest],
    [
      registerBody,
      { username: "alice", password: "p", auth: { type: "m.login.dummy", session: "s" }, inhibit_login: false } satisfies RegisterRequest,
    ],
    [membershipBody, { user_id: "@bob:x", reason: "hi" } satisfies MembershipRequest],
    [keysQueryBody, { device_keys: { "@bob:x": [] }, timeout: 10_000 } satisfies KeysQueryRequest],
    [keysClaimBody, { one_time_keys: { "@bob:x": { DEV: "signed_curve25519" } }, timeout: 10_000 } satisfies KeysClaimRequest],
  ];
  for (const [schema, sample] of samples) {
    const parsed = schema.safeParse(sample);
    assert.ok(parsed.success, JSON.stringify(sample));
  }
});
