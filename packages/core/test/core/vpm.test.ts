import { test } from "node:test";
import assert from "node:assert/strict";
import { v } from "#core/vpm.ts";

test("vpm: objects, issues with paths, transforms and refinements", () => {
  const User = v.object({
    name: v
      .string()
      .transform((s) => s.trim())
      .min(2),
    age: v.number().min(18),
    tags: v.array(v.string()),
    nick: v.string().optional(),
  });
  const bad = User.safeParse({ name: " A ", age: 16, tags: ["ok", 42] });
  assert.equal(bad.success, false);
  if (!bad.success)
    assert.deepEqual(
      bad.error.issues.map((i) => [i.path.join("."), i.code]),
      [
        ["name", "too_small"],
        ["age", "too_small"],
        ["tags.1", "invalid_type"],
      ],
    );
  // object drops unknown keys, looseObject keeps them, strictObject refuses them.
  assert.deepEqual(User.parse({ name: " Ana ", age: 20, tags: ["dev"], role: "admin" }), { name: "Ana", age: 20, tags: ["dev"] });
  assert.deepEqual(v.looseObject({ a: v.number() }).parse({ a: 1, b: 2 }), { a: 1, b: 2 });
  assert.throws(() => v.strictObject({ a: v.number() }).parse({ a: 1, b: 2 }), /Unrecognized keys: b/);
});

test("vpm: missing values, catch, nullable, enum, record, int, custom messages", () => {
  const missing = v.object({ id: v.string() }).safeParse({});
  assert.ok(!missing.success && missing.error.issues[0].input === undefined && missing.error.issues[0].code === "invalid_type");
  assert.equal(v.string().optional().catch(undefined).parse(5), undefined);
  assert.equal(v.string().nullable().parse(null), null);
  assert.equal(v.enum(["a", "b"]).safeParse("c").success, false);
  assert.deepEqual(v.record(v.string(), v.number()).parse({ x: 1 }), { x: 1 });
  assert.equal(v.number().int().safeParse(1.5).success, false);
  const custom = v.string({ error: (i) => (i.input === undefined ? "gone" : "wrong") });
  assert.deepEqual(
    [custom.safeParse(undefined), custom.safeParse(1)].map((r) => !r.success && r.error.issues[0].message),
    ["gone", "wrong"],
  );
});
