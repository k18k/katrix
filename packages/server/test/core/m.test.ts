import { M, UNSTABLE } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";

test("identifiers follow their paths", () => {
  assert.equal(M.ROOM.MEMBER, "m.room.member");
  assert.equal(M.LOGIN.MSISDN, "m.login.msisdn");
  assert.equal(M.SPACE._, "m.space");
  assert.equal(M.SPACE.CHILD, "m.space.child");
  assert.equal(M.RULE.MASTER, ".m.rule.master");
  assert.equal(UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET, "org.matrix.cross_signing_reset");
});

test("M and UNSTABLE are frozen all the way down", () => {
  const frozen = (o: object): boolean => Object.isFrozen(o) && Object.values(o).every((v) => typeof v !== "object" || frozen(v));
  assert.ok(frozen(M));
  assert.ok(frozen(UNSTABLE));
  assert.throws(() => {
    (M.ROOM as any).MEMBER = "x";
  }, TypeError);
});

test("every value is an m./vendor identifier and none repeats", () => {
  const values: string[] = [];
  const walk = (o: object) => Object.values(o).forEach((v) => (typeof v === "string" ? values.push(v) : walk(v)));
  walk(M);
  assert.ok(values.every((v) => /^\.?m\./.test(v)));
  walk(UNSTABLE);
  assert.equal(new Set(values).size, values.length);
});
