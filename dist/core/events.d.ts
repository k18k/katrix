/** A reference to an event: its ID, or in room versions 1 and 2 the pair of ID and hashes. */
export type EventRef = string | readonly [string, unknown];
export interface PDU {
  event_id?: string;
  room_id: string;
  sender: string;
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
  origin_server_ts: number;
  depth: number;
  prev_events: EventRef[];
  auth_events: EventRef[];
  redacts?: string;
  hashes?: {
    sha256: string;
  };
  signatures?: Record<string, Record<string, string>>;
  unsigned?: Record<string, unknown>;
  origin?: string;
}
export interface ClientEvent {
  event_id: string;
  room_id?: string;
  sender: string;
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
  origin_server_ts: number;
  unsigned?: Record<string, unknown>;
  redacts?: string;
}
//# sourceMappingURL=events.d.ts.map