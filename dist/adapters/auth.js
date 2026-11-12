import { hashPassword, verifyPassword } from "../core/crypto.js";
// src/adapters/auth.ts
function resolveUserAuth(adapter = {}) {
	return {
		registrationEnabled: adapter.registrationEnabled ?? false,
		registrationRequiresToken: adapter.registrationRequiresToken ?? false,
		passwordLoginEnabled: adapter.passwordLoginEnabled ?? true,
		guestAccessEnabled: adapter.guestAccessEnabled ?? false,
		checkPassword: adapter.checkPassword?.bind(adapter) ?? (async ({ password, storedHash }) => storedHash ? verifyPassword(password, storedHash) : false),
		hashPassword: adapter.hashPassword?.bind(adapter) ?? hashPassword,
		autoProvision: adapter.autoProvision?.bind(adapter) ?? (async () => false),
		onUserRegistered: adapter.onUserRegistered?.bind(adapter) ?? (async () => {}),
		validateUsername: adapter.validateUsername?.bind(adapter) ?? (async () => true),
		validatePassword: adapter.validatePassword?.bind(adapter) ?? (async () => null)
	};
}
export { resolveUserAuth };

//# sourceMappingURL=auth.js.map