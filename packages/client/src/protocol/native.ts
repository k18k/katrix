import type { CryptoPrimitives } from "../crypto/primitives.ts";
import { decodeBase64, encodeUtf8 } from "@katrix/shared";
import { NativeInboundGroupSession } from "./megolm/inbound.ts";
import { NativeOutboundGroupSession } from "./megolm/outbound.ts";
import { NativeOlmAccount } from "./olm/account.ts";
import { NativeOlmSession } from "./olm/session.ts";
import type { E2EEProtocol } from "./protocol.ts";

/** The built-in Olm and Megolm, written on CryptoPrimitives only. */
export function nativeE2EEProtocol(primitives: CryptoPrimitives): E2EEProtocol {
  const p = primitives;
  return {
    id: "mnc-native-1",
    newAccount: () => NativeOlmAccount.create(p),
    accountFromPickle: (pickle, key) => NativeOlmAccount.fromPickle(p, pickle, key),
    sessionFromPickle: (pickle, key) => NativeOlmSession.fromPickle(p, pickle, key),
    newOutboundGroupSession: () => NativeOutboundGroupSession.create(p),
    outboundGroupSessionFromPickle: (pickle, key) => NativeOutboundGroupSession.fromPickle(p, pickle, key),
    inboundGroupSessionFromSessionKey: (sessionKey) => NativeInboundGroupSession.fromSessionKey(p, sessionKey),
    inboundGroupSessionFromExport: (exported) => NativeInboundGroupSession.fromExport(p, exported),
    inboundGroupSessionFromPickle: (pickle, key) => NativeInboundGroupSession.fromPickle(p, pickle, key),
    verifyEd25519(publicKey, message, signature) {
      try {
        return p.ed25519Verify(decodeBase64(publicKey), encodeUtf8(message), decodeBase64(signature));
      } catch {
        return false;
      }
    },
  };
}
