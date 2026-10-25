import { defineConfig } from "tsdown";

// The published @katrix/client: one .js, .d.ts and source map per source module in dist/
// (unbundled, so apps and their bundlers, Metro for React Native among them, tree-shake and
// debug against the real module structure).
export default defineConfig({
  entry: ["src/index.ts"],
  unbundle: true,
  format: "esm",
  // No Node.js built-ins, no browser globals: the same build runs in Node.js, browsers and Hermes.
  platform: "neutral",
  // ES2022 output, so bundlers for older engines (Metro for Hermes) have little left to transform.
  target: "es2022",
  outDir: "dist",
  clean: true,
  fixedExtension: false,
  sourcemap: true,
  // Declarations through tsgo (TypeScript 7), from the sources only.
  tsconfig: "tsconfig.build.json",
  dts: { sourcemap: true },
  // The output may import nothing but @noble/* (the package's only dependencies).
  deps: { onlyImport: [/^@noble\//] },
  // The package must work for its consumers: exports and types resolve, ESM only.
  publint: { level: "error" },
  attw: { profile: "esm-only", level: "error" },
});
