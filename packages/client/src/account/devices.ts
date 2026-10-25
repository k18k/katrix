import type { MatrixHttpApi } from "../http/api.ts";
import { withUserInteractiveAuth, type UiaCallback } from "../auth/uia.ts";
import type { Device } from "@katrix/shared";

/** The account's devices (https://spec.matrix.org/v1.19/client-server-api/#device-management). */
export class DevicesApi {
  private readonly api: MatrixHttpApi;

  constructor(api: MatrixHttpApi) {
    this.api = api;
  }

  async list(): Promise<Device[]> {
    return (await this.api.endpoint("GET /v3/devices", {}, {})).devices ?? [];
  }

  get(deviceId: string): Promise<Device> {
    return this.api.endpoint("GET /v3/devices/:deviceId", { deviceId }, {});
  }

  /** Set a device's display name (others see it in key verification and device lists). */
  async rename(deviceId: string, displayName: string): Promise<void> {
    await this.api.endpoint("PUT /v3/devices/:deviceId", { deviceId }, { body: { display_name: displayName } });
  }

  /** Log out devices: their access tokens and end-to-end keys are deleted. Needs user-interactive authentication. */
  async delete(deviceIds: string[], auth: UiaCallback): Promise<void> {
    if (deviceIds.length === 1) {
      const [deviceId] = deviceIds;
      await withUserInteractiveAuth((a) => this.api.endpoint("DELETE /v3/devices/:deviceId", { deviceId }, { body: { auth: a } }), auth);
    } else if (deviceIds.length > 1) {
      await withUserInteractiveAuth(
        (a) => this.api.endpoint("POST /v3/delete_devices", {}, { body: { devices: deviceIds, auth: a } }),
        auth,
      );
    }
  }
}
