import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "tsdown";

// In the workspace, npm hoists zod to the repository's node_modules.
const zodDir = dirname(createRequire(import.meta.url).resolve("zod/package.json"));

// Builds the published package into dist/: one .js and one .d.ts per source file (unbundled),
// because Node does not strip types from files inside node_modules. Development and the
// examples still run the TypeScript sources directly.
export default defineConfig({
  // The audit bot is its own entry (matrix-nodejs-homeserver/auditbot): the main one must not load
  // its native crypto module.
  entry: ["src/index.ts", "src/auditbot/index.ts"],
  unbundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  dts: true,
  outDir: "dist",
  clean: true,
  fixedExtension: false,
  // zod is bundled, so the published package has no runtime dependencies.
  deps: { alwaysBundle: ["zod"] },
  // zod's MIT license has to travel with the bundled copy.
  copy: [{ from: join(zodDir, "LICENSE"), to: "dist/vendor/zod" }],
  // Bundled dependencies keep their module structure (unbundle) under vendor/ rather than
  // dist/node_modules/, which npm and other tools may treat as installed dependencies.
  outputOptions: {
    entryFileNames: (chunk) => {
      const name = chunk.name.replace(/^node_modules\//, "vendor/");
      return name.endsWith(".d") ? `${name}.ts` : `${name}.js`;
    },
  },
});
