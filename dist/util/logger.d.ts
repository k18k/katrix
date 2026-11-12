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
export declare const noopLogger: Logger;
export declare function consoleLogger(prefix?: string): Logger;
//# sourceMappingURL=logger.d.ts.map