import { test } from "node:test";
import assert from "node:assert/strict";
import { globMatch } from "#core/glob.ts";

test("globs match * and ?", () => {
  assert.equal(globMatch("*.example.com", "matrix.example.com"), true);
  assert.equal(globMatch("*.example.com", "example.org"), false);
  assert.equal(globMatch("h?", "hs"), true);
  assert.equal(globMatch("EXAMPLE.*", "example.com", { caseInsensitive: true }), true);
});

// https://github.com/k18k/matrix-nodejs-homeserver/issues/2: patterns come from room state, so
// matching must stay linear however the pattern is built.
test("matching is linear for patterns that backtrack in a regex", () => {
  const start = performance.now();
  assert.equal(globMatch("*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(5000)), false);
  assert.ok(performance.now() - start < 500);
});
