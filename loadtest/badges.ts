// Turn k6 summaries (`k6 run --summary-export`) into shields.io endpoint badges and a Markdown
// table. Usage: node loadtest/badges.ts <out-dir> <name>=<label>=<summary.json>...
//   writes <out-dir>/<name>.json per scenario and prints the table (for the job summary).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [outDir, ...specs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const ms = (v: number | undefined) => (v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const rows: string[] = [
  "| Scenario | req/s | send p50 / p95 | /sync p50 / p95 | delivery p50 / p95 | delivered | failed |",
  "|---|---|---|---|---|---|---|",
];

for (const spec of specs) {
  const [name, label, file] = spec.split("=");
  if (!existsSync(file)) {
    writeFileSync(`${outDir}/${name}.json`, JSON.stringify({ schemaVersion: 1, label, message: "no result", color: "lightgrey" }));
    rows.push(`| ${label} | no result | | | | | |`);
    continue;
  }
  const m = JSON.parse(readFileSync(file, "utf8")).metrics;
  const rps = m.http_reqs?.rate ?? 0;
  const failed = m.http_req_failed?.value ?? 1;
  const send = m["http_req_duration{name:send}"] ?? {};
  const sync = m["http_req_duration{name:sync}"] ?? {};
  const delivery = m.message_delivery ?? {};
  const delivered = m.messages_received?.count ?? 0;
  const p95 = delivered ? delivery["p(95)"] : undefined;
  // Colour by how long a message takes to reach the other members (p95).
  const color =
    failed > 0.01 || p95 === undefined ? "red" : p95 < 1000 ? "brightgreen" : p95 < 3000 ? "green" : p95 < 10_000 ? "yellow" : "orange";
  const message = `${Math.round(rps)} req/s · delivery p95 ${ms(p95)}${failed > 0.01 ? ` · ${(failed * 100).toFixed(1)}% failed` : ""}`;
  writeFileSync(`${outDir}/${name}.json`, JSON.stringify({ schemaVersion: 1, label, message, color }));
  rows.push(
    `| ${label} | ${Math.round(rps)} | ${ms(send.med)} / ${ms(send["p(95)"])} | ${ms(sync.med)} / ${ms(sync["p(95)"])} | ` +
      `${delivered ? `${ms(delivery.med)} / ${ms(p95)}` : "–"} | ${delivered} | ${(failed * 100).toFixed(1)}% |`,
  );
}
console.log(rows.join("\n"));
