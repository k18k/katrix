// Turn k6 summaries (`k6 run --summary-export`) into shields.io endpoint badges and a Markdown
// table. Usage: node loadtest/badges.ts <out-dir> <name>=<label>=<summary.json>...
//   writes <out-dir>/<name>.json per scenario and prints the table (for the job summary).
// MESSAGES_PER_SECOND and DURATION (as given to k6) say how many messages the run asked for.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [outDir, ...specs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const ms = (v: number | undefined) => (v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const seconds = (d: string | undefined) => {
  const m = /^(\d+(?:\.\d+)?)(s|m)$/.exec(d ?? "");
  return m ? Number(m[1]) * (m[2] === "m" ? 60 : 1) : undefined;
};
const rate = Number(process.env.MESSAGES_PER_SECOND);
const duration = seconds(process.env.DURATION);
const asked = rate && duration ? Math.round(rate * duration) : undefined;

const rows: string[] = [
  "| Scenario | req/s | messages sent | send p50 / p95 | /sync p50 / p95 | delivery p50 / p95 | delivered | failed |",
  "|---|---|---|---|---|---|---|---|",
];

for (const spec of specs) {
  const [name, label, file] = spec.split("=");
  if (!existsSync(file)) {
    writeFileSync(`${outDir}/${name}.json`, JSON.stringify({ schemaVersion: 1, label, message: "no result", color: "lightgrey" }));
    rows.push(`| ${label} | no result | | | | | | |`);
    continue;
  }
  const m = JSON.parse(readFileSync(file, "utf8")).metrics;
  const rps = m.http_reqs?.rate ?? 0;
  const failed = m.http_req_failed?.value ?? 1;
  const send = m["http_req_duration{name:send}"] ?? {};
  const sync = m["http_req_duration{name:sync}"] ?? {};
  const delivery = m.message_delivery ?? {};
  const delivered = m.messages_received?.count ?? 0;
  const sentCount = m.messages_sent?.count ?? 0;
  // The messages the run asked for: from the settings, or what was sent plus what k6 had to skip.
  const expected = asked ?? sentCount + (m.dropped_iterations?.count ?? 0);
  const share = expected ? sentCount / expected : 0;
  const p95 = delivered ? delivery["p(95)"] : undefined;
  // Colour by how long a message takes to reach the other members (p95), but a run in which the
  // server did not take the whole load measured a lighter one: it is at best yellow, or red.
  let color =
    failed > 0.01 || p95 === undefined ? "red" : p95 < 1000 ? "brightgreen" : p95 < 3000 ? "green" : p95 < 10_000 ? "yellow" : "orange";
  if (share < 0.9) color = "red";
  else if (share < 0.99 && (color === "brightgreen" || color === "green")) color = "yellow";
  const parts = [`${Math.round(rps)} req/s`, `delivery p95 ${ms(p95)}`];
  if (share < 0.99) parts.push(`only ${Math.round(share * 100)}% of messages sent`);
  if (failed > 0.01) parts.push(`${(failed * 100).toFixed(1)}% failed`);
  writeFileSync(`${outDir}/${name}.json`, JSON.stringify({ schemaVersion: 1, label, message: parts.join(" · "), color }));
  rows.push(
    `| ${label} | ${Math.round(rps)} | ${sentCount} / ${expected} (${Math.round(share * 100)}%) | ${ms(send.med)} / ${ms(send["p(95)"])} | ` +
      `${ms(sync.med)} / ${ms(sync["p(95)"])} | ${delivered ? `${ms(delivery.med)} / ${ms(p95)}` : "–"} | ${delivered} | ${(failed * 100).toFixed(1)}% |`,
  );
}
console.log(rows.join("\n"));
