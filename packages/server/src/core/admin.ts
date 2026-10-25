import { isValidUserId, LOCALPART_RE, M } from "@katrix/shared";
import { errors } from "#core/errors.ts";
import { randomString } from "#core/crypto.ts";
import type { Homeserver } from "#homeserver.ts";
import { createUser } from "#api/account.ts";
import { getState, membershipOf, powerLevels, userLevel } from "#core/authrules.ts";

export interface ServerNoticesOptions {
  /** Localpart of the user that sends server notices. Default: "server". */
  localpart?: string;
  displayName?: string;
  roomName?: string;
}

/** Programmatic administration, for embedding applications and the admin HTTP API. */
export class AdminService {
  private hs: Homeserver;

  constructor(hs: Homeserver) {
    this.hs = hs;
  }

  // --- Users ------------------------------------------------------------------

  async createUser(localpart: string, opts: { password?: string; admin?: boolean; displayname?: string } = {}): Promise<string> {
    const lp = localpart.toLowerCase();
    if (!LOCALPART_RE.test(lp)) throw errors.invalidUsername();
    if (await this.getUser(`@${lp}:${this.hs.serverName}`)) throw errors.userInUse();
    return createUser(this.hs, lp, opts);
  }

  async getUser(userId: string): Promise<Record<string, any> | null> {
    const row = await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]);
    if (!row) return null;
    const { password_hash, ...rest } = row;
    return rest;
  }

  async listUsers(opts: { from?: number; limit?: number; search?: string; includeDeactivated?: boolean } = {}) {
    let rows = await this.hs.db.findMany("users", { sortBy: { field: "created_ts", direction: "asc" } });
    if (!opts.includeDeactivated) rows = rows.filter((r) => !r.deactivated);
    if (opts.search) {
      const term = opts.search.toLowerCase();
      rows = rows.filter((r) => r.user_id.toLowerCase().includes(term) || (r.displayname ?? "").toLowerCase().includes(term));
    }
    const from = opts.from ?? 0;
    const limit = opts.limit ?? 100;
    return {
      users: rows.slice(from, from + limit).map(({ password_hash, ...u }) => u),
      total: rows.length,
      next: from + limit < rows.length ? from + limit : null,
    };
  }

  async setAdmin(userId: string, admin: boolean): Promise<void> {
    if (!(await this.hs.db.update("users", [{ field: "user_id", value: userId }], { is_admin: admin })))
      throw errors.notFound("Unknown user");
    await this.hs.auth.invalidateUser(userId);
    if (admin) await this.hs.adminRoom?.addAdmin(userId);
    else await this.hs.adminRoom?.removeAdmin(userId);
  }

  /** Lock or unlock an account (reversible; sessions are kept but unusable while locked). */
  async setLocked(userId: string, locked: boolean, actor = "server"): Promise<void> {
    if (!(await this.hs.db.update("users", [{ field: "user_id", value: userId }], { locked }))) throw errors.notFound("Unknown user");
    await this.hs.auth.invalidateUser(userId);
    await this.hs.audit.record({ action: locked ? "user_lock" : "user_unlock", actor, target: userId });
  }

  /** Suspend or unsuspend an account (reversible; the user can still read, leave and log out). */
  async setSuspended(userId: string, suspended: boolean, actor = "server"): Promise<void> {
    if (!(await this.hs.db.update("users", [{ field: "user_id", value: userId }], { suspended }))) throw errors.notFound("Unknown user");
    await this.hs.auth.invalidateUser(userId);
    await this.hs.audit.record({ action: suspended ? "user_suspend" : "user_unsuspend", actor, target: userId });
  }

  async resetPassword(userId: string, password: string, logoutDevices = true): Promise<void> {
    const hash = await this.hs.userAuth.hashPassword(password);
    if (!(await this.hs.db.update("users", [{ field: "user_id", value: userId }], { password_hash: hash })))
      throw errors.notFound("Unknown user");
    if (logoutDevices) await this.hs.auth.deleteAllDevices(userId);
  }

  /** Deactivate an account: leave all rooms, log out everywhere and (optionally) erase the profile. */
  async deactivateUser(userId: string, opts: { erase?: boolean } = {}): Promise<void> {
    const user = await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]);
    if (!user) throw errors.notFound("Unknown user");
    for (const membership of ["join", "invite", "knock"]) {
      for (const roomId of await this.hs.rooms.roomsForUser(userId, membership)) {
        try {
          await this.hs.rooms.setMembership(roomId, userId, userId, "leave");
        } catch {
          /* best effort */
        }
      }
    }
    await this.hs.auth.deleteAllDevices(userId);
    await this.hs.threepids.removeAll(userId);
    await this.hs.db.delete("pushers", [{ field: "user_id", value: userId }]);
    const update: Record<string, unknown> = { deactivated: true, password_hash: null };
    if (opts.erase !== false) Object.assign(update, { displayname: null, avatar_url: null });
    await this.hs.db.update("users", [{ field: "user_id", value: userId }], update);
    await this.hs.auth.invalidateUser(userId);
  }

  // --- Registration tokens ------------------------------------------------------

  async createRegistrationToken(opts: { token?: string; usesAllowed?: number | null; expiryTime?: number | null; length?: number } = {}) {
    const token = opts.token ?? randomString(opts.length ?? 16);
    if (!/^[A-Za-z0-9._~-]{1,64}$/.test(token)) throw errors.invalidParam("Invalid token");
    if (await this.hs.db.findOne("registration_tokens", [{ field: "token", value: token }]))
      throw errors.invalidParam("Token already exists");
    const row = { token, uses_allowed: opts.usesAllowed ?? null, pending: 0, completed: 0, expiry_time: opts.expiryTime ?? null };
    await this.hs.db.create("registration_tokens", row);
    return row;
  }

  listRegistrationTokens() {
    return this.hs.db.findMany("registration_tokens");
  }

  async deleteRegistrationToken(token: string): Promise<void> {
    if (!(await this.hs.db.delete("registration_tokens", [{ field: "token", value: token }]))) throw errors.notFound("Unknown token");
  }

  // --- Rooms ------------------------------------------------------------------

  /**
   * Make a local user join a room, as Synapse's `POST /_synapse/admin/v1/join` does: public rooms
   * directly; otherwise a local member who may invite invites them first (the invite shows in the
   * room, so its members see who added them). Returns the room ID.
   */
  async joinUser(userId: string, roomIdOrAlias: string): Promise<string> {
    if (!this.hs.isLocalUser(userId) || !(await this.getUser(userId))) throw errors.notFound("Unknown user");
    const roomId = await this.hs.rooms.resolveRoomIdOrAlias(roomIdOrAlias);
    const version = await this.hs.rooms.roomVersion(roomId);
    if (!version) throw errors.notFound("Unknown room");
    const state = await this.hs.rooms.currentState(roomId);
    const membership = membershipOf(state, userId);
    if (membership === "join") return roomId;
    if (membership === "ban") throw errors.forbidden("The user is banned from the room");
    const joinRule = getState(state, M.ROOM.JOIN_RULES)?.content?.join_rule;
    if (membership !== "invite" && joinRule !== "public") {
      const pl = powerLevels(state, version);
      const inviter = (await this.hs.rooms.joinedMembers(roomId)).find((m) => this.hs.isLocalUser(m) && userLevel(pl, m) >= pl.invite);
      if (!inviter) throw errors.forbidden("No local member of the room may invite");
      await this.hs.rooms.invite(roomId, inviter, userId);
    }
    await this.hs.rooms.join(userId, roomId);
    return roomId;
  }

  async listRooms(opts: { from?: number; limit?: number } = {}) {
    const rows = await this.hs.db.findMany("rooms", { sortBy: { field: "created_ts", direction: "asc" } });
    const from = opts.from ?? 0;
    const page = rows.slice(from, from + (opts.limit ?? 100));
    return {
      rooms: await Promise.all(
        page.map(async (r): Promise<Record<string, any>> => ({
          ...r,
          joined_members: (await this.hs.rooms.joinedMembers(r.room_id)).length,
        })),
      ),
      total: rows.length,
    };
  }

  /** Remove everyone from a room, delist it and drop its aliases. With `purge`, also delete its history. */
  async deleteRoom(roomId: string, opts: { actor?: string; reason?: string; purge?: boolean } = {}): Promise<{ kicked: string[] }> {
    if (!(await this.hs.rooms.exists(roomId))) throw errors.notFound("Unknown room");
    const kicked: string[] = [];
    for (const membership of ["join", "invite", "knock"]) {
      for (const row of await this.hs.db.findMany("memberships", {
        where: [
          { field: "room_id", value: roomId },
          { field: "membership", value: membership },
        ],
      })) {
        if (!this.hs.isLocalUser(row.user_id)) continue;
        try {
          // Members leave on their own behalf, which is always allowed.
          await this.hs.rooms.setMembership(roomId, row.user_id, row.user_id, "leave", opts.reason);
          kicked.push(row.user_id);
        } catch (err) {
          this.hs.logger.warn("Could not remove", row.user_id, "from", roomId, err);
        }
      }
    }
    await this.hs.db.update("rooms", [{ field: "room_id", value: roomId }], { is_public: false });
    await this.hs.db.delete("room_aliases", [{ field: "room_id", value: roomId }]);
    if (opts.purge) {
      const where = [{ field: "room_id", value: roomId }];
      await this.hs.transaction(async (db) => {
        for (const table of [
          "events",
          "state_snapshots",
          "current_state",
          "memberships",
          "receipts",
          "relations",
          "notifications",
          "rooms",
        ]) {
          await db.delete(table, where);
        }
      });
      this.hs.rooms.forgetRoom(roomId);
    }
    return { kicked };
  }

  // --- Media --------------------------------------------------------------------

  async deleteMedia(mediaId: string): Promise<void> {
    await this.hs.media.delete?.(mediaId);
    await this.hs.db.delete("media", [{ field: "media_id", value: mediaId }]);
  }

  /** Delete local media uploaded before `beforeTs`. Returns the deleted media IDs. */
  async purgeMediaBefore(beforeTs: number): Promise<string[]> {
    const rows = await this.hs.db.findMany("media", { where: [{ field: "created_ts", operator: "lt", value: beforeTs }] });
    for (const r of rows) await this.deleteMedia(r.media_id);
    return rows.map((r) => r.media_id);
  }

  // --- Server notices -------------------------------------------------------------

  get noticeUserId(): string {
    return `@${this.hs.config.serverNotices.localpart}:${this.hs.serverName}`;
  }

  /** Whether `roomId` is a server notices room (members may not reject or leave its invites). */
  async isNoticeRoom(roomId: string): Promise<boolean> {
    const room = await this.hs.db.findOne("rooms", [{ field: "room_id", value: roomId }]);
    return room?.creator === this.noticeUserId;
  }

  /** Send a message to a user in their server notices room, creating or re-inviting as needed. */
  async sendServerNotice(userId: string, content: Record<string, any>, opts: { type?: string; txnId?: string } = {}): Promise<string> {
    if (!isValidUserId(userId) || !this.hs.isLocalUser(userId)) throw errors.invalidParam("Server notices can only be sent to local users");
    if (!(await this.hs.db.findOne("users", [{ field: "user_id", value: userId }]))) throw errors.notFound("Unknown user");
    const txnKey = opts.txnId ? `notice-txn:${userId}|${opts.txnId}` : null;
    if (txnKey) {
      const existing = await this.hs.cluster.get<string>(txnKey);
      if (existing) return existing;
    }

    const noticeUser = this.noticeUserId;
    if (!(await this.hs.db.findOne("users", [{ field: "user_id", value: noticeUser }]))) {
      await createUser(this.hs, noticeUser.slice(1).split(":")[0], { displayname: this.hs.config.serverNotices.displayName });
    }
    const roomId = await this.noticeRoomFor(userId);
    const membership = await this.hs.rooms.membership(roomId, userId);
    if (membership !== "join" && membership !== "invite") await this.hs.rooms.invite(roomId, noticeUser, userId);
    const eventId = await this.hs.rooms.sendEvent(roomId, noticeUser, { type: opts.type ?? M.ROOM.MESSAGE, content });
    if (txnKey) await this.hs.cluster.set(txnKey, eventId, 24 * 3600_000);
    return eventId;
  }

  private async noticeRoomFor(userId: string): Promise<string> {
    const noticeUser = this.noticeUserId;
    const rooms = await this.hs.db.findMany("rooms", { where: [{ field: "creator", value: noticeUser }] });
    for (const room of rooms) {
      const tag = await this.hs.db.findOne("account_data", [
        { field: "user_id", value: userId },
        { field: "room_id", value: room.room_id },
        { field: "type", value: M.TAG },
      ]);
      if (tag?.content?.tags?.[M.SERVER_NOTICE]) return room.room_id;
    }
    const { room_id } = await this.hs.rooms.createRoom(noticeUser, {
      preset: "private_chat",
      name: this.hs.config.serverNotices.roomName,
      power_level_content_override: { users: { [noticeUser]: 100 }, events_default: 100 },
    });
    await this.hs.streams.write((stream) =>
      this.hs.db.upsert("account_data", {
        user_id: userId,
        room_id,
        type: M.TAG,
        content: { tags: { [M.SERVER_NOTICE]: { order: 0.5 } } },
        stream,
      }),
    );
    // The tag is account data: wake the user's sync for it (#50).
    this.hs.notifier.notify([userId]);
    return room_id;
  }
}
