// Summarise `go test -json` output from Complement into a Markdown report.
// Usage: node complement/summarize.ts results.json [passing-list.txt]
import { readFileSync, writeFileSync } from "node:fs";

const [, , input, passingOut] = process.argv;
const results = new Map<string, string>();
for (const line of readFileSync(input, "utf8").split("\n")) {
  if (!line.startsWith("{")) continue;
  let ev: { Action?: string; Test?: string; Package?: string };
  try { ev = JSON.parse(line); } catch { continue; }
  if (!ev.Test || !["pass", "fail", "skip"].includes(ev.Action ?? "")) continue;
  results.set(ev.Test, ev.Action!);
}

const top = [...results].filter(([name]) => !name.includes("/"));
const count = (list: [string, string][], a: string) => list.filter(([, r]) => r === a).length;
const all = [...results];

const lines = [
  "## Complement results",
  "",
  "| | Top-level tests | Including subtests |",
  "|---|---|---|",
  `| ✅ pass | ${count(top, "pass")} | ${count(all, "pass")} |`,
  `| ❌ fail | ${count(top, "fail")} | ${count(all, "fail")} |`,
  `| ⏭️ skip | ${count(top, "skip")} | ${count(all, "skip")} |`,
  "",
  "<details><summary>Failing top-level tests</summary>",
  "",
  ...top.filter(([, r]) => r === "fail").map(([n]) => `- ${n}`),
  "",
  "</details>",
];
console.log(lines.join("\n"));

if (passingOut) {
  writeFileSync(passingOut, "# Complement tests (top-level and subtests) known to pass. CI fails if any of these regress.\n# Regenerate from a run with: node complement/summarize.ts results.json passing.txt\n" + all.filter(([, r]) => r === "pass").map(([n]) => n).sort().join("\n") + "\n");
}
