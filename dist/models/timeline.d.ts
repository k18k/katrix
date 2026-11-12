import { MatrixEvent } from "./event.js";
/**
 * The live timeline of a room: events in order, oldest first, and the token to paginate further
 * back from the oldest. A gappy sync (`limited`) starts a new live segment: the events before the
 * gap are dropped, as their order relative to the new ones is unknown; paginating back from the
 * new segment's token fills it in again.
 */
export declare class Timeline {
  events: MatrixEvent[];
  /** Token for /messages?dir=b from the oldest event; undefined when at the room's start. */
  backToken?: string;
  /** Whether the room's creation was reached. */
  atStart: boolean;
  private byId;
  /** Events kept in memory; older ones are dropped and can be paginated again. */
  maxEvents: number;
  constructor(maxEvents?: number);
  find(eventId: string): MatrixEvent | undefined;
  /** Append live events. Returns those that were new (not already present by event ID). */
  append(events: MatrixEvent[]): MatrixEvent[];
  /** Prepend older events (from back-pagination, given newest first as /messages returns them). */
  prepend(newestFirst: MatrixEvent[], nextBackToken: string | undefined): MatrixEvent[];
  /** A gap: start over with a new segment. */
  reset(backToken: string | undefined): void;
  /** Replace a local echo by its event ID once the server confirmed it. */
  index(event: MatrixEvent): void;
  remove(event: MatrixEvent): void;
}
//# sourceMappingURL=timeline.d.ts.map