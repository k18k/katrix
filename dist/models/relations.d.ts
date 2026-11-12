import { RelatesTo } from "../shared/events.js";
import { MatrixEvent } from "./event.js";
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
export declare function relationOf(event: MatrixEvent): RelatesTo | undefined;
/**
 * The relations among a room's events that arrived on this client: edits
 * (https://spec.matrix.org/v1.19/client-server-api/#event-replacements), reactions
 * (https://spec.matrix.org/v1.19/client-server-api/#event-annotations-and-reactions), thread
 * replies and references. Relations whose target is not loaded are kept too: the target may be
 * paginated in later.
 */
export declare class Relations {
  private readonly myUserId;
  private readonly replacements;
  private readonly annotations;
  private readonly threads;
  private readonly refs;
  constructor(myUserId: string);
  private mapFor;
  /** Index an event by the relation it declares. Returns the target's event ID if it has one. */
  add(event: MatrixEvent): string | undefined;
  /** Drop an event (redacted, or removed from the timeline). Returns the target's event ID. */
  remove(event: MatrixEvent): string | undefined;
  /**
   * The edit to show for an event: the newest valid replacement. Encrypted replacements count
   * once decrypted, since their type and `m.new_content` are inside. A server-bundled
   * replacement (unsigned m.relations) is used when no edit arrived here.
   */
  replacementFor(original: MatrixEvent, bundled?: MatrixEvent): MatrixEvent | undefined;
  /** Reactions on an event, grouped by key, most used first. */
  reactions(eventId: string): ReactionGroup[];
  /** The thread replies that arrived here, oldest first. */
  threadReplies(rootId: string): MatrixEvent[];
  /** Events that reference this one (m.reference: key verification in rooms, poll responses). */
  references(eventId: string): MatrixEvent[];
  /** IDs of the thread roots seen in this room. */
  threadRoots(): string[];
}
/** The spec's validity rules for a replacement (https://spec.matrix.org/v1.19/client-server-api/#validity-of-replacement-events). */
export declare function isValidReplacement(original: MatrixEvent, replacement: MatrixEvent): boolean;
//# sourceMappingURL=relations.d.ts.map