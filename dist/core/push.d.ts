import { ClientEvent } from "./events.js";
import { StateMap } from "./authrules.js";
import { StoredEvent } from "./rooms.js";
import { Homeserver } from "../homeserver.js";
import { Row } from "../storage/types.js";
/**
 * Push rule evaluation and push gateway delivery. Every new event is evaluated for
 * every local member; matches are stored for unread counts and `/notifications`.
 */
type Counts = {
  notification_count: number;
  highlight_count: number;
};
export interface UnreadCounts {
  readonly room: Readonly<Counts>;
  readonly threads: Readonly<Record<string, Readonly<Counts>>>;
}
export declare class PushService {
  private hs;
  constructor(hs: Homeserver);
  onEvent(ev: StoredEvent, state: StateMap, version: string): Promise<void>;
  /** Unread notification counts since the user's read receipts. */
  /** Stream positions up to which the user has read the room (unthreaded) and each thread. */
  private readPositions;
  isRead(row: Row, read: {
    unthreaded: number;
    threads: Map<string, number>;
  }): boolean;
  unreadCounts(userId: string, roomId: string): Promise<UnreadCounts>;
  private countUnread;
  private deliver;
  /** Rows for `GET /notifications`. */
  list(userId: string, opts: {
    from: number | null;
    limit: number;
    onlyHighlight: boolean;
  }): Promise<{
    actions: any;
    event: ClientEvent;
    room_id: any;
    ts: any;
    read: boolean;
    stream: any;
  }[]>;
}
export {};
//# sourceMappingURL=push.d.ts.map