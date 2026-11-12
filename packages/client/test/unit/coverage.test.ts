import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The client covers the whole Client-Server API: every endpoint of the shared map
// (packages/shared/src/api/endpoints.ts, every stable endpoint of the spec but the deprecated ones)
// is called somewhere in the client's sources.

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const MAP = fileURLToPath(new URL("../../../shared/src/api/endpoints.ts", import.meta.url));

function sources(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? readFileSync(join(dir, e.name), "utf8") : ""))
    .join("\n");
}

test("every endpoint of the Client-Server API map is used by the client", () => {
  const keys = [...readFileSync(MAP, "utf8").matchAll(/^ {2}"([A-Z]+ [^"]+)":/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 150, `the map has ${keys.length} endpoints`);
  const code = sources(SRC);
  assert.deepEqual(
    keys.filter((k) => !code.includes(`"${k}"`)),
    [],
  );
});
