import type { CryptoPrimitives } from "../crypto/primitives.ts";
import type { E2EEProtocol } from "./protocol.ts";
/** The built-in Olm and Megolm, written on CryptoPrimitives only. */
export declare function nativeE2EEProtocol(primitives: CryptoPrimitives): E2EEProtocol;
