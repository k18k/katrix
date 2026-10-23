// Spec coverage: which endpoints of the Matrix spec this server implements, and which are tested.
// Usage:
//   curl -sL https://github.com/matrix-org/matrix-spec/archive/refs/tags/v1.19.tar.gz | tar xz -C /tmp
//   node --conditions=matrix-src scripts/spec-coverage.ts /tmp/matrix-spec-1.19 complement-results.json > SPEC-COVERAGE.md
//
// Implemented: the router answers the endpoint (method and path). Tested: Complement sent the
// request (its `[CSAPI]` request log, or the path in its output, from a full run's `go test -json`),
// or a test in test/ names the path. Requests from Complement's own federation servers are not
// logged, so server-server endpoints can be tested without showing it here.
// https://github.com/k18k/matrix-nodejs-homeserver/issues/60
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHomeserver, memoryAdapter } from "#index.ts";

const [specDir, complementResults] = process.argv.slice(2);
if (!specDir) throw new Error("usage: node scripts/spec-coverage.ts <matrix-spec checkout> [complement go test -json output]");
const version = /matrix-spec-([\d.]+)/.exec(specDir)?.[1] ?? "?";

interface Endpoint {
  api: string;
  section: string;
  method: string;
  path: string;
  deprecated: boolean;
}

/** The endpoints of one OpenAPI file, read line by line (the files are regular enough for that). */
function endpoints(api: string, file: string): Endpoint[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const base =
    lines
      .find((l, i) => /^\s+default: \//.test(l) && /basePath:/.test(lines[i - 1] ?? ""))
      ?.trim()
      .slice("default: ".length) ?? "";
  const section = file
    .split("/")
    .pop()!
    .replace(/\.yaml$/, "");
  const out: Endpoint[] = [];
  let path: string | null = null;
  let inPaths = false;
  for (const line of lines) {
    if (line.startsWith("paths:")) inPaths = true;
    else if (/^\S/.test(line)) inPaths = false;
    if (!inPaths) continue;
    const p = /^ {2}"?(\/[^":]*)"?:\s*$/.exec(line);
    if (p) path = p[1].trim();
    const m = /^ {4}(get|put|post|delete):\s*$/.exec(line);
    if (m && path) out.push({ api, section, method: m[1].toUpperCase(), path: base + path, deprecated: false });
    if (/^ {6}deprecated: true/.test(line) && out.length) out[out.length - 1].deprecated = true;
  }
  return out;
}

const all: Endpoint[] = [];
for (const api of ["client-server", "server-server"]) {
  const dir = join(specDir, "data/api", api);
  for (const f of readdirSync(dir).sort()) if (f.endsWith(".yaml")) all.push(...endpoints(api, join(dir, f)));
}

const hs = createHomeserver({
  homeserver: "localhost",
  databaseAdapter: memoryAdapter(),
  cleanupIntervalMs: 0,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
const sample: Record<string, string> = {
  roomId: "!r:x",
  userId: "@u:x",
  roomIdOrAlias: "!r:x",
  roomAlias: "#a:x",
  eventId: "$e",
  queryType: "profile",
};
/** Served by policy servers (MSC4284), not by homeservers. */
const notApplicable = (e: Endpoint) => e.section === "policy_server" || e.section === "room_policy";
const instantiate = (path: string) => path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(sample[name] ?? "x"));
const implemented = (e: Endpoint) => {
  const m = hs.router.match(e.method, instantiate(e.path));
  return m !== null && m !== "method";
};
const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
/** The endpoint's path as a regex source; parameters match one segment (`param`), the version any. */
const source = (e: Endpoint, param: string) =>
  e.path
    .split(/(\{[^}]+\})/)
    .map((part) => (part.startsWith("{") ? param : escape(part)))
    .join("")
    .replace(/\/(v\d|r0)\//, "/(?:v\\d|r0)/");
const pattern = (e: Endpoint) => new RegExp(`^${source(e, "[^/?]+")}$`);
// In test sources, a parameter is a literal or a template expression such as `${roomId}`.
const QUOTES = "\"'`";
const testPattern = (e: Endpoint) => new RegExp(`${source(e, `(?:\\$\\{[^}]+\\}|[^/${QUOTES}\\s?]+)`)}(?:[${QUOTES}?]|$)`, "m");

// Requests Complement made: "[CSAPI] GET hs1/_matrix/client/v3/sync" and federation paths in its output.
const requested: { method: string | null; path: string }[] = [];
if (complementResults) {
  for (const line of readFileSync(complementResults, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const out: string = JSON.parse(line).Output ?? "";
    for (const m of out.matchAll(/\[CSAPI\] ([A-Z]+) hs\d+(\/\S*)/g)) requested.push({ method: m[1], path: m[2] });
    for (const m of out.matchAll(/(\/_matrix\/(?:federation|key)\/\S+)/g)) requested.push({ method: null, path: m[1] });
  }
}
const testSources = readdirSync(new URL("../test", import.meta.url), { recursive: true })
  .filter((f) => String(f).endsWith(".ts"))
  .map((f) => readFileSync(new URL(`../test/${f}`, import.meta.url), "utf8"))
  .join("\n");

const rows = all.map((e) => {
  const re = pattern(e);
  const complement = requested.some((r) => (r.method === null || r.method === e.method) && re.test(r.path.split("?")[0]));
  const unit = testPattern(e).test(testSources);
  return { ...e, implemented: implemented(e), complement, unit, na: notApplicable(e) };
});

const count = (rs: typeof rows, f: (r: (typeof rows)[number]) => boolean) => rs.filter(f).length;
const out: string[] = [];
out.push(`# Spec coverage (Matrix v${version})`);
out.push("");
out.push("Generated by `scripts/spec-coverage.ts` from the spec's API definitions and a full Complement run; do not edit by hand.");
out.push(
  "**Implemented** means the server answers the endpoint. **Tested**: `C` Complement sent the request, `U` a test in `test/` uses the path.",
);
out.push("Complement's own federation servers do not log their requests, so server-server endpoints may be tested without a `C`.");
out.push("Deprecated endpoints, and those served by policy servers rather than homeservers, are listed but not counted.");
out.push("");
out.push("| API | Endpoints | Implemented | Tested |");
out.push("|---|---|---|---|");
for (const api of ["client-server", "server-server"]) {
  const rs = rows.filter((r) => r.api === api && !r.deprecated && !r.na);
  out.push(
    `| ${api} | ${rs.length} | ${count(rs, (r) => r.implemented)} | ${count(rs, (r) => r.implemented && (r.complement || r.unit))} |`,
  );
}
const missing = rows.filter((r) => !r.implemented && !r.deprecated && !r.na);
out.push("");
out.push("## Not implemented");
out.push("");
out.push(
  missing.length
    ? missing.map((r) => `- \`${r.method} ${r.path}\` (${r.api}, ${r.section})`).join("\n")
    : "Nothing: every stable endpoint is implemented.",
);
for (const api of ["client-server", "server-server"]) {
  out.push("");
  out.push(`## ${api}`);
  out.push("");
  out.push("| Section | Endpoint | Implemented | Tested |");
  out.push("|---|---|---|---|");
  for (const r of rows.filter((x) => x.api === api)) {
    const tested = [r.complement ? "C" : "", r.unit ? "U" : ""].filter(Boolean).join(" ") || "–";
    out.push(
      `| ${r.section} | \`${r.method} ${r.path}\`${r.deprecated ? " (deprecated)" : ""} | ${r.implemented ? "yes" : r.na ? "n/a" : "**no**"} | ${tested} |`,
    );
  }
}
console.log(out.join("\n"));
await hs.close();
