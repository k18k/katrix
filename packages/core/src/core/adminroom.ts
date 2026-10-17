import { randomString } from "#core/crypto.ts";
import { MatrixError } from "#core/errors.ts";
import { isValidRoomId, isValidUserId } from "#core/ids.ts";
import type { PDU } from "#core/events.ts";
import type { Homeserver } from "#homeserver.ts";
import { createUser } from "#api/account.ts";
import { M, UNSTABLE } from "#core/m.ts";

export interface AdminRoomOptions {
  /** Enable the admin room and admin bot. Default: true when the option object is given. */
  enabled?: boolean;
  /** The first account registered on the server becomes a server admin. Default: true. */
  firstUserIsAdmin?: boolean;
  /** Let the very first account register even when registration is closed. Default: true. */
  firstUserCanRegister?: boolean;
  /** Localpart of the admin bot. Default: "admin". */
  botLocalpart?: string;
  botDisplayName?: string;
  roomName?: string;
  /** Localpart of the admin room alias (#admins:server). Default: "admins". */
  aliasLocalpart?: string;
}

const HELP = `Admin commands (type them in this room, optionally prefixed with !admin):

users list [--all]                         List accounts (--all includes deactivated)
users info <user>                          Account details
users whois <user>                         Devices, IPs and last seen
users create <localpart> [password] [--admin]
users reset-password <user> [password]     Generates a password when omitted; logs out all devices
users deactivate <user> [--keep-profile]
users make-admin <user> | users revoke-admin <user>
users lock <user> | users unlock <user>     Lock: the account cannot be used until unlocked
users suspend <user> | users unsuspend <user>  Suspend: read-only (can still leave rooms and log out)
tokens list | tokens create [uses] [days] | tokens delete <token>
registration status | open | close | token
rooms list | rooms info <room> | rooms delete <room> [--purge]
media delete <mxc://server/id> | media purge <days>
notice <user> <message>                    Send a server notice
audit [user] [limit]                       Recent audit log entries
reports list | reports resolve <id>        Content reports
server stats
help`;

/** Split a command line into arguments, honouring quotes. */
export function parseArgs(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * A tuwunel-style admin room: server admins chat with an admin bot to manage the
 * server. The first registered account becomes an admin and is put in the room.
 */
export class AdminRoomService {
  private hs: Homeserver;
  readonly options: Required<AdminRoomOptions>;
  private roomIdCache: string | null = null;

  constructor(hs: Homeserver, options: AdminRoomOptions) {
    this.hs = hs;
    this.options = {
      enabled: options.enabled ?? true,
      firstUserIsAdmin: options.firstUserIsAdmin ?? true,
      firstUserCanRegister: options.firstUserCanRegister ?? true,
      botLocalpart: options.botLocalpart ?? "admin",
      botDisplayName: options.botDisplayName ?? "Admin",
      roomName: options.roomName ?? "Admin Room",
      aliasLocalpart: options.aliasLocalpart ?? "admins",
    };
  }

  get botUserId(): string {
    return `@${this.options.botLocalpart}:${this.hs.serverName}`;
  }

  get alias(): string {
    return `#${this.options.aliasLocalpart}:${this.hs.serverName}`;
  }

  /** Whether no real (non-bot) account exists yet. */
  async noUsersYet(): Promise<boolean> {
    const users = await this.hs.db.findMany("users", { limit: 2 });
    return users.every((u) => u.user_id === this.botUserId);
  }

  async roomId(): Promise<string | null> {
    if (this.roomIdCache) return this.roomIdCache;
    const row = await this.hs.db.findOne("room_aliases", [{ field: "alias", value: this.alias }]);
    this.roomIdCache = row?.room_id ?? null;
    return this.roomIdCache;
  }

  /** Create the admin bot and room if needed. */
  async ensureRoom(): Promise<string> {
    return this.hs.cluster.lock("adminroom", async () => {
      const existing = await this.roomId();
      if (existing) return existing;
      if (!(await this.hs.db.findOne("users", [{ field: "user_id", value: this.botUserId }]))) {
        await createUser(this.hs, this.options.botLocalpart, { displayname: this.options.botDisplayName, admin: true });
      }
      const { room_id } = await this.hs.rooms.createRoom(this.botUserId, {
        preset: "private_chat",
        name: this.options.roomName,
        topic: "Server administration. Type 'help' for commands.",
        room_alias_name: this.options.aliasLocalpart,
        power_level_content_override: { users: { [this.botUserId]: 100 }, events_default: 0, invite: 100, kick: 100, ban: 100 },
        initial_state: [{ type: M.ROOM.HISTORY_VISIBILITY, state_key: "", content: { history_visibility: "joined" } }],
      });
      this.roomIdCache = room_id;
      return room_id;
    });
  }

  /** Called after an account was created. */
  async onUserCreated(userId: string): Promise<void> {
    if (!this.options.enabled || userId === this.botUserId || !this.options.firstUserIsAdmin) return;
    const first = await this.hs.cluster.lock("first-user", async () => {
      const users = await this.hs.db.findMany("users", { sortBy: { field: "created_ts", direction: "asc" }, limit: 3 });
      return users.filter((u) => u.user_id !== this.botUserId)[0]?.user_id === userId;
    });
    if (!first) return;
    await this.hs.db.update("users", [{ field: "user_id", value: userId }], { is_admin: true });
    await this.hs.auth.invalidateUser(userId);
    await this.addAdmin(userId);
    await this.say(`Welcome ${userId}! As the first user you are a server admin. Type \`help\` for the available commands.`);
  }

  /** Put an admin into the admin room. */
  async addAdmin(userId: string): Promise<void> {
    if (!this.options.enabled || userId === this.botUserId) return;
    const roomId = await this.ensureRoom();
    const membership = await this.hs.rooms.membership(roomId, userId);
    if (membership === "join") return;
    if (membership !== "invite") await this.hs.rooms.invite(roomId, this.botUserId, userId);
    await this.hs.rooms.join(userId, roomId);
  }

  /** Remove a former admin from the admin room. */
  async removeAdmin(userId: string): Promise<void> {
    const roomId = await this.roomId();
    if (!roomId || userId === this.botUserId) return;
    const membership = await this.hs.rooms.membership(roomId, userId);
    if (membership === "join" || membership === "invite") {
      await this.hs.rooms.setMembership(roomId, this.botUserId, userId, "leave", "No longer a server admin");
    }
  }

  /** Post a message from the admin bot. */
  async say(text: string, replyTo?: string): Promise<void> {
    const roomId = await this.roomId();
    if (!roomId) return;
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const content: Record<string, any> = {
      msgtype: M.NOTICE,
      body: text,
      format: UNSTABLE.ORG.MATRIX.CUSTOM.HTML,
      formatted_body: text.includes("\n") ? `<pre><code>${escaped}</code></pre>` : escaped.replace(/`([^`]+)`/g, "<code>$1</code>"),
    };
    if (replyTo) content[M.RELATES_TO] = { [M.IN_REPLY_TO]: { event_id: replyTo } };
    await this.hs.rooms.sendEvent(roomId, this.botUserId, { type: M.ROOM.MESSAGE, content });
  }

  /** Called for every new event; handles commands posted in the admin room. */
  async onEvent(event: PDU): Promise<void> {
    if (!this.options.enabled || event.type !== M.ROOM.MESSAGE || event.sender === this.botUserId) return;
    if (event.room_id !== (await this.roomId())) return;
    const body = typeof event.content?.body === "string" ? event.content.body.trim() : "";
    if (!body || event.content?.msgtype === M.NOTICE) return;
    const user = await this.hs.db.findOne("users", [{ field: "user_id", value: event.sender }]);
    if (!user?.is_admin) return;
    const line = body.replace(/^!admin\s*/i, "").replace(new RegExp(`^${this.botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:?\\s*`), "");
    let reply: string;
    try {
      reply = await this.execute(event.sender, parseArgs(line));
    } catch (err) {
      reply = `Error: ${err instanceof MatrixError ? err.message : err instanceof Error ? err.message : String(err)}`;
    }
    await this.hs.audit.record({
      action: "admin_command",
      actor: event.sender,
      details: { command: line.split(/\s+/).slice(0, 2).join(" ") },
    });
    await this.say(reply, event.event_id);
  }

  private resolveUser(arg: string | undefined): string {
    if (!arg) throw new Error("Missing user");
    const id = arg.startsWith("@") ? arg : `@${arg.toLowerCase()}:${this.hs.serverName}`;
    if (!isValidUserId(id)) throw new Error(`Invalid user ID: ${arg}`);
    return id;
  }

  private async resolveRoom(arg: string | undefined): Promise<string> {
    if (!arg) throw new Error("Missing room");
    if (arg.startsWith("#")) return this.hs.rooms.resolveRoomIdOrAlias(arg);
    if (!isValidRoomId(arg)) throw new Error(`Invalid room: ${arg}`);
    return arg;
  }

  /** Run one admin command; returns the reply text. */
  async execute(actor: string, args: string[]): Promise<string> {
    const hs = this.hs;
    const flags = new Set(args.filter((a) => a.startsWith("--")));
    const pos = args.filter((a) => !a.startsWith("--"));
    const [group, sub, a1, a2] = pos;
    const time = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : "never");

    switch (group?.toLowerCase()) {
      case undefined:
      case "help":
        return HELP;

      case "users": {
        switch (sub) {
          case "list": {
            const { users, total } = await hs.admin.listUsers({ includeDeactivated: flags.has("--all"), limit: 200 });
            return `${total} account(s):\n${users.map((u) => `${u.user_id}${u.is_admin ? " [admin]" : ""}${u.deactivated ? " [deactivated]" : ""}${u.locked ? " [locked]" : ""}${u.suspended ? " [suspended]" : ""}`).join("\n")}`;
          }
          case "info": {
            const user = await hs.admin.getUser(this.resolveUser(a1));
            if (!user) return "No such user";
            return Object.entries(user)
              .map(([k, v]) => `${k}: ${k.endsWith("_ts") ? time(v as number) : v}`)
              .join("\n");
          }
          case "whois": {
            const userId = this.resolveUser(a1);
            const devices = await hs.db.findMany("devices", { where: [{ field: "user_id", value: userId }] });
            if (!devices.length) return `${userId} has no devices`;
            return devices
              .map((d) => `${d.device_id} ${d.display_name ?? ""}\n  last seen ${time(d.last_seen_ts)} from ${d.last_seen_ip ?? "unknown"}`)
              .join("\n");
          }
          case "create": {
            if (!a1) return "Usage: users create <localpart> [password] [--admin]";
            const password = a2 ?? randomString(16);
            const userId = await hs.admin.createUser(a1, { password, admin: flags.has("--admin") });
            if (flags.has("--admin")) await this.addAdmin(userId);
            await hs.audit.record({
              action: "admin_action",
              actor,
              target: userId,
              details: { op: "create_user", admin: flags.has("--admin") },
            });
            return `Created ${userId}${a2 ? "" : ` with password: ${password}`}`;
          }
          case "reset-password": {
            const userId = this.resolveUser(a1);
            const password = a2 ?? randomString(16);
            await hs.admin.resetPassword(userId, password, true);
            await hs.audit.record({ action: "admin_action", actor, target: userId, details: { op: "reset_password" } });
            return `Password for ${userId} reset${a2 ? "" : ` to: ${password}`}. All devices were logged out.`;
          }
          case "deactivate": {
            const userId = this.resolveUser(a1);
            if (userId === actor) return "You cannot deactivate yourself here";
            await hs.admin.deactivateUser(userId, { erase: !flags.has("--keep-profile") });
            await hs.audit.record({ action: "admin_action", actor, target: userId, details: { op: "deactivate" } });
            return `Deactivated ${userId}`;
          }
          case "make-admin":
          case "revoke-admin": {
            const userId = this.resolveUser(a1);
            if (sub === "revoke-admin" && userId === actor) return "You cannot revoke your own admin rights";
            await hs.admin.setAdmin(userId, sub === "make-admin");
            await hs.audit.record({ action: "admin_action", actor, target: userId, details: { op: sub } });
            return `${userId} is ${sub === "make-admin" ? "now" : "no longer"} a server admin`;
          }
          case "lock":
          case "unlock": {
            const userId = this.resolveUser(a1);
            if (userId === actor) return "You cannot lock yourself";
            await hs.admin.setLocked(userId, sub === "lock", actor);
            return `${userId} is ${sub === "lock" ? "now" : "no longer"} locked`;
          }
          case "suspend":
          case "unsuspend": {
            const userId = this.resolveUser(a1);
            if (userId === actor) return "You cannot suspend yourself";
            await hs.admin.setSuspended(userId, sub === "suspend", actor);
            return `${userId} is ${sub === "suspend" ? "now" : "no longer"} suspended`;
          }
        }
        return "Usage: users list|info|whois|create|reset-password|deactivate|make-admin|revoke-admin|lock|unlock|suspend|unsuspend";
      }

      case "tokens": {
        switch (sub) {
          case "list": {
            const tokens = await hs.admin.listRegistrationTokens();
            if (!tokens.length) return "No registration tokens";
            return tokens.map((t) => `${t.token}  used ${t.completed}/${t.uses_allowed ?? "∞"}  expires ${time(t.expiry_time)}`).join("\n");
          }
          case "create": {
            const uses = a1 ? Number(a1) : null;
            const days = a2 ? Number(a2) : null;
            const t = await hs.admin.createRegistrationToken({
              usesAllowed: uses,
              expiryTime: days ? Date.now() + days * 86_400_000 : null,
            });
            await hs.audit.record({ action: "registration_token_create", actor, target: t.token });
            return `Registration token: ${t.token}${uses ? ` (${uses} uses)` : ""}${days ? ` (expires in ${days} days)` : ""}`;
          }
          case "delete": {
            if (!a1) return "Usage: tokens delete <token>";
            await hs.admin.deleteRegistrationToken(a1);
            await hs.audit.record({ action: "registration_token_delete", actor, target: a1 });
            return `Deleted token ${a1}`;
          }
        }
        return "Usage: tokens list|create [uses] [days]|delete <token>";
      }

      case "registration": {
        if (!sub || sub === "status") return `Registration is ${await hs.registrationMode()}`;
        if (!["open", "close", "closed", "token"].includes(sub)) return "Usage: registration status|open|close|token";
        const mode = sub === "close" ? "closed" : sub;
        await hs.settings.set("registration", mode);
        await hs.audit.record({ action: "registration_setting", actor, details: { mode } });
        return `Registration is now ${mode}`;
      }

      case "rooms": {
        switch (sub) {
          case "list": {
            const { rooms, total } = await hs.admin.listRooms({ limit: 200 });
            const lines = await Promise.all(
              rooms.map(async (r) => {
                const name = (await hs.rooms.currentState(r.room_id)).get("m.room.name\u0000")?.content?.name;
                return `${r.room_id}  ${r.joined_members} member(s)${name ? `  "${name}"` : ""}${r.is_public ? " [public]" : ""}`;
              }),
            );
            return `${total} room(s):\n${lines.join("\n")}`;
          }
          case "info": {
            const roomId = await this.resolveRoom(a1);
            const state = await hs.rooms.currentState(roomId);
            const members = await hs.rooms.joinedMembers(roomId);
            return [
              `Room ${roomId} (version ${await hs.rooms.roomVersion(roomId)})`,
              `Name: ${state.get("m.room.name\u0000")?.content?.name ?? "-"}`,
              `Creator: ${state.get("m.room.create\u0000")?.sender}`,
              `Join rule: ${state.get("m.room.join_rules\u0000")?.content?.join_rule ?? "invite"}`,
              `Members (${members.length}): ${members.slice(0, 50).join(", ")}${members.length > 50 ? ", …" : ""}`,
            ].join("\n");
          }
          case "delete": {
            const roomId = await this.resolveRoom(a1);
            if (roomId === (await this.roomId())) return "Refusing to delete the admin room";
            const { kicked } = await hs.admin.deleteRoom(roomId, {
              actor,
              purge: flags.has("--purge"),
              reason: "Room deleted by a server admin",
            });
            await hs.audit.record({ action: "room_delete", actor, target: roomId, details: { purge: flags.has("--purge") } });
            return `Deleted ${roomId}; removed ${kicked.length} local member(s)${flags.has("--purge") ? " and purged its history" : ""}`;
          }
        }
        return "Usage: rooms list|info <room>|delete <room> [--purge]";
      }

      case "media": {
        if (sub === "delete") {
          const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(a1 ?? "");
          if (!m || m[1] !== hs.serverName) return "Usage: media delete mxc://<this server>/<id>";
          await hs.admin.deleteMedia(m[2]);
          await hs.audit.record({ action: "admin_action", actor, target: a1, details: { op: "delete_media" } });
          return `Deleted ${a1}`;
        }
        if (sub === "purge") {
          const days = Number(a1);
          if (!(days > 0)) return "Usage: media purge <days>";
          const deleted = await hs.admin.purgeMediaBefore(Date.now() - days * 86_400_000);
          await hs.audit.record({ action: "admin_action", actor, details: { op: "purge_media", days, count: deleted.length } });
          return `Deleted ${deleted.length} media file(s) older than ${days} day(s)`;
        }
        return "Usage: media delete <mxc>|purge <days>";
      }

      case "notice": {
        const target = this.resolveUser(sub);
        const message = pos.slice(2).join(" ");
        if (!message) return "Usage: notice <user> <message>";
        await hs.admin.sendServerNotice(target, { msgtype: M.TEXT, body: message });
        await hs.audit.record({ action: "admin_action", actor, target, details: { op: "server_notice" } });
        return `Notice sent to ${target}`;
      }

      case "audit": {
        if (!hs.audit.enabled) return "The audit log is disabled (enable it with the `audit` option)";
        const user = sub && !/^\d+$/.test(sub) ? this.resolveUser(sub) : undefined;
        const limit = Number(user ? a1 : sub) || 20;
        const rows = await hs.audit.query({ actor: user, limit });
        if (!rows.length) return "No audit entries";
        return rows
          .map(
            (r) =>
              `${time(r.ts)} ${r.action}${r.outcome === "failure" ? " (failed)" : ""} by ${r.actor ?? "-"}${r.target ? ` → ${r.target}` : ""}${r.ip ? ` from ${r.ip}` : ""}`,
          )
          .join("\n");
      }

      case "reports": {
        if (sub === "resolve") {
          if (!(await hs.db.update("event_reports", [{ field: "id", value: Number(a1) }], { resolved: true }))) return "No such report";
          return `Report ${a1} resolved`;
        }
        const rows = await hs.db.findMany("event_reports", {
          where: [{ field: "resolved", value: false }],
          sortBy: { field: "id", direction: "desc" },
          limit: 50,
        });
        if (!rows.length) return "No open reports";
        return rows
          .map(
            (r) =>
              `#${r.id} ${time(r.ts)} ${r.reporter} reported ${r.event_id ?? "the room"} in ${r.room_id}: ${r.reason ?? "(no reason)"}`,
          )
          .join("\n");
      }

      case "server": {
        const users = await hs.db.findMany("users");
        const rooms = await hs.db.findMany("rooms");
        return [
          `Server: ${hs.serverName}`,
          `Users: ${users.filter((u) => !u.deactivated).length} active, ${users.filter((u) => u.deactivated).length} deactivated`,
          `Rooms: ${rooms.length}`,
          `Registration: ${await hs.registrationMode()}`,
          `Federation: ${hs.federation.enabled ? "enabled" : "disabled"}`,
          `Instance: ${hs.instanceId}`,
        ].join("\n");
      }
    }
    return `Unknown command "${group}". Type help for the list of commands.`;
  }
}
