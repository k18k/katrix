import { defineConfig } from "tsdown";

// The published @katrix/server: one .js, .d.ts and source map per source module in dist/
// (unbundled: Node does not strip types inside node_modules, and the module structure stays as
// in src/ for stack traces and debugging). Development, tests and the examples run src/ directly.
export default defineConfig({
  // The audit bot is its own entry (@katrix/server/auditbot): the main one must not load its
  // native crypto module.
  entry: ["src/index.ts", "src/auditbot/index.ts"],
  unbundle: true,
  format: "esm",
  platform: "node",
  // The oldest Node.js the package supports (engines).
  target: "node22",
  outDir: "dist",
  clean: true,
  fixedExtension: false,
  sourcemap: true,
  // Declarations through tsgo (TypeScript 7), from the sources only.
  tsconfig: "tsconfig.build.json",
  dts: { sourcemap: true },
  // The sources import each other as #…/….ts (package.json "imports"); "matrix-src" maps them to
  // src/, and the build writes them as relative imports.
  inputOptions: { resolve: { conditionNames: ["matrix-src", "import", "node", "default"] } },
  // Besides Node.js built-ins, the output may import only the audit bot's optional peer: the
  // package has no runtime dependencies.
  deps: { onlyImport: ["@matrix-org/matrix-sdk-crypto-nodejs"] },
  // https://github.com/k18k/katrix/issues/111: with the tsc build, the #-imports stayed in
  // dist/*.d.ts and attw failed on them under node10 resolution, so a script had to filter its
  // results. This build writes those imports as relative paths, and attw runs here unfiltered.
  // The package must work for its consumers: exports and types resolve, ESM only.
  publint: { level: "error" },
  attw: { profile: "esm-only", level: "error" },
});
