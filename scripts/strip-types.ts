// Publishing helper. Node refuses to strip TypeScript types for files inside
// node_modules, so `npm pack`/`npm publish` writes a .js sibling next to every
// .ts file using Node's own `stripTypeScriptTypes` (no compiler, no dist folder).
// `postpack` removes them again. Usage: node scripts/strip-types.ts [--clean]
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

const root = new URL("../src/", import.meta.url).pathname;
const clean = process.argv.includes("--clean");

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

let count = 0;
for await (const file of files(root)) {
  const target = file.replace(/\.ts$/, ".js");
  if (clean) {
    await rm(target, { force: true });
  } else {
    const code = stripTypeScriptTypes(await readFile(file, "utf8"), { mode: "strip" });
    // Relative imports point at .ts files; the published runtime files are .js.
    await writeFile(target, code.replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2").replace(/(import\(\s*["']\.{1,2}\/[^"']+)\.ts(["']\s*\))/g, "$1.js$2"));
  }
  count++;
}
console.log(`${clean ? "Removed" : "Wrote"} ${count} runtime files`);
