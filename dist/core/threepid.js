import { randomString } from "./crypto.js";
import { MatrixError, errors } from "./errors.js";
import { toMsisdn } from "./phone.js";
import { escapeHtml } from "./html.js";
import { randomInt } from "node:crypto";
// src/core/threepid.ts
const CLIENT_SECRET_RE = /^[0-9a-zA-Z.=_-]{1,255}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SUBMIT_PATH = "/_matrix/client/unstable/threepid/submit_token";
const PURPOSE_TEXT = {
	register: "create your account",
	password_reset: "reset your password",
	add_threepid: "add this address to your account"
};
function isMedium(m) {
	return m === "email" || m === "msisdn";
}
/** Canonical form of an address: lower-case email, digits-only phone number. */
function canonicalAddress(medium, address) {
	if (medium === "email") {
		const email = address.trim().toLowerCase();
		return EMAIL_RE.test(email) && email.length <= 320 ? email : null;
	}
	const msisdn = address.replace(/^\+/, "");
	return /^\d{7,15}$/.test(msisdn) ? msisdn : null;
}
var ThreepidService = class {
	hs;
	constructor(hs) {
		this.hs = hs;
	}
	get options() {
		return this.hs.config.threepid;
	}
	/** Whether this server can validate addresses of `medium` itself. */
	canValidate(medium) {
		return medium === "email" ? !!this.options.sendEmail : !!this.options.sendSms;
	}
	/** Account changes involving 3PIDs are possible at all (the m.3pid_changes capability). */
	get enabled() {
		return this.canValidate("email") || this.canValidate("msisdn");
	}
	async userFor(medium, address) {
		return (await this.hs.db.findOne("user_threepids", [{
			field: "medium",
			value: medium
		}, {
			field: "address",
			value: address
		}]))?.user_id ?? null;
	}
	async list(userId) {
		return (await this.hs.db.findMany("user_threepids", { where: [{
			field: "user_id",
			value: userId
		}] })).map((r) => ({
			medium: r.medium,
			address: r.address,
			validated_at: r.validated_ts,
			added_at: r.added_ts
		}));
	}
	async add(userId, threepid) {
		const owner = await this.userFor(threepid.medium, threepid.address);
		if (owner && owner !== userId) throw new MatrixError(400, "M_THREEPID_IN_USE", "This address is already in use");
		await this.hs.db.upsert("user_threepids", {
			user_id: userId,
			medium: threepid.medium,
			address: threepid.address,
			validated_ts: threepid.validatedTs,
			added_ts: Date.now()
		});
	}
	async remove(userId, medium, address) {
		return await this.hs.db.delete("user_threepids", [
			{
				field: "user_id",
				value: userId
			},
			{
				field: "medium",
				value: medium
			},
			{
				field: "address",
				value: address
			}
		]) > 0;
	}
	/**
	* Unbind a 3PID from the identity servers it was bound on through this server (or `idServer`).
	* Returns "success" if every unbind succeeded, "no-support" otherwise.
	*/
	async unbindAll(userId, medium, address, idServer) {
		const where = [
			{
				field: "user_id",
				value: userId
			},
			{
				field: "medium",
				value: medium
			},
			{
				field: "address",
				value: address
			}
		];
		const servers = idServer ? [idServer] : (await this.hs.db.findMany("threepid_bindings", { where })).map((b) => b.id_server);
		if (servers.length === 0) return "no-support";
		let result = "success";
		for (const server of servers) {
			let ok = false;
			try {
				ok = await this.hs.identityServers.unbind(server, userId, medium, address);
			} catch (err) {
				this.hs.logger.warn("Unbind from", server, "failed", err);
			}
			if (ok) await this.hs.db.delete("threepid_bindings", [...where, {
				field: "id_server",
				value: server
			}]);
			else result = "no-support";
		}
		return result;
	}
	/** Remove every 3PID of a (deactivated) account, unbinding them from identity servers. */
	async removeAll(userId) {
		let result = "success";
		const bound = await this.hs.db.findMany("threepid_bindings", { where: [{
			field: "user_id",
			value: userId
		}] });
		for (const b of bound) if (await this.unbindAll(userId, b.medium, b.address, b.id_server) !== "success") result = "no-support";
		await this.hs.db.delete("user_threepids", [{
			field: "user_id",
			value: userId
		}]);
		return bound.length ? result : "no-support";
	}
	/**
	* Start (or continue) validating an address: `POST .../{medium}/requestToken`. Repeating a
	* request with the same `client_secret`, address and `send_attempt` does not send again.
	*/
	async requestToken(purpose, medium, body) {
		if (!this.enabled) throw errors.threepidDenied();
		if (!this.canValidate(medium)) throw new MatrixError(400, "M_THREEPID_MEDIUM_NOT_SUPPORTED", `This server cannot validate ${medium === "email" ? "email addresses" : "phone numbers"}`);
		if (typeof body.client_secret !== "string" || !CLIENT_SECRET_RE.test(body.client_secret)) throw errors.invalidParam("Invalid client_secret");
		if (!Number.isInteger(body.send_attempt)) throw errors.invalidParam("send_attempt must be an integer");
		let address;
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
		const existing = (await this.hs.db.findMany("threepid_sessions", { where: [{
			field: "client_secret",
			value: body.client_secret
		}] })).find((s) => s.medium === medium && s.address === address && !this.expired(s));
		let session = existing;
		if (existing && body.send_attempt <= existing.send_attempt) return this.tokenResponse(existing);
		if (existing) await this.hs.db.update("threepid_sessions", [{
			field: "sid",
			value: existing.sid
		}], {
			send_attempt: body.send_attempt,
			next_link: nextLink
		});
		else {
			session = {
				sid: randomString(24),
				client_secret: body.client_secret,
				medium,
				address,
				send_attempt: body.send_attempt,
				next_link: nextLink,
				token: medium === "email" ? randomString(32) : String(randomInt(0, 1e6)).padStart(6, "0"),
				created_ts: Date.now(),
				validated_ts: null
			};
			await this.hs.db.create("threepid_sessions", session);
		}
		await this.send(purpose, session);
		return this.tokenResponse(session);
	}
	tokenResponse(session) {
		const out = { sid: session.sid };
		if (this.hs.config.publicBaseUrl) out.submit_url = `${this.hs.config.publicBaseUrl.replace(/\/$/, "")}${SUBMIT_PATH}`;
		if (session.medium === "msisdn") Object.assign(out, {
			msisdn: session.address,
			intl_fmt: `+${session.address}`
		});
		return out;
	}
	async send(purpose, session) {
		const what = PURPOSE_TEXT[purpose];
		try {
			if (session.medium === "email") {
				const link = `${this.hs.config.publicBaseUrl?.replace(/\/$/, "") ?? ""}${SUBMIT_PATH}?${new URLSearchParams({
					sid: session.sid,
					client_secret: session.client_secret,
					token: session.token
				})}`;
				await this.options.sendEmail({
					to: session.address,
					purpose,
					token: session.token,
					link,
					subject: `Confirm your email address for ${this.hs.serverName}`,
					text: `To ${what} on ${this.hs.serverName}, open this link:\n\n${link}\n\nIf you did not request this, ignore this message.`,
					html: `<p>To ${what} on ${escapeHtml(this.hs.serverName)}, <a href="${escapeHtml(link)}">confirm your email address</a>.</p><p>If you did not request this, ignore this message.</p>`
				});
			} else await this.options.sendSms({
				to: session.address,
				purpose,
				token: session.token,
				text: `Your ${this.hs.serverName} code to ${what}: ${session.token}`
			});
		} catch (err) {
			this.hs.logger.warn("Sending a 3PID validation message failed", err);
			throw new MatrixError(500, "M_UNKNOWN", "Could not send the validation message");
		}
	}
	expired(session) {
		return session.created_ts + (this.options.sessionLifetimeMs ?? 864e5) < Date.now();
	}
	/** Validate a session with the token the user received. Returns the session's `next_link`. */
	async submitToken(sid, clientSecret, token) {
		const session = await this.hs.db.findOne("threepid_sessions", [{
			field: "sid",
			value: sid
		}]);
		if (!session || session.client_secret !== clientSecret || this.expired(session)) throw new MatrixError(400, "M_NO_VALID_SESSION", "Unknown or expired session");
		if (session.token !== token.trim()) throw new MatrixError(400, "M_INVALID_PARAM", "Invalid token");
		if (session.validated_ts === null) await this.hs.db.update("threepid_sessions", [{
			field: "sid",
			value: sid
		}], { validated_ts: Date.now() });
		return session.next_link;
	}
	/** The address a client proved ownership of, given its `threepid_creds`. */
	async validated(creds) {
		const c = creds;
		if (!c || typeof c.sid !== "string" || typeof c.client_secret !== "string") return null;
		const session = await this.hs.db.findOne("threepid_sessions", [{
			field: "sid",
			value: c.sid
		}]);
		if (!session || session.client_secret !== c.client_secret || session.validated_ts === null || this.expired(session)) return null;
		return {
			medium: session.medium,
			address: session.address,
			validatedTs: session.validated_ts
		};
	}
};
export { ThreepidService, canonicalAddress, isMedium };

//# sourceMappingURL=threepid.js.map