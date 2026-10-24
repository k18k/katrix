// Are the types and exports of the packed package right for its consumers? Runs
// arethetypeswrong (attw) and fails on any problem that a consumer of this ESM-only package
// (Node.js >= 22 or a bundler) would meet.
//
// Fix (https://github.com/k18k/katrix/issues/111): `attw --profile esm-only`
// exited 1 although every problem it printed was "ignored per resolution": the `#`-imports in
// dist/*.d.ts give InternalResolutionErrors under node10 resolution (which knows no package
// `imports`), and the profile does not filter those per-file problems out. So the problems are
// filtered here by the resolution they occur under, and the rest still fail the check.
import { execFileSync } from "node:child_process";

const IGNORED = new Set(["node10", "node16-cjs"]);

let out: string;
try {
  out = execFileSync("npx", ["attw", "--pack", ".", "--profile", "esm-only", "--format", "json"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
} catch (e) {
  // attw exits 1 when it found problems; its JSON is on stdout either way.
  out = (e as { stdout?: string }).stdout ?? "";
  if (!out) throw e;
}
const result = JSON.parse(out) as { analysis?: { problems?: Array<Record<string, unknown>> }; problems?: Array<Record<string, unknown>> };
const problems = result.analysis?.problems ?? result.problems ?? [];
const relevant = problems.filter((p) => !IGNORED.has(String(p.resolutionKind ?? p.resolutionOption)));
if (relevant.length > 0) {
  for (const p of relevant)
    console.error(`${p.kind} (${p.resolutionKind ?? p.resolutionOption}): ${p.entrypoint ?? p.fileName ?? ""} ${p.moduleSpecifier ?? ""}`);
  process.exit(1);
}
console.log(`attw: no problems for ESM consumers (${problems.length} ignored under ${[...IGNORED].join(", ")})`);
