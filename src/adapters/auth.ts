import { hashPassword, verifyPassword } from "../core/crypto.ts";

export interface PasswordCheckContext {
  userId: string;
  localpart: string;
  password: string;
  /** The password hash stored by the homeserver, if any. */
  storedHash: string | null;
}

/**
 * Controls how users authenticate. Every member is optional; omitted members
 * fall back to built-in behaviour (scrypt password hashes stored in the database).
 */
export interface UserAuthAdapter {
  /** Whether new accounts may be created via `/register`. Default: false. */
  registrationEnabled?: boolean;
  /** Require a registration token (`m.login.registration_token`) to register. Default: false. */
  registrationRequiresToken?: boolean;
  /** Whether `m.login.password` is offered. Default: true. */
  passwordLoginEnabled?: boolean;
  /** Whether guest accounts may be created. Default: false. */
  guestAccessEnabled?: boolean;
  /** Verify credentials for `m.login.password`. Return `true`/`false`. */
  checkPassword?(ctx: PasswordCheckContext): Promise<boolean>;
  /** Hash a password for storage. */
  hashPassword?(password: string): Promise<string>;
  /**
   * Called when an unknown user logs in successfully through `checkPassword`
   * (e.g. LDAP). Return true to auto-provision the account.
   */
  autoProvision?(userId: string): Promise<boolean>;
  /** Hook fired after a new account has been created. */
  onUserRegistered?(userId: string): Promise<void>;
  /** Optional validation of usernames beyond the Matrix grammar. Throw or return false to reject. */
  validateUsername?(localpart: string): Promise<boolean>;
  /** Optional password policy. Return an error message to reject. */
  validatePassword?(password: string): Promise<string | null>;
}

export interface ResolvedUserAuth {
  registrationEnabled: boolean;
  registrationRequiresToken: boolean;
  passwordLoginEnabled: boolean;
  guestAccessEnabled: boolean;
  checkPassword(ctx: PasswordCheckContext): Promise<boolean>;
  hashPassword(password: string): Promise<string>;
  autoProvision(userId: string): Promise<boolean>;
  onUserRegistered(userId: string): Promise<void>;
  validateUsername(localpart: string): Promise<boolean>;
  validatePassword(password: string): Promise<string | null>;
}

export function resolveUserAuth(adapter: UserAuthAdapter = {}): ResolvedUserAuth {
  return {
    registrationEnabled: adapter.registrationEnabled ?? false,
    registrationRequiresToken: adapter.registrationRequiresToken ?? false,
    passwordLoginEnabled: adapter.passwordLoginEnabled ?? true,
    guestAccessEnabled: adapter.guestAccessEnabled ?? false,
    checkPassword:
      adapter.checkPassword?.bind(adapter) ??
      (async ({ password, storedHash }) => (storedHash ? verifyPassword(password, storedHash) : false)),
    hashPassword: adapter.hashPassword?.bind(adapter) ?? hashPassword,
    autoProvision: adapter.autoProvision?.bind(adapter) ?? (async () => false),
    onUserRegistered: adapter.onUserRegistered?.bind(adapter) ?? (async () => {}),
    validateUsername: adapter.validateUsername?.bind(adapter) ?? (async () => true),
    validatePassword: adapter.validatePassword?.bind(adapter) ?? (async () => null),
  };
}
