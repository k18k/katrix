import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import {
  createHomeserver,
  filesystemMedia,
  getNodeHandler,
  postgresAdapter,
  sqliteAdapter,
  type DatabaseAdapter,
  type Homeserver,
} from "matrix-nodejs-homeserver";
import type { PublicConfig } from "./config.ts";

// The public server: a homeserver anyone can sign in to with GitHub, without federation.
// It is version 0: for trying things out, and its data may be migrated or, if it has to be,
// reset (the landing page says so).

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function landingPage(config: PublicConfig): string {
  const name = escape(config.serverName);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title><style>
:root{--bg:#f6f7f9;--text:#1b1f24;--muted:#5d6670;--line:#dde1e6;--accent:#0b7a55}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--text:#e8eaed;--muted:#9aa3ad;--line:#2c323a;--accent:#2fb37f}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif}main{max-width:36rem;margin:3rem auto;padding:0 1rem}
code{background:color-mix(in srgb,var(--line) 60%,transparent);padding:.1rem .35rem;border-radius:4px}.tag{display:inline-block;border:1px solid var(--accent);color:var(--accent);border-radius:999px;padding:0 .6rem;font-size:.85rem}
a{color:var(--accent)}p.muted{color:var(--muted)}</style>
<main><p><span class="tag">v0 · test server</span></p><h1>${name}</h1>
<p>A public Matrix homeserver running <a href="https://github.com/k18k/matrix-nodejs-homeserver">matrix-nodejs-homeserver</a>.
Sign in with GitHub from any Matrix client, for example <a href="https://app.element.io">Element</a>: choose <b>Edit</b> next to the homeserver and enter <code>${name}</code>.</p>
<p class="muted">This is version 0. It is for testing: features change, the server may be down, and although data is meant to survive updates, it may have to be reset. Do not rely on it for anything important. It does not federate with other servers.</p>
${config.termsUrl ? `<p class="muted"><a href="${escape(config.termsUrl)}">Terms</a>${config.policyUrl ? ` · <a href="${escape(config.policyUrl)}">Privacy</a>` : ""}</p>` : ""}
</main></html>`;
}

export async function startPublicServer(config: PublicConfig): Promise<{ hs: Homeserver; server: Server; close: () => Promise<void> }> {
  let databaseAdapter: DatabaseAdapter;
  let pool: pg.Pool | null = null;
  mkdirSync(config.dataDir, { recursive: true });
  if (config.databaseUrl) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPool });
    databaseAdapter = postgresAdapter(pool);
  } else {
    databaseAdapter = sqliteAdapter(new DatabaseSync(`${config.dataDir}/homeserver.db`));
  }

  const admins = new Set(config.admins);
  const hs: Homeserver = createHomeserver({
    homeserver: config.serverName,
    publicBaseUrl: config.publicBaseUrl,
    databaseAdapter,
    mediaAdapter: filesystemMedia(`${config.dataDir}/media`),
    // GitHub (or the dev provider) is the only way in: no passwords, and accounts are created by
    // the first login through the provider.
    oauthServer: { termsUrl: config.termsUrl, policyUrl: config.policyUrl },
    sso: { providers: [config.provider] },
    userAuthAdapter: {
      passwordLoginEnabled: false,
      registrationEnabled: false,
      async onUserRegistered(userId) {
        if (admins.has(userId)) await hs.admin.setAdmin(userId, true);
      },
    },
    federation: { enabled: false },
    audit: { enabled: true },
  });
  await hs.ready;
  for (const userId of admins) if (await hs.admin.getUser(userId)) await hs.admin.setAdmin(userId, true);

  const matrix = getNodeHandler(hs);
  const page = landingPage(config);
  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" });
      return res.end(page);
    }
    matrix(req, res);
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  return {
    hs,
    server,
    async close() {
      await hs.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool?.end();
    },
  };
}
