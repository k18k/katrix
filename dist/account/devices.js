import { withUserInteractiveAuth } from "../auth/uia.js";
// src/account/devices.ts
/** The account's devices (https://spec.matrix.org/v1.19/client-server-api/#device-management). */
var DevicesApi = class {
	api;
	constructor(api) {
		this.api = api;
	}
	async list() {
		return (await this.api.endpoint("GET /v3/devices", {}, {})).devices ?? [];
	}
	get(deviceId) {
		return this.api.endpoint("GET /v3/devices/:deviceId", { deviceId }, {});
	}
	/** Set a device's display name (others see it in key verification and device lists). */
	async rename(deviceId, displayName) {
		await this.api.endpoint("PUT /v3/devices/:deviceId", { deviceId }, { body: { display_name: displayName } });
	}
	/** Log out devices: their access tokens and end-to-end keys are deleted. Needs user-interactive authentication. */
	async delete(deviceIds, auth) {
		if (deviceIds.length === 1) {
			const [deviceId] = deviceIds;
			await withUserInteractiveAuth((a) => this.api.endpoint("DELETE /v3/devices/:deviceId", { deviceId }, { body: { auth: a } }), auth);
		} else if (deviceIds.length > 1) await withUserInteractiveAuth((a) => this.api.endpoint("POST /v3/delete_devices", {}, { body: {
			devices: deviceIds,
			auth: a
		} }), auth);
	}
};
export { DevicesApi };

//# sourceMappingURL=devices.js.map