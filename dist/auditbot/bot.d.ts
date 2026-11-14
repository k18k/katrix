import { Homeserver } from "../homeserver.js";
import { AuditSink } from "./sinks.js";
export interface AuditBotOptions {
  /** Where the records go: `fileSink(dir)`, or your own. */
  sink: AuditSink;
  /**
   * Directory for the bot's state: its crypto store (room keys, device keys) and the sync
   * position. Losing it loses the keys of encrypted rooms, so keep it on a persistent volume and
   * back it up.
   */
  dataDir: string;
  /** Encrypts the crypto store. Required; keep it with the backups of `dataDir`. */
  storePassphrase: string;
  /** Default "auditbot". */
  localpart?: string;
  /** The bot's name in member lists. Default "Audit log (this room is recorded)". */
  displayName?: string;
  /** "all" rooms, or "groups": not direct messages (rooms created with is_direct). Default "all". */
  rooms?: "all" | "groups";
  /** How often to look for rooms it is not in yet, in ms. Default 10 minutes. */
  sweepIntervalMs?: number;
  /** How long a new room has to be quiet before the bot joins it, in ms. Default 500. */
  joinDelayMs?: number;
  /** How long an undecryptable event waits for its room key before it is recorded as such. Default 1 hour. */
  keyWaitMs?: number;
}
export interface AuditBot {
  userId: string;
  /** Resolves once the bot has synced up to now (tests). */
  synced(): Promise<void>;
  /** Join every room it is not in yet (it also does this on its own). */
  sweep(): Promise<void>;
  stop(): Promise<void>;
}
export declare function startAuditBot(hs: Homeserver, options: AuditBotOptions): Promise<{
  userId: string;
  sweep: () => Promise<void>;
  synced(): Promise<void>;
  stop(): Promise<void>;
}>;
//# sourceMappingURL=bot.d.ts.map