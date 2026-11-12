import { MatrixError } from "../http/errors.js";
// src/auth/uia.ts
const MAX_ROUNDS = 10;
function uiaSessionOf(e) {
	if (!(e instanceof MatrixError) || e.status !== 401 || !Array.isArray(e.data.flows)) return void 0;
	const d = e.data;
	return {
		flows: d.flows.map((f) => ({ stages: Array.isArray(f?.stages) ? f.stages.filter((s) => typeof s === "string") : [] })),
		params: typeof d.params === "object" && d.params !== null ? d.params : {},
		session: typeof d.session === "string" ? d.session : void 0,
		completed: Array.isArray(d.completed) ? d.completed.filter((s) => typeof s === "string") : [],
		errcode: typeof d.errcode === "string" ? d.errcode : void 0
	};
}
/**
* Run `call`, completing user-interactive authentication with `onAuth` when the server asks for
* it. `call` gets the `auth` dict to send (undefined on the first try).
*/
async function withUserInteractiveAuth(call, onAuth) {
	let auth;
	for (let round = 0;; round++) try {
		return await call(auth);
	} catch (e) {
		const session = uiaSessionOf(e);
		if (!session || !onAuth || round >= MAX_ROUNDS) throw e;
		const next = await onAuth(session);
		if (!next) throw e;
		auth = next.session === void 0 && session.session !== void 0 ? {
			...next,
			session: session.session
		} : next;
	}
}
/** The stages left in the first flow that `can` completes (each of its stages is one `can` knows). */
function nextStage(session, can) {
	for (const flow of session.flows) {
		if (!flow.stages.every(can)) continue;
		const left = flow.stages.filter((s) => !session.completed.includes(s));
		if (left.length > 0) return left[0];
	}
}
/**
* Answers `m.login.password` (and `m.login.dummy`) stages with the user's password. A wrong
* password is not retried: the server's 401 (M_FORBIDDEN) is thrown. Other stages give up, unless
* `fallback` answers them.
*/
function passwordAuth(userId, password, fallback) {
	let tried = false;
	return (session) => {
		const stage = nextStage(session, (s) => s === "m.login.password" || s === "m.login.dummy");
		if (stage === "m.login.dummy") return { type: "m.login.dummy" };
		if (stage === "m.login.password" && !(tried && session.errcode)) {
			tried = true;
			return {
				type: "m.login.password",
				identifier: {
					type: "m.id.user",
					user: userId
				},
				password
			};
		}
		return fallback?.(session);
	};
}
/** Answers flows made only of `m.login.dummy` (open registration, some servers' device deletion). */
const dummyAuth = (session) => nextStage(session, (s) => s === "m.login.dummy") === "m.login.dummy" ? { type: "m.login.dummy" } : void 0;
export { dummyAuth, nextStage, passwordAuth, withUserInteractiveAuth };

//# sourceMappingURL=uia.js.map