import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** One recorded event, as written to the archive (one JSON object per line). */
export interface AuditRecord {
  /** When the bot recorded it (ms). */
  recorded_at: number;
  room_id: string;
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  state_key?: string;
  /** The content as the room's members see it: decrypted for end-to-end encrypted events. */
  content: Record<string, unknown>;
  redacts?: string;
  /** The event was end-to-end encrypted. */
  encrypted: boolean;
  /** For encrypted events: the sending device, as the room key says. */
  sender_device?: string;
  /** The event could not be decrypted (no room key reached the bot); `content` is the ciphertext. */
  decryption_error?: string;
  /** Part of the room's state when the bot joined, not a new event. */
  initial_state?: boolean;
}

/** Where records go. Writes for one room come in order; a write that throws is retried. */
export interface AuditSink {
  write(records: AuditRecord[]): Promise<void>;
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * JSON Lines files: `{directory}/{room ID}/{YYYY-MM-DD}.jsonl`, one file per room and UTC day of
 * the event. Room IDs are percent-encoded, so they cannot name a path outside the directory.
 */
export function fileSink(directory: string): AuditSink {
  return {
    async write(records) {
      const byFile = new Map<string, string[]>();
      for (const r of records) {
        const file = join(directory, encodeURIComponent(r.room_id), `${day(r.origin_server_ts)}.jsonl`);
        byFile.set(file, [...(byFile.get(file) ?? []), JSON.stringify(r)]);
      }
      for (const [file, lines] of byFile) {
        await mkdir(join(file, ".."), { recursive: true });
        await appendFile(file, `${lines.join("\n")}\n`);
      }
    },
  };
}

/** Records kept in memory (tests, or a custom forwarder that reads `records`). */
export function memorySink(): AuditSink & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    async write(batch) {
      records.push(...batch);
    },
  };
}
