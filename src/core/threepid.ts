import { randomInt } from "node:crypto";
import { MatrixError, errors } from "./errors.ts";
import { randomString } from "./crypto.ts";
import { toMsisdn } from "./phone.ts";
import type { Homeserver } from "../homeserver.ts";

// Third-party identifiers (email addresses and phone numbers) validated by this homeserver: it
// sends a token through the host application's `threepid.sendEmail`/`sendSms`, and the user proves
// ownership by submitting it (a link in the email, or a code typed into the client).

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

const CLIENT_SECRET_RE = /^[0-9a-zA-Z.=_-]{1,255}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SUBMIT_PATH = "/_matrix/client/unstable/threepid/submit_token";

const PURPOSE_TEXT: Record<ThreepidPurpose, string> = {
  register: "create your account",
  password_reset: "reset your password",
  add_threepid: "add this address to your account",
};

export function isMedium(m: unknown): m is Medium {
  return m === "email" || m === "msisdn";
}

/** Canonical form of an address: lower-case email, digits-only phone number. */
export function canonicalAddress(medium: Medium, address: string): string | null {
  if (medium === "email") {
    const email = address.trim().toLowerCase();
    return EMAIL_RE.test(email) && email.length <= 320 ? email : null;
  }
  const msisdn = address.replace(/^\+/, "");
  return /^\d{7,15}$/.test(msisdn) ? msisdn : null;
}

export class ThreepidService {
  private readonly hs: Homeserver;

  constructor(hs: Homeserver) {
    this.hs = hs;
  }

  private get options() {
    return this.hs.config.threepid;
  }

  /** Whether this server can validate addresses of `medium` itself. */
  canValidate(medium: Medium): boolean {
    return medium === "email" ? !!this.options.sendEmail : !!this.options.sendSms;
  }

  /** Account changes involving 3PIDs are possible at all (the m.3pid_changes capability). */
  get enabled(): boolean {
    return this.canValidate("email") || this.canValidate("msisdn");
  }

  async userFor(medium: Medium, address: string): Promise<string | null> {
    const row = await this.hs.db.findOne("user_threepids", [{ field: "medium", value: medium }, { field: "address", value: address }]);
    return row?.user_id ?? null;
  }

  async list(userId: string): Promise<{ medium: string; address: string; validated_at: number; added_at: number }[]> {
    const rows = await this.hs.db.findMany("user_threepids", { where: [{ field: "user_id", value: userId }] });
    return rows.map((r) => ({ medium: r.medium, address: r.address, validated_at: r.validated_ts, added_at: r.added_ts }));
  }

  async add(userId: string, threepid: Threepid & { validatedTs: number }): Promise<void> {
    const owner = await this.userFor(threepid.medium, threepid.address);
    if (owner && owner !== userId) throw new MatrixError(400, "M_THREEPID_IN_USE", "This address is already in use");
    await this.hs.db.upsert("user_threepids", {
      user_id: userId, medium: threepid.medium, address: threepid.address, validated_ts: threepid.validatedTs, added_ts: Date.now(),
    });
  }

  async remove(userId: string, medium: Medium, address: string): Promise<boolean> {
    return (await this.hs.db.delete("user_threepids", [{ field: "user_id", value: userId }, { field: "medium", value: medium }, { field: "address", value: address }])) > 0;
  }

  /**
   * Unbind a 3PID from the identity servers it was bound on through this server (or `idServer`).
   * Returns "success" if every unbind succeeded, "no-support" otherwise.
   */
  async unbindAll(userId: string, medium: string, address: string, idServer?: string): Promise<"success" | "no-support"> {
    const where = [{ field: "user_id", value: userId }, { field: "medium", value: medium }, { field: "address", value: address }];
    const servers = idServer ? [idServer] : (await this.hs.db.findMany("threepid_bindings", { where })).map((b) => b.id_server);
    if (servers.length === 0) return "no-support";
    let result: "success" | "no-support" = "success";
    for (const server of servers) {
      let ok = false;
      try { ok = await this.hs.identityServers.unbind(server, userId, medium, address); } catch (err) { this.hs.logger.warn("Unbind from", server, "failed", err); }
      if (ok) await this.hs.db.delete("threepid_bindings", [...where, { field: "id_server", value: server }]);
      else result = "no-support";
    }
    return result;
  }

  /** Remove every 3PID of a (deactivated) account, unbinding them from identity servers. */
  async removeAll(userId: string): Promise<"success" | "no-support"> {
    let result: "success" | "no-support" = "success";
    const bound = await this.hs.db.findMany("threepid_bindings", { where: [{ field: "user_id", value: userId }] });
    for (const b of bound) if ((await this.unbindAll(userId, b.medium, b.address, b.id_server)) !== "success") result = "no-support";
    await this.hs.db.delete("user_threepids", [{ field: "user_id", value: userId }]);
    return bound.length ? result : "no-support";
  }

  /**
   * Start (or continue) validating an address: `POST .../{medium}/requestToken`. Repeating a
   * request with the same `client_secret`, address and `send_attempt` does not send again.
   */
  async requestToken(purpose: ThreepidPurpose, medium: Medium, body: Record<string, any>): Promise<Record<string, unknown>> {
    if (!this.enabled) throw errors.threepidDenied();
    if (!this.canValidate(medium)) throw new MatrixError(400, "M_THREEPID_MEDIUM_NOT_SUPPORTED", `This server cannot validate ${medium === "email" ? "email addresses" : "phone numbers"}`);
    if (typeof body.client_secret !== "string" || !CLIENT_SECRET_RE.test(body.client_secret)) throw errors.invalidParam("Invalid client_secret");
    if (!Number.isInteger(body.send_attempt)) throw errors.invalidParam("send_attempt must be an integer");
    let address: string | null;
    if (medium === "email") {
      if (typeof body.email !== "string") throw errors.missingParam("Missing email");
      address = canonicalAddress("email", body.email);
      if (!address) throw errors.invalidParam("Invalid email address");
    } else {
      if (typeof body.country !== "string" || typeof body.phone_number !== "string") throw errors.missingParam("Missing country or phone_number");
      address = toMsisdn(body.country, body.phone_number);
      if (!address) throw errors.invalidParam("Invalid phone number");
    }
    const owner = await this.userFor(medium, address);
    if (purpose === "password_reset" && !owner) throw new MatrixError(400, "M_THREEPID_NOT_FOUND", "No account uses this address");
    if (purpose !== "password_reset" && owner) throw new MatrixError(400, "M_THREEPID_IN_USE", "This address is already in use");
    const nextLink = typeof body.next_link === "string" ? body.next_link : null;
    if (nextLink && !/^https?:\/\//i.test(nextLink)) throw errors.invalidParam("next_link must be an http(s) URL");

    const existing = (await this.hs.db.findMany("threepid_sessions", { where: [{ field: "client_secret", value: body.client_secret }] }))
      .find((s) => s.medium === medium && s.address === address && !this.expired(s));
    let session = existing;
    if (existing && body.send_attempt <= existing.send_attempt) return this.tokenResponse(existing);
    if (existing) {
      await this.hs.db.update("threepid_sessions", [{ field: "sid", value: existing.sid }], { send_attempt: body.send_attempt, next_link: nextLink });
    } else {
      session = {
        sid: randomString(24), client_secret: body.client_secret, medium, address, send_attempt: body.send_attempt, next_link: nextLink,
        token: medium === "email" ? randomString(32) : String(randomInt(0, 1_000_000)).padStart(6, "0"), created_ts: Date.now(), validated_ts: null,
      };
      await this.hs.db.create("threepid_sessions", session);
    }
    await this.send(purpose, session!);
    return this.tokenResponse(session!);
  }

  private tokenResponse(session: Record<string, any>): Record<string, unknown> {
    const out: Record<string, unknown> = { sid: session.sid };
    if (this.hs.config.publicBaseUrl) out.submit_url = `${this.hs.config.publicBaseUrl.replace(/\/$/, "")}${SUBMIT_PATH}`;
    if (session.medium === "msisdn") Object.assign(out, { msisdn: session.address, intl_fmt: `+${session.address}` });
    return out;
  }

  private async send(purpose: ThreepidPurpose, session: Record<string, any>): Promise<void> {
    const what = PURPOSE_TEXT[purpose];
    try {
      if (session.medium === "email") {
        const base = this.hs.config.publicBaseUrl?.replace(/\/$/, "") ?? "";
        const link = `${base}${SUBMIT_PATH}?${new URLSearchParams({ sid: session.sid, client_secret: session.client_secret, token: session.token })}`;
        await this.options.sendEmail!({
          to: session.address, purpose, token: session.token, link,
          subject: `Confirm your email address for ${this.hs.serverName}`,
          text: `To ${what} on ${this.hs.serverName}, open this link:\n\n${link}\n\nIf you did not request this, ignore this message.`,
          html: `<p>To ${what} on ${escapeHtml(this.hs.serverName)}, <a href="${escapeHtml(link)}">confirm your email address</a>.</p><p>If you did not request this, ignore this message.</p>`,
        });
      } else {
        await this.options.sendSms!({
          to: session.address, purpose, token: session.token,
          text: `Your ${this.hs.serverName} code to ${what}: ${session.token}`,
        });
      }
    } catch (err) {
      this.hs.logger.warn("Sending a 3PID validation message failed", err);
      throw new MatrixError(500, "M_UNKNOWN", "Could not send the validation message");
    }
  }

  private expired(session: Record<string, any>): boolean {
    return session.created_ts + (this.options.sessionLifetimeMs ?? 24 * 60 * 60_000) < Date.now();
  }

  /** Validate a session with the token the user received. Returns the session's `next_link`. */
  async submitToken(sid: string, clientSecret: string, token: string): Promise<string | null> {
    const session = await this.hs.db.findOne("threepid_sessions", [{ field: "sid", value: sid }]);
    if (!session || session.client_secret !== clientSecret || this.expired(session)) throw new MatrixError(400, "M_NO_VALID_SESSION", "Unknown or expired session");
    if (session.token !== token.trim()) throw new MatrixError(400, "M_INVALID_PARAM", "Invalid token");
    if (session.validated_ts === null) await this.hs.db.update("threepid_sessions", [{ field: "sid", value: sid }], { validated_ts: Date.now() });
    return session.next_link;
  }

  /** The address a client proved ownership of, given its `threepid_creds`. */
  async validated(creds: unknown): Promise<(Threepid & { validatedTs: number }) | null> {
    const c = creds as Record<string, unknown> | null;
    if (!c || typeof c.sid !== "string" || typeof c.client_secret !== "string") return null;
    const session = await this.hs.db.findOne("threepid_sessions", [{ field: "sid", value: c.sid }]);
    if (!session || session.client_secret !== c.client_secret || session.validated_ts === null || this.expired(session)) return null;
    return { medium: session.medium, address: session.address, validatedTs: session.validated_ts };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
