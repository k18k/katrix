import { randomString } from "./crypto.js";
// src/core/ids.ts
function generateRoomId(serverName) {
	return `!${randomString(18)}:${serverName}`;
}
function generateDeviceId() {
	return randomString(10).toUpperCase();
}
export { generateDeviceId, generateRoomId };

//# sourceMappingURL=ids.js.map