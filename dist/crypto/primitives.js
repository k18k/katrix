/**
 * Level 1 of the crypto stack: the primitives everything above is built from. Olm and Megolm
 * (src/protocol) and, later, SAS verification, cross-signing, key backup and secret storage use
 * nothing else. The default implementation is on @noble/* (./noble.ts); a platform can supply
 * its own (for example native code in a React Native app) as long as it meets these contracts.
 *
 * The interface is synchronous on purpose. Hermes has no WebCrypto (crypto.subtle), so the
 * portable implementations are synchronous anyway, and the protocol layer mirrors vodozemac's API,
 * which is synchronous too: an async primitive could not be used underneath it.
 *
 * Errors thrown by an implementation must not contain key material or plaintext.
 */
export class CryptoPrimitiveError extends Error {
    constructor(message) {
        super(message);
        this.name = "CryptoPrimitiveError";
    }
}
