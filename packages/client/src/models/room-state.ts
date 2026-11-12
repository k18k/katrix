import { MatrixEvent } from "./event.ts";
import type { EventContentMap, Membership, PowerLevelsContent, ClientEvent } from "@katrix/shared";

export interface RoomMember {
  userId: string;
  membership: Membership;
  /** The display name as set in the member event (may be missing or shared with others). */
  rawDisplayName?: string;
  /** A name to show: unique in the room (spec "Calculating the display name for a user"). */
  name: string;
  avatarUrl?: string;
  powerLevel: number;
}

/** The current state of a room: the latest state event per (type, state_key). */
export class RoomState {
  private events = new Map<string, Map<string, MatrixEvent>>();
  /** For lazy-loaded member lists: whether all members have been fetched once. */
  membersLoaded = false;

  get<K extends keyof EventContentMap>(type: K, stateKey?: string): MatrixEvent<K> | undefined;
  get(type: string, stateKey?: string): MatrixEvent | undefined;
  get(type: string, stateKey = ""): MatrixEvent | undefined {
    return this.events.get(type)?.get(stateKey);
  }

  getAll(type: string): MatrixEvent[] {
    return [...(this.events.get(type)?.values() ?? [])];
  }

  /** Every state event (for persisting). */
  all(): MatrixEvent[] {
    const out: MatrixEvent[] = [];
    for (const m of this.events.values()) out.push(...m.values());
    return out;
  }

  /** Set a state event; returns the event it replaced. */
  set(event: MatrixEvent): MatrixEvent | undefined {
    if (event.stateKey === undefined) return undefined;
    let m = this.events.get(event.wire.type);
    if (!m) this.events.set(event.wire.type, (m = new Map()));
    const previous = m.get(event.stateKey);
    m.set(event.stateKey, event);
    return previous;
  }

  setRaw(raw: ClientEvent): MatrixEvent | undefined {
    return this.set(new MatrixEvent(raw));
  }

  clear(): void {
    this.events.clear();
    this.membersLoaded = false;
  }

  membership(userId: string): Membership | undefined {
    return this.get("m.room.member", userId)?.content.membership;
  }

  powerLevels(): PowerLevelsContent {
    return this.get("m.room.power_levels")?.content ?? {};
  }

  /**
   * A user's power level. Without m.room.power_levels the creator has 100 and everyone else 0
   * (https://spec.matrix.org/v1.16/client-server-api/#mroompower_levels). Room version 12 makes
   * the creators' power infinite; they show as Infinity.
   */
  powerLevel(userId: string): number {
    const create = this.get("m.room.create");
    const version = create?.content.room_version;
    if (version === "12" || (version?.startsWith("org.matrix.hydra") ?? false)) {
      const additional = (create?.content as { additional_creators?: string[] } | undefined)?.additional_creators ?? [];
      if (create?.sender === userId || additional.includes(userId)) return Infinity;
    }
    const pl = this.get("m.room.power_levels")?.content;
    if (!pl) return create?.sender === userId || create?.content.creator === userId ? 100 : 0;
    return pl.users?.[userId] ?? pl.users_default ?? 0;
  }

  /** Whether `userId` may send `type` (state or message) by the power levels. */
  maySend(userId: string, type: string, state: boolean): boolean {
    const pl = this.powerLevels();
    const required =
      pl.events?.[type] ?? (state ? (this.get("m.room.power_levels") ? (pl.state_default ?? 50) : 0) : (pl.events_default ?? 0));
    return this.powerLevel(userId) >= required;
  }

  members(): RoomMember[] {
    const events = this.getAll("m.room.member") as Array<MatrixEvent<"m.room.member">>;
    // Disambiguate display names shared by joined or invited members (spec 'Calculating the
    // display name for a user'): "name (@user:server)".
    const counts = new Map<string, number>();
    for (const e of events) {
      const name = e.content.displayname;
      if (name && (e.content.membership === "join" || e.content.membership === "invite")) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return events.map((e) => {
      const userId = e.stateKey!;
      const raw = typeof e.content.displayname === "string" && e.content.displayname.trim() ? e.content.displayname : undefined;
      const ambiguous = raw !== undefined && (counts.get(raw) ?? 0) > 1;
      // A display name that looks like a user ID is disambiguated too, so nobody can pose as one.
      const looksLikeId = raw !== undefined && raw.startsWith("@") && raw.includes(":");
      return {
        userId,
        membership: e.content.membership,
        rawDisplayName: raw,
        name: raw === undefined ? userId : ambiguous || looksLikeId ? `${raw} (${userId})` : raw,
        avatarUrl: e.content.avatar_url ?? undefined,
        powerLevel: this.powerLevel(userId),
      };
    });
  }

  member(userId: string): RoomMember | undefined {
    return this.members().find((m) => m.userId === userId);
  }

  isEncrypted(): boolean {
    return this.get("m.room.encryption") !== undefined;
  }
}
