// Summarise `go test -json` output from Complement into a Markdown report.
// Usage: node complement/summarize.ts results.json [passing-list.txt] [badge.json]
//   badge.json: a shields.io endpoint badge with the pass counts (for the README).
import { readFileSync, writeFileSync } from "node:fs";

const [, , input, passingOut, badgeOut] = process.argv;
const results = new Map<string, string>();
for (const line of readFileSync(input, "utf8").split("\n")) {
  if (!line.startsWith("{")) continue;
  let ev: { Action?: string; Test?: string; Package?: string };
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
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
  writeFileSync(
    passingOut,
    "# Complement tests (top-level and subtests) known to pass. CI fails if any of these regress.\n# Regenerate from a run with: node complement/summarize.ts results.json passing.txt\n" +
      all
        .filter(([, r]) => r === "pass")
        .map(([n]) => n)
        .sort()
        .join("\n") +
      "\n",
  );
}

if (badgeOut) {
  const ran = (list: [string, string][]) => list.length - count(list, "skip");
  const passed = count(top, "pass");
  const total = ran(top);
  const color = total === 0 ? "lightgrey" : passed === total ? "brightgreen" : passed / total >= 0.95 ? "yellow" : "red";
  const message = total === 0 ? "no result" : `${passed}/${total} tests · ${count(all, "pass")}/${ran(all)} with subtests`;
  writeFileSync(badgeOut, JSON.stringify({ schemaVersion: 1, label: "Complement", message, color }));
}
