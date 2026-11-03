/**
 * Level 2 of the crypto stack: the Olm and Megolm protocols, as an interface the rest of the
 * client depends on. The built-in implementation (./native.ts) is written on CryptoPrimitives
 * only. Another implementation of the whole protocol, for example vodozemac through a native
 * module, can replace it without changes elsewhere: the shapes follow vodozemac's API (Account,
 * Session, GroupSession, InboundGroupSession), plaintexts are bytes, ciphertexts and keys are the
 * unpadded Base64 strings that go on the wire, and state leaves an object only as an opaque
 * pickle string.
 *
 * Synchronous, like vodozemac (and like libolm): the caller holds no lock across an await while a
 * ratchet advances, and an implementation backed by native code over JSI is synchronous too.
 *
 * Wire formats: https://gitlab.matrix.org/matrix-org/olm/-/blob/master/docs/olm.md and
 * …/megolm.md, as the Matrix spec requires for m.olm.v1.curve25519-aes-sha2 and
 * m.megolm.v1.aes-sha2 (https://spec.matrix.org/v1.16/client-server-api/#end-to-end-encryption).
 */
export class ProtocolError extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.name = "ProtocolError";
        this.code = code;
    }
}
