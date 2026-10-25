import type { MatrixEvent } from "./event.ts";
import type { RelatesTo } from "@katrix/shared";

/** One reaction key on an event, with who reacted. */
export interface ReactionGroup {
  key: string;
  count: number;
  senders: string[];
  /** This user's reaction event with this key, to redact it ("un-react"). */
  myEventId?: string;
}

/** What is known about a thread (https://spec.matrix.org/v1.19/client-server-api/#threading). */
export interface ThreadSummary {
  rootId: string;
  /** Replies the server counted (bundled aggregation), or that arrived here, whichever is more. */
  count: number;
  latestEvent?: MatrixEvent;
  participated: boolean;
}

/** The relation an event declares (in the clear part of encrypted events, as the spec requires). */
export function relationOf(event: MatrixEvent): RelatesTo | undefined {
  const rel =
    (event.content as { "m.relates_to"?: RelatesTo })["m.relates_to"] ??
    (event.wire.content as { "m.relates_to"?: RelatesTo })["m.relates_to"];
  return typeof rel === "object" && rel !== null ? rel : undefined;
}

/** Spec ordering of replacements: the latest by origin_server_ts, ties broken by the larger event ID. */
function newer(a: MatrixEvent, b: MatrixEvent): boolean {
  const ta = a.originServerTs ?? 0;
  const tb = b.originServerTs ?? 0;
  return ta !== tb ? ta > tb : (a.eventId ?? "") > (b.eventId ?? "");
}

/**
 * The relations among a room's events that arrived on this client: edits
 * (https://spec.matrix.org/v1.19/client-server-api/#event-replacements), reactions
 * (https://spec.matrix.org/v1.19/client-server-api/#event-annotations-and-reactions), thread
 * replies and references. Relations whose target is not loaded are kept too: the target may be
 * paginated in later.
 */
export class Relations {
  private readonly myUserId: string;
  private readonly replacements = new Map<string, Set<MatrixEvent>>();
  private readonly annotations = new Map<string, Set<MatrixEvent>>();
  private readonly threads = new Map<string, Set<MatrixEvent>>();
  private readonly refs = new Map<string, Set<MatrixEvent>>();

  constructor(myUserId: string) {
    this.myUserId = myUserId;
  }

  private mapFor(relType: string | undefined): Map<string, Set<MatrixEvent>> | undefined {
    switch (relType) {
      case "m.replace":
        return this.replacements;
      case "m.annotation":
        return this.annotations;
      case "m.thread":
        return this.threads;
      case "m.reference":
        return this.refs;
    }
    return undefined;
  }

  /** Index an event by the relation it declares. Returns the target's event ID if it has one. */
  add(event: MatrixEvent): string | undefined {
    const rel = relationOf(event);
    const target = rel?.event_id;
    const map = this.mapFor(rel?.rel_type);
    if (!map || typeof target !== "string" || event.isRedacted()) return undefined;
    let set = map.get(target);
    if (!set) map.set(target, (set = new Set()));
    set.add(event);
    return target;
  }

  /** Drop an event (redacted, or removed from the timeline). Returns the target's event ID. */
  remove(event: MatrixEvent): string | undefined {
    const rel = relationOf(event);
    const target = rel?.event_id;
    if (typeof target !== "string") return undefined;
    const map = this.mapFor(rel?.rel_type);
    map?.get(target)?.delete(event);
    return target;
  }

  /**
   * The edit to show for an event: the newest valid replacement. Encrypted replacements count
   * once decrypted, since their type and `m.new_content` are inside. A server-bundled
   * replacement (unsigned m.relations) is used when no edit arrived here.
   */
  replacementFor(original: MatrixEvent, bundled?: MatrixEvent): MatrixEvent | undefined {
    if (!original.eventId || !isEditable(original)) return undefined;
    let best: MatrixEvent | undefined;
    const candidates = [...(this.replacements.get(original.eventId) ?? [])];
    if (bundled) candidates.push(bundled);
    for (const r of candidates) if (isValidReplacement(original, r) && (!best || newer(r, best))) best = r;
    return best;
  }

  /** Reactions on an event, grouped by key, most used first. */
  reactions(eventId: string): ReactionGroup[] {
    const groups = new Map<string, ReactionGroup>();
    // One reaction per (sender, key): a client that sends the same reaction twice counts once.
    const seen = new Set<string>();
    for (const e of this.annotations.get(eventId) ?? []) {
      if (e.type !== "m.reaction" || e.isRedacted() || !e.sender) continue;
      const key = relationOf(e)?.key;
      if (typeof key !== "string" || seen.has(`${e.sender}\u0000${key}`)) continue;
      seen.add(`${e.sender}\u0000${key}`);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, count: 0, senders: [] }));
      g.count++;
      g.senders.push(e.sender);
      if (e.sender === this.myUserId && e.eventId) g.myEventId = e.eventId;
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  }

  /** The thread replies that arrived here, oldest first. */
  threadReplies(rootId: string): MatrixEvent[] {
    return [...(this.threads.get(rootId) ?? [])].filter((e) => !e.isRedacted()).sort((a, b) => (newer(a, b) ? 1 : -1));
  }

  /** Events that reference this one (m.reference: key verification in rooms, poll responses). */
  references(eventId: string): MatrixEvent[] {
    return [...(this.refs.get(eventId) ?? [])].filter((e) => !e.isRedacted());
  }

  /** IDs of the thread roots seen in this room. */
  threadRoots(): string[] {
    return [...this.threads.keys()];
  }
}

/** Whether an event can be edited at all: not state, and not an edit itself. */
function isEditable(event: MatrixEvent): boolean {
  return !event.isState() && relationOf(event)?.rel_type !== "m.replace";
}

/** The spec's validity rules for a replacement (https://spec.matrix.org/v1.19/client-server-api/#validity-of-replacement-events). */
export function isValidReplacement(original: MatrixEvent, replacement: MatrixEvent): boolean {
  if (replacement.isRedacted() || replacement.isState()) return false;
  if (replacement.isEncrypted() && replacement.decryptionStatus !== "decrypted") return false;
  const newContent = (replacement.content as { "m.new_content"?: unknown })["m.new_content"];
  return (
    isEditable(original) &&
    replacement.sender === original.sender &&
    (replacement.roomId === undefined || original.roomId === undefined || replacement.roomId === original.roomId) &&
    replacement.type === original.type &&
    typeof newContent === "object" &&
    newContent !== null
  );
}
