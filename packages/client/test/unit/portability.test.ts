import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The SDK's sources must run unchanged in Node.js, browsers and React Native (Hermes). The
// compiler already sees no DOM or Node.js typings (tsconfig.json); this also checks the code for
// globals and modules that exist only on some platforms, and that the only runtime dependencies
// are @noble/*.

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
// @katrix/shared is built into the client, so the same rules hold for it.
const SHARED = fileURLToPath(new URL("../../../shared/src/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** The code without comments and string literals, so documentation can name what code must not use. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bBuffer\b/, "Buffer (Node.js only)"],
  [/\bprocess\./, "process (Node.js only)"],
  [/\brequire\s*\(/, "require (CommonJS)"],
  [/\bTextDecoder\b/, "TextDecoder (missing on Hermes)"],
  [/\bTextEncoder\b/, "TextEncoder (use encodeUtf8 from @katrix/shared)"],
  [/\bWebAssembly\b/, "WebAssembly (missing on Hermes)"],
  [/\bsubtle\b/, "crypto.subtle (missing on Hermes)"],
  [/\bstructuredClone\b/, "structuredClone"],
  [/\bnew URL\b|\bURLSearchParams\b/, "URL/URLSearchParams (incomplete on React Native)"],
  [/\batob\b|\bbtoa\b/, "atob/btoa (use @katrix/shared base64)"],
  [/AbortSignal\.(timeout|any)\b/, "AbortSignal.timeout/any (missing on React Native)"],
  [/\b(window|document|localStorage|sessionStorage|navigator|indexedDB)\b/, "browser globals"],
  [/\bimport\s*\(/, "dynamic import (bundlers for React Native handle it poorly)"],
];

// Storage adapters for one platform (src/adapters: IndexedDB) are entry points of their own
// (@katrix/client/indexeddb), which apps import on that platform; the core never imports them.
const ADAPTERS = "adapters/";

test("the sources use no platform-specific globals or modules", () => {
  const problems: string[] = [];
  for (const file of [...files(SRC), ...files(SHARED)]) {
    const rel = file.startsWith(SHARED) ? `shared/${relative(SHARED, file)}` : relative(SRC, file);
    if (rel.startsWith(ADAPTERS)) continue;
    const source = readFileSync(file, "utf8");
    const c = code(source);
    for (const [re, what] of FORBIDDEN) {
      if (re.test(c)) problems.push(`${rel}: ${what}`);
    }
    // Platform globals are read in platform.ts only.
    if (rel !== "platform.ts" && /\bglobalThis\b/.test(c)) problems.push(`${rel}: globalThis outside platform.ts`);
    for (const m of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)) {
      const spec = m[1];
      if (spec.startsWith(".")) continue;
      if (!/^@noble\/(curves|hashes|ciphers)\//.test(spec) && !/^@katrix\/shared(\/types)?$/.test(spec))
        problems.push(`${rel}: imports ${spec} (only @noble/* and @katrix/shared are allowed)`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the core does not import the platform adapters", () => {
  for (const file of files(SRC)) {
    const rel = relative(SRC, file);
    if (rel.startsWith(ADAPTERS)) continue;
    const source = readFileSync(file, "utf8");
    assert.ok(!/from\s+"(\.\.?\/)+adapters\//.test(source), `${rel} imports an adapter`);
  }
});

test("no top-level await in the sources (Metro and Hermes do not support it)", () => {
  for (const file of [...files(SRC), ...files(SHARED)]) {
    const c = code(readFileSync(file, "utf8"));
    // A top-level statement starting with await (indentation 0).
    assert.ok(!/^await\b/m.test(c), `${relative(SRC, file)} has top-level await`);
  }
});

test("package.json: the only runtime dependencies are @noble/* (@katrix/shared is built in)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ["@noble/ciphers", "@noble/curves", "@noble/hashes"]);
  assert.equal(pkg.peerDependencies, undefined);
});
