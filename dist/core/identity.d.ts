import { Homeserver } from "../homeserver.js";
export interface StoredInvite {
  token: string;
  public_keys: {
    public_key: string;
    key_validity_url: string;
  }[];
  display_name: string;
}
export declare class IdentityServers {
  private readonly hs;
  constructor(hs: Homeserver);
  private base;
  private call;
  /** The Matrix user ID bound to a 3PID, if any. */
  lookup(idServer: string, token: string, medium: string, address: string): Promise<string | null>;
  storeInvite(idServer: string, token: string, invite: Record<string, unknown>): Promise<StoredInvite>;
  /** Returns the identity server's record of the binding (medium, address, mxid...). */
  bind(idServer: string, token: string, sid: string, clientSecret: string, mxid: string): Promise<Record<string, any>>;
  /** Remove a binding; resolves false when the identity server does not support unbinding. */
  unbind(idServer: string, mxid: string, medium: string, address: string): Promise<boolean>;
}
//# sourceMappingURL=identity.d.ts.map