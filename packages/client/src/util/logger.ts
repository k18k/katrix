import { platformConsole } from "../platform.ts";

/**
 * The SDK logs through this interface only. What it logs never contains secrets: no access or
 * refresh tokens, passwords, private keys, session keys, pickles, plaintexts or ciphertexts. IDs
 * (user, device, room, event, session) and public keys may appear. Tests check this
 * (test/integration/secrets.test.ts).
 */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function consoleLogger(prefix = "[matrix]"): Logger {
  const c = platformConsole();
  if (!c) return noopLogger;
  const line = (m: string, d?: Record<string, unknown>) => (d ? [prefix, m, d] : [prefix, m]);
  return {
    debug: (m, d) => c.debug(...line(m, d)),
    info: (m, d) => c.info(...line(m, d)),
    warn: (m, d) => c.warn(...line(m, d)),
    error: (m, d) => c.error(...line(m, d)),
  };
}

/** A safe summary of an error for a log line: its class, code and message, never a stack of data. */
export function describeError(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    const code = (e as { code?: unknown; errcode?: unknown }).errcode ?? (e as { code?: unknown }).code;
    return { error: e.name, ...(code !== undefined ? { code } : {}), message: e.message };
  }
  return { error: typeof e };
}
