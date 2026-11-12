import { Device } from "../shared/api/account.js";
import { MatrixHttpApi } from "../http/api.js";
import { UiaCallback } from "../auth/uia.js";
/** The account's devices (https://spec.matrix.org/v1.19/client-server-api/#device-management). */
export declare class DevicesApi {
  private readonly api;
  constructor(api: MatrixHttpApi);
  list(): Promise<Device[]>;
  get(deviceId: string): Promise<Device>;
  /** Set a device's display name (others see it in key verification and device lists). */
  rename(deviceId: string, displayName: string): Promise<void>;
  /** Log out devices: their access tokens and end-to-end keys are deleted. Needs user-interactive authentication. */
  delete(deviceIds: string[], auth: UiaCallback): Promise<void>;
}
//# sourceMappingURL=devices.d.ts.map