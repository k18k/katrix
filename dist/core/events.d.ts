export interface PDU {
  event_id?: string;
  room_id: string;
  sender: string;
  type: string;
  state_key?: string;
  content: Record<string, any>;
  origin_server_ts: number;
  depth: number;
  prev_events: any[];
  auth_events: any[];
  redacts?: string;
  hashes?: {
    sha256: string;
  };
  signatures?: Record<string, Record<string, string>>;
  unsigned?: Record<string, any>;
  origin?: string;
}
export interface ClientEvent {
  event_id: string;
  room_id?: string;
  sender: string;
  type: string;
  state_key?: string;
  content: Record<string, any>;
  origin_server_ts: number;
  unsigned?: Record<string, any>;
  redacts?: string;
}
//# sourceMappingURL=events.d.ts.map