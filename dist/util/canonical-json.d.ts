/**
 * Canonical JSON (https://spec.matrix.org/v1.16/appendices/#canonical-json): keys sorted by
 * Unicode code point, no insignificant whitespace, integers only, in [-(2^53)+1, 2^53-1].
 * It is what Ed25519 signatures over JSON (device keys, one-time keys) cover.
 */
export declare class CanonicalJsonError extends Error {
    constructor(message: string);
}
export declare function canonicalJson(value: unknown): string;
/** The canonical JSON that a signature covers: the object without `signatures` and `unsigned`. */
export declare function signingJson(value: Record<string, unknown>): string;
