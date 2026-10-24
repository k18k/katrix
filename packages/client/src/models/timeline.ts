import type { MatrixEvent } from "./event.ts";

/**
 * The live timeline of a room: events in order, oldest first, and the token to paginate further
 * back from the oldest. A gappy sync (`limited`) starts a new live segment: the events before the
 * gap are dropped, as their order relative to the new ones is unknown; paginating back from the
 * new segment's token fills it in again.
 */
export class Timeline {
  events: MatrixEvent[] = [];
  /** Token for /messages?dir=b from the oldest event; undefined when at the room's start. */
  backToken?: string;
  /** Whether the room's creation was reached. */
  atStart = false;
  private byId = new Map<string, MatrixEvent>();
  /** Events kept in memory; older ones are dropped and can be paginated again. */
  maxEvents: number;

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
  }

  find(eventId: string): MatrixEvent | undefined {
    return this.byId.get(eventId);
  }

  /** Append live events. Returns those that were new (not already present by event ID). */
  append(events: MatrixEvent[]): MatrixEvent[] {
    const added: MatrixEvent[] = [];
    for (const e of events) {
      if (e.eventId && this.byId.has(e.eventId)) continue;
      this.events.push(e);
      if (e.eventId) this.byId.set(e.eventId, e);
      added.push(e);
    }
    if (this.events.length > this.maxEvents) {
      for (const dropped of this.events.splice(0, this.events.length - this.maxEvents))
        if (dropped.eventId) this.byId.delete(dropped.eventId);
      this.atStart = false;
      // Without the dropped events, the old back token no longer points at the oldest one kept.
      this.backToken = undefined;
    }
    return added;
  }

  /** Prepend older events (from back-pagination, given newest first as /messages returns them). */
  prepend(newestFirst: MatrixEvent[], nextBackToken: string | undefined): MatrixEvent[] {
    const added: MatrixEvent[] = [];
    for (const e of newestFirst) {
      if (e.eventId && this.byId.has(e.eventId)) continue;
      this.events.unshift(e);
      if (e.eventId) this.byId.set(e.eventId, e);
      added.push(e);
    }
    this.backToken = nextBackToken;
    if (nextBackToken === undefined) this.atStart = true;
    return added;
  }

  /** A gap: start over with a new segment. */
  reset(backToken: string | undefined): void {
    this.events = [];
    this.byId.clear();
    this.backToken = backToken;
    this.atStart = false;
  }

  /** Replace a local echo by its event ID once the server confirmed it. */
  index(event: MatrixEvent): void {
    if (event.eventId) this.byId.set(event.eventId, event);
  }

  remove(event: MatrixEvent): void {
    const i = this.events.indexOf(event);
    if (i >= 0) this.events.splice(i, 1);
    if (event.eventId) this.byId.delete(event.eventId);
  }
}
