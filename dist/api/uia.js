import { isObject } from "../shared/json.js";
import { M, UNSTABLE } from "../shared/m.js";
import { randomString } from "../core/crypto.js";
import { MatrixError, errors } from "../core/errors.js";
import { crossSigningResetAllowed } from "../core/oauthserver.js";
// src/api/uia.ts
const UIA_TTL_MS = 6e5;
/**
* User-interactive authentication. Resolves when one of `flows` has been
* completed; otherwise throws the 401 response describing what is required.
* `userId` binds password stages to an already-authenticated user. `session` is the caller's,
* and `crossSigningReset` marks `/keys/device_signing/upload`, the one endpoint where tokens of
* the OAuth 2.0 API may use UIA (the `m.oauth` stage).
*/
async function requireUia(hs, body, flows, userId, opts = {}) {
	const viaOAuth = !!opts.session?.oauth || !!hs.oauth && flows.some((f) => f.includes(M.LOGIN.PASSWORD));
	let oauthUrl;
	if (viaOAuth) {
		const accountUri = hs.oauthServer?.accountManagementUri ?? hs.oauth?.options.accountManagementUrl;
		if (!opts.crossSigningReset) throw new MatrixError(403, "M_FORBIDDEN", "Do this on the account management page", accountUri ? { account_management_uri: accountUri } : {});
		if (userId && await crossSigningResetAllowed(hs, userId)) return { threepids: [] };
		flows = [[M.OAUTH], [UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET]];
		oauthUrl = hs.oauthServer ? `${hs.oauthServer.accountManagementUri}?action=org.matrix.cross_signing_reset` : hs.oauth.options.accountManagementUrl ?? hs.oauth.options.issuer;
	}
	const auth = isObject(body.auth) ? body.auth : null;
	let sessionId = typeof auth?.session === "string" ? auth.session : void 0;
	const stored = sessionId ? await hs.cluster.get(`uia:${sessionId}`) : null;
	const session = {
		completed: new Set(stored?.completed ?? []),
		userId: stored ? stored.userId : userId,
		threepids: stored?.threepids ?? [],
		registrationToken: stored?.registrationToken
	};
	if (!stored) sessionId = randomString(24);
	const save = () => hs.cluster.set(`uia:${sessionId}`, {
		completed: [...session.completed],
		userId: session.userId,
		threepids: session.threepids,
		registrationToken: session.registrationToken
	}, UIA_TTL_MS);
	const params = oauthUrl ? {
		[M.OAUTH]: { url: oauthUrl },
		[UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET]: { url: oauthUrl }
	} : {};
	const challenge = (extra = {}) => new MatrixError(401, extra.errcode ? String(extra.errcode) : "M_FORBIDDEN", String(extra.error ?? "Authentication required"), {
		flows: flows.map((stages) => ({ stages })),
		params,
		session: sessionId,
		completed: [...session.completed],
		...extra
	});
	if (auth?.type === M.LOGIN.DUMMY && !auth.session && typeof body.username === "string" && !userId) {
		if (await hs.cluster.get(`uia-register:${body.username.toLowerCase()}`)) throw challenge({
			errcode: "M_FORBIDDEN",
			error: "Missing session"
		});
	}
	if (auth?.type) switch (auth.type) {
		case M.LOGIN.DUMMY:
			session.completed.add(M.LOGIN.DUMMY);
			break;
		case M.OAUTH:
		case UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET:
			if (!viaOAuth) throw challenge({
				errcode: "M_UNRECOGNIZED",
				error: "OAuth is not enabled"
			});
			throw challenge({
				errcode: "M_FORBIDDEN",
				error: "The reset has not been approved on the account page"
			});
		case M.LOGIN.REGISTRATION_TOKEN: {
			const { registrationTokenValid } = await import("./account.js");
			if (typeof auth.token !== "string" || !await registrationTokenValid(hs, auth.token)) throw challenge({
				errcode: "M_FORBIDDEN",
				error: "Invalid registration token"
			});
			session.completed.add(M.LOGIN.REGISTRATION_TOKEN);
			session.registrationToken = auth.token;
			break;
		}
		case M.LOGIN.PASSWORD: {
			const identifier = isObject(auth.identifier) ? auth.identifier : {
				type: M.ID.USER,
				user: auth.user
			};
			const user = typeof identifier.user === "string" ? identifier.user : "";
			const target = user.startsWith("@") ? user : `@${user.toLowerCase()}:${hs.serverName}`;
			if (userId && target !== userId) throw errors.forbidden("Credentials do not match the authenticated user");
			const row = await hs.db.findOne("users", [{
				field: "user_id",
				value: target
			}]);
			if (!(row && !row.deactivated && typeof auth.password === "string" && await hs.userAuth.checkPassword({
				userId: target,
				localpart: target.slice(1).split(":")[0],
				password: auth.password,
				storedHash: row.password_hash
			}))) throw challenge({
				errcode: "M_FORBIDDEN",
				error: "Invalid password"
			});
			session.completed.add(M.LOGIN.PASSWORD);
			break;
		}
		case M.LOGIN.EMAIL.IDENTITY:
		case M.LOGIN.MSISDN: {
			const validated = await hs.threepids.validated(auth.threepid_creds ?? auth.threepidCreds);
			const medium = auth.type === M.LOGIN.EMAIL.IDENTITY ? "email" : "msisdn";
			if (!validated || validated.medium !== medium) throw challenge({
				errcode: "M_UNAUTHORIZED",
				error: "The address has not been validated"
			});
			if (session.userId && await hs.threepids.userFor(validated.medium, validated.address) !== session.userId) throw challenge({
				errcode: "M_FORBIDDEN",
				error: "This address does not belong to your account"
			});
			session.threepids = [...session.threepids.filter((t) => t.medium !== medium), validated];
			session.completed.add(auth.type);
			break;
		}
		default: throw challenge({
			errcode: "M_UNRECOGNIZED",
			error: `Unsupported auth type ${auth.type}`
		});
	}
	if (!flows.some((stages) => stages.every((s) => session.completed.has(s)))) {
		await save();
		if (!userId && typeof body.username === "string") await hs.cluster.set(`uia-register:${body.username.toLowerCase()}`, sessionId, UIA_TTL_MS);
		if (auth?.type) throw challenge();
		const e = challenge();
		throw new MatrixError(401, "M_FORBIDDEN", "", {
			...e.extra,
			errcode: void 0,
			error: void 0
		});
	}
	await hs.cluster.delete(`uia:${sessionId}`);
	return {
		threepids: session.threepids,
		registrationToken: session.registrationToken
	};
}
export { requireUia };

//# sourceMappingURL=uia.js.map