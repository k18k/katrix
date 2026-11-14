import { PDU } from "./events.js";
import { Homeserver } from "../homeserver.js";
import { KeyObject } from "node:crypto";
export declare class PolicyServers {
  private readonly hs;
  constructor(hs: Homeserver);
  /** The room's policy server, if the room uses one (valid `m.room.policy` and a joined user on `via`). */
  policyOf(roomId: string): Promise<{
    via: string;
    key: KeyObject;
  } | null>;
  /** The policy state event itself is never sent to the policy server. */
  private exempt;
  private validSignature;
  /** Ask the policy server to sign `pdu`; adds the signature to it. Throws the server's error. */
  private requestSignature;
  /**
   * Before a local event is sent: get the policy server's signature, or refuse the event with the
   * policy server's error. If the policy server cannot be reached the event is sent unsigned (other
   * servers may then soft-fail it), so an unavailable policy server does not lock up the room.
   */
  signLocal(roomId: string, version: string, pdu: PDU): Promise<void>;
  /** Whether a remote event is recommended for inclusion (otherwise it is soft-failed). */
  recommended(roomId: string, version: string, pdu: PDU): Promise<boolean>;
}
//# sourceMappingURL=policy.d.ts.map