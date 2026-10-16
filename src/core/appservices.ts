import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { errors, MatrixError } from "#core/errors.ts";
import { splitStateKey, toClientEvent, type PDU } from "#core/events.ts";
import type { StateMap } from "#core/authrules.ts";
import type { Homeserver } from "#homeserver.ts";

export interface AppServiceNamespace {
  exclusive: boolean;
  regex: string;
}

/** An application service registration (bridges, bots, integrations). */
export interface AppServiceRegistration {
  id: string;
  /** Base URL of the application service, or null when it receives nothing. */
  url: string | null;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  namespaces: { users?: AppServiceNamespace[]; aliases?: AppServiceNamespace[]; rooms?: AppServiceNamespace[] };
  rate_limited?: boolean;
  protocols?: string[];
  /** MSC2409: also push ephemeral events (typing, receipts, presence). */
  "de.sorunome.msc2409.push_ephemeral"?: boolean;
  receive_ephemeral?: boolean;
}

interface CompiledService {
  reg: AppServiceRegistration;
  users: { exclusive: boolean; re: RegExp }[];
  aliases: { exclusive: boolean; re: RegExp }[];
  rooms: { exclusive: boolean; re: RegExp }[];
}

const compile = (ns: AppServiceNamespace[] = []) => ns.map((n) => ({ exclusive: !!n.exclusive, re: new RegExp(`^(?:${n.regex})$`) }));

/**
 * Parse an application service registration file. Accepts JSON or the YAML subset
 * used by registration files (nested mappings and lists of mappings, scalars).
 */
export function parseAppServiceRegistration(text: string): AppServiceRegistration {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return parseSimpleYaml(text) as AppServiceRegistration;
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "[]") return [];
  if (v === "{}") return {};
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"') && v.endsWith('"')) return JSON.parse(v);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith("[") && v.endsWith("]"))
    return v
      .slice(1, -1)
      .split(",")
      .map((x) => parseScalar(x))
      .filter((x) => x !== null);
  return v;
}

/** Minimal YAML reader (indentation-based maps, "- " lists, scalars, comments). */
function parseSimpleYaml(text: string): unknown {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, "").replace(/^#.*$/, ""))
    .filter((l) => l.trim() !== "")
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;
  const parseBlock = (indent: number): unknown => {
    if (i < lines.length && lines[i].text.startsWith("- ")) {
      const list: unknown[] = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
        const rest = lines[i].text.slice(2);
        if (/^[\w.-]+:/.test(rest)) {
          // A mapping inside a list item: re-read it as an indented block.
          lines[i] = { indent: indent + 2, text: rest };
          list.push(parseBlock(indent + 2));
        } else {
          list.push(parseScalar(rest));
          i++;
        }
      }
      return list;
    }
    const obj: Record<string, unknown> = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const m = /^([^:]+):\s*(.*)$/.exec(lines[i].text);
      if (!m) {
        i++;
        continue;
      }
      const key = m[1].trim().replace(/^["']|["']$/g, "");
      i++;
      if (m[2] !== "") obj[key] = parseScalar(m[2]);
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text.startsWith("- ")))) {
        obj[key] = parseBlock(lines[i].indent);
      } else obj[key] = null;
    }
    return obj;
  };
  return parseBlock(lines[0]?.indent ?? 0);
}

/** Load every *.yaml / *.yml / *.json registration in a directory. */
export async function loadAppServiceRegistrations(directory: string): Promise<AppServiceRegistration[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const out: AppServiceRegistration[] = [];
  for (const name of names.filter((n) => /\.(ya?ml|json)$/.test(n)).sort()) {
    out.push(parseAppServiceRegistration(await readFile(join(directory, name), "utf8")));
  }
  return out;
}

/** Application Service API: authentication, namespaces, event push and queries. */
export class AppServiceService {
  private hs: Homeserver;
  private services: CompiledService[];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(hs: Homeserver, registrations: AppServiceRegistration[]) {
    this.hs = hs;
    this.services = registrations.map((reg) => ({
      reg,
      users: compile(reg.namespaces?.users),
      aliases: compile(reg.namespaces?.aliases),
      rooms: compile(reg.namespaces?.rooms),
    }));
  }

  get registrations(): AppServiceRegistration[] {
    return this.services.map((s) => s.reg);
  }

  byToken(token: string): AppServiceRegistration | null {
    return this.services.find((s) => s.reg.as_token === token)?.reg ?? null;
  }

  byId(id: string): AppServiceRegistration | null {
    return this.services.find((s) => s.reg.id === id)?.reg ?? null;
  }

  senderOf(reg: AppServiceRegistration): string {
    return `@${reg.sender_localpart}:${this.hs.serverName}`;
  }

  private compiled(reg: AppServiceRegistration): CompiledService {
    return this.services.find((s) => s.reg === reg)!;
  }

  /** Whether the AS owns this user ID (its sender or its user namespace). */
  isInterestedUser(reg: AppServiceRegistration, userId: string): boolean {
    return userId === this.senderOf(reg) || (this.hs.isLocalUser(userId) && this.compiled(reg).users.some((n) => n.re.test(userId)));
  }

  /** An exclusive namespace owned by some AS (other than `except`) covers this user ID. */
  exclusiveUserOwner(userId: string): AppServiceRegistration | null {
    return this.services.find((s) => s.users.some((n) => n.exclusive && n.re.test(userId)))?.reg ?? null;
  }

  exclusiveAliasOwner(alias: string): AppServiceRegistration | null {
    return this.services.find((s) => s.aliases.some((n) => n.exclusive && n.re.test(alias)))?.reg ?? null;
  }

  /** Resolve the user an AS request acts as (masquerading with `user_id`). */
  async masquerade(reg: AppServiceRegistration, userIdParam: string | null): Promise<string> {
    const userId = userIdParam ?? this.senderOf(reg);
    if (!this.isInterestedUser(reg, userId)) throw errors.forbidden("Application service cannot masquerade as this user");
    if (userId === this.senderOf(reg) && !(await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]))) {
      await this.hs.db.create("users", {
        user_id: userId,
        localpart: reg.sender_localpart,
        password_hash: null,
        displayname: reg.sender_localpart,
        avatar_url: null,
        is_guest: false,
        is_admin: false,
        deactivated: false,
        created_ts: Date.now(),
      });
    }
    const user = await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]);
    if (!user) throw errors.forbidden("Application service has not registered this user");
    return userId;
  }

  // ---------------------------------------------------------------------------
  // Event push
  // ---------------------------------------------------------------------------

  private async interestedInEvent(svc: CompiledService, pdu: PDU, state: StateMap): Promise<boolean> {
    const reg = svc.reg;
    if (this.isInterestedUser(reg, pdu.sender)) return true;
    if (pdu.type === "m.room.member" && typeof pdu.state_key === "string" && this.isInterestedUser(reg, pdu.state_key)) return true;
    if (svc.rooms.some((n) => n.re.test(pdu.room_id))) return true;
    if (svc.aliases.length) {
      const aliases = await this.hs.db.findMany("room_aliases", { where: [{ field: "room_id", value: pdu.room_id }] });
      if (aliases.some((a) => svc.aliases.some((n) => n.re.test(a.alias)))) return true;
    }
    for (const [key, ev] of state) {
      const [type, userId] = splitStateKey(key);
      if (type === "m.room.member" && ev.content?.membership === "join" && this.isInterestedUser(reg, userId)) return true;
    }
    return false;
  }

  /** Queue an event for every interested application service. */
  async onEvent(pdu: PDU, state: StateMap): Promise<void> {
    for (const svc of this.services) {
      if (!svc.reg.url || !(await this.interestedInEvent(svc, pdu, state))) continue;
      await this.enqueue(svc.reg, "event", toClientEvent(pdu));
    }
  }

  /** Queue an ephemeral event (typing/receipt/presence) for interested services that asked for them. */
  async onEphemeral(roomId: string | null, event: Record<string, any>, users: string[]): Promise<void> {
    for (const svc of this.services) {
      const reg = svc.reg;
      if (!reg.url || !(reg.receive_ephemeral || reg["de.sorunome.msc2409.push_ephemeral"])) continue;
      let interested = users.some((u) => this.isInterestedUser(reg, u)) || (roomId !== null && svc.rooms.some((n) => n.re.test(roomId)));
      if (!interested && roomId) {
        for (const u of await this.hs.rooms.joinedMembers(roomId))
          if (this.isInterestedUser(reg, u)) {
            interested = true;
            break;
          }
      }
      if (interested) await this.enqueue(reg, "ephemeral", roomId ? { ...event, room_id: roomId } : event);
    }
  }

  private async enqueue(reg: AppServiceRegistration, kind: string, payload: Record<string, any>): Promise<void> {
    const id = await this.hs.cluster.nextId("appservice_outbox");
    await this.hs.db.create("appservice_outbox", { id, as_id: reg.id, kind, payload, created_ts: Date.now() });
    this.schedule(reg.id, 0);
  }

  private schedule(asId: string, delay: number): void {
    if (this.hs.isClosed || (this.timers.has(asId) && delay > 0)) return;
    const existing = this.timers.get(asId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(asId);
      void this.flush(asId).catch((err) => this.hs.logger.debug("Appservice flush failed", err));
    }, delay);
    timer.unref?.();
    this.timers.set(asId, timer);
  }

  private retries = new Map<string, number>();

  private async flush(asId: string): Promise<void> {
    const reg = this.byId(asId);
    if (!reg?.url) return;
    await this.hs.cluster.lock(`appservice:${asId}`, async () => {
      for (;;) {
        const rows = await this.hs.db.findMany("appservice_outbox", {
          where: [{ field: "as_id", value: asId }],
          sortBy: { field: "id", direction: "asc" },
          limit: 100,
        });
        if (!rows.length) return;
        const body: Record<string, any> = { events: rows.filter((r) => r.kind === "event").map((r) => r.payload) };
        const ephemeral = rows.filter((r) => r.kind === "ephemeral").map((r) => r.payload);
        if (ephemeral.length) {
          body.ephemeral = ephemeral;
          body["de.sorunome.msc2409.ephemeral"] = ephemeral;
        }
        const txnId = String(rows[rows.length - 1].id);
        try {
          const res = await this.hs.fetch(`${reg.url!.replace(/\/$/, "")}/_matrix/app/v1/transactions/${txnId}`, {
            method: "PUT",
            headers: { "content-type": "application/json", authorization: `Bearer ${reg.hs_token}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(`Application service returned ${res.status}`);
        } catch (err) {
          const n = (this.retries.get(asId) ?? 0) + 1;
          this.retries.set(asId, n);
          this.schedule(asId, Math.min(1000 * 2 ** n, 5 * 60_000));
          this.hs.logger.debug("Appservice", asId, "unreachable", err);
          return;
        }
        this.retries.delete(asId);
        await this.hs.db.delete("appservice_outbox", [{ field: "id", operator: "in", value: rows.map((r) => r.id) }]);
      }
    });
  }

  start(): void {
    for (const s of this.services) if (s.reg.url) this.schedule(s.reg.id, 0);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---------------------------------------------------------------------------
  // Queries to application services
  // ---------------------------------------------------------------------------

  private async query(reg: AppServiceRegistration, path: string): Promise<Response | null> {
    if (!reg.url) return null;
    try {
      return await this.hs.fetch(`${reg.url.replace(/\/$/, "")}${path}`, {
        headers: { authorization: `Bearer ${reg.hs_token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
  }

  /** Ask the owning AS whether a user exists (it may create it). */
  async queryUser(userId: string): Promise<boolean> {
    for (const svc of this.services) {
      if (!svc.users.some((n) => n.re.test(userId))) continue;
      const res = await this.query(svc.reg, `/_matrix/app/v1/users/${encodeURIComponent(userId)}`);
      if (res?.ok && (await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]))) return true;
    }
    return false;
  }

  /** Ask the owning AS about an alias; returns the room ID if it now exists. */
  async queryAlias(alias: string): Promise<string | null> {
    for (const svc of this.services) {
      if (!svc.aliases.some((n) => n.re.test(alias))) continue;
      const res = await this.query(svc.reg, `/_matrix/app/v1/rooms/${encodeURIComponent(alias)}`);
      if (res?.ok) {
        const row = await this.hs.db.findOne("room_aliases", [{ field: "alias", value: alias }]);
        if (row) return row.room_id;
      }
    }
    return null;
  }

  async ping(reg: AppServiceRegistration, transactionId?: string): Promise<number> {
    if (!reg.url) throw new MatrixError(400, "M_URL_NOT_SET", "Application service has no URL");
    const started = Date.now();
    let res: Response;
    try {
      res = await this.hs.fetch(`${reg.url.replace(/\/$/, "")}/_matrix/app/v1/ping`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${reg.hs_token}` },
        body: JSON.stringify(transactionId ? { transaction_id: transactionId } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new MatrixError(502, "M_CONNECTION_FAILED", `Could not reach the application service: ${(err as Error).message}`);
    }
    if (!res.ok)
      throw new MatrixError(502, "M_BAD_STATUS", "Application service returned an error", {
        status: res.status,
        body: await res.text().catch(() => ""),
      });
    return Date.now() - started;
  }

  async thirdParty(path: string, query: URLSearchParams): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const svc of this.services) {
      const res = await this.query(svc.reg, `/_matrix/app/v1/thirdparty/${path}${query.toString() ? `?${query}` : ""}`);
      if (res?.ok) {
        const body = await res.json().catch(() => null);
        if (Array.isArray(body)) results.push(...body);
      }
    }
    return results;
  }

  async protocols(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const svc of this.services) {
      for (const protocol of svc.reg.protocols ?? []) {
        const res = await this.query(svc.reg, `/_matrix/app/v1/thirdparty/protocol/${encodeURIComponent(protocol)}`);
        const body = res?.ok ? await res.json().catch(() => null) : null;
        out[protocol] = body ?? { user_fields: [], location_fields: [], icon: "", field_types: {}, instances: [] };
      }
    }
    return out;
  }
}
