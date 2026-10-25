import { test } from "node:test";
import assert from "node:assert/strict";
import { globMatch, globSearchWords } from "#core/glob.ts";

test("globs match * and ?", () => {
  assert.equal(globMatch("*.example.com", "matrix.example.com"), true);
  assert.equal(globMatch("*.example.com", "example.org"), false);
  assert.equal(globMatch("h?", "hs"), true);
  assert.equal(globMatch("EXAMPLE.*", "example.com", { caseInsensitive: true }), true);
});

// https://github.com/k18k/katrix/issues/2: patterns come from room state, so
// matching must stay linear however the pattern is built.
test("matching is linear for patterns that backtrack in a regex", () => {
  const start = performance.now();
  assert.equal(globMatch("*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(5000)), false);
  assert.ok(performance.now() - start < 500);
});

// https://github.com/k18k/katrix/issues/118: a word boundary is any character outside
// [A-Za-z0-9_] (spec, event_match on content.body).
test("content.body word boundaries are the spec's: any character outside [A-Za-z0-9_]", () => {
  assert.equal(globSearchWords("アリス", "アリスさん、こんにちは"), true);
  assert.equal(globSearchWords("caf", "un café"), true);
  assert.equal(globSearchWords("ex*ple", "An exciting triple-whammy"), true);
  assert.equal(globSearchWords("alice", "malice"), false);
  assert.equal(globSearchWords("alice", "alice_bob"), false);
  assert.equal(globSearchWords("alice", "@Alice: hi"), true);
});
