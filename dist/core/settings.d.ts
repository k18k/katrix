import { Homeserver } from "../homeserver.js";
/** Runtime server settings changed by admins (stored in the database, shared across instances). */
export declare class SettingsService {
  private hs;
  private cache;
  constructor(hs: Homeserver);
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}
//# sourceMappingURL=settings.d.ts.map