import { defineConfig } from "tsdown";

// Builds the published package into dist/: one .js and one .d.ts per source file (unbundled),
// because Node does not strip types from files inside node_modules. Development and the
// examples still run the TypeScript sources directly.
export default defineConfig({
  entry: ["src/index.ts"],
  unbundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  dts: true,
  outDir: "dist",
  clean: true,
  fixedExtension: false,
});
