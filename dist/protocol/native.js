import { decodeBase64 } from "../shared/base64.js";
import { encodeUtf8 } from "../shared/utf8.js";
import { NativeInboundGroupSession } from "./megolm/inbound.js";
import { NativeOutboundGroupSession } from "./megolm/outbound.js";
import { NativeOlmSession } from "./olm/session.js";
import { NativeOlmAccount } from "./olm/account.js";
// src/protocol/native.ts
/** The built-in Olm and Megolm, written on CryptoPrimitives only. */
function nativeE2EEProtocol(primitives) {
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
		}
	};
}
export { nativeE2EEProtocol };

//# sourceMappingURL=native.js.map