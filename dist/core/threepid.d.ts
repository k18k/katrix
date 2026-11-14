import { Homeserver } from "../homeserver.js";
export type Medium = "email" | "msisdn";
export type ThreepidPurpose = "register" | "password_reset" | "add_threepid";
export interface ThreepidEmail {
  to: string;
  purpose: ThreepidPurpose;
  subject: string;
  text: string;
  html: string;
  /** Opening this link validates the address. */
  link: string;
  token: string;
}
export interface ThreepidSms {
  /** MSISDN (international format, digits only). */
  to: string;
  purpose: ThreepidPurpose;
  text: string;
  /** Short code the user types into the client. */
  token: string;
}
export interface ThreepidOptions {
  /** Sends validation emails. Without it, email addresses cannot be added or used to register. */
  sendEmail?: (message: ThreepidEmail) => Promise<void>;
  /** Sends validation SMS messages. Without it, phone numbers cannot be added. */
  sendSms?: (message: ThreepidSms) => Promise<void>;
  /** Registration requires a validated email address. Needs `sendEmail`. */
  requireEmailForRegistration?: boolean;
  /** How long a validation session stays usable, in ms. Default: 24 hours. */
  sessionLifetimeMs?: number;
  /** Scheme used to reach identity servers. Default: "https" ("http" is for tests only). */
  identityServerProtocol?: "https" | "http";
}
export interface Threepid {
  medium: Medium;
  address: string;
}
export declare class ThreepidService {
  private readonly hs;
  constructor(hs: Homeserver);
  private get options();
  /** Whether this server can validate addresses of `medium` itself. */
  canValidate(medium: Medium): boolean;
  /** Account changes involving 3PIDs are possible at all (the m.3pid_changes capability). */
  get enabled(): boolean;
  userFor(medium: Medium, address: string): Promise<any>;
  list(userId: string): Promise<{
    medium: any;
    address: any;
    validated_at: any;
    added_at: any;
  }[]>;
  add(userId: string, threepid: Threepid & {
    validatedTs: number;
  }): Promise<void>;
  remove(userId: string, medium: Medium, address: string): Promise<boolean>;
  /**
   * Unbind a 3PID from the identity servers it was bound on through this server (or `idServer`).
   * Returns "success" if every unbind succeeded, "no-support" otherwise.
   */
  unbindAll(userId: string, medium: string, address: string, idServer?: string): Promise<"no-support" | "success">;
  /** Remove every 3PID of a (deactivated) account, unbinding them from identity servers. */
  removeAll(userId: string): Promise<"no-support" | "success">;
  /**
   * Start (or continue) validating an address: `POST .../{medium}/requestToken`. Repeating a
   * request with the same `client_secret`, address and `send_attempt` does not send again.
   */
  requestToken(purpose: ThreepidPurpose, medium: Medium, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  private tokenResponse;
  private send;
  private expired;
  /** Validate a session with the token the user received. Returns the session's `next_link`. */
  submitToken(sid: string, clientSecret: string, token: string): Promise<any>;
  /** The address a client proved ownership of, given its `threepid_creds`. */
  validated(creds: unknown): Promise<{
    medium: any;
    address: any;
    validatedTs: any;
  } | null>;
}
//# sourceMappingURL=threepid.d.ts.map