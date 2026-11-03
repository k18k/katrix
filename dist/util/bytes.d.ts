export declare function concatBytes(...parts: Uint8Array[]): Uint8Array;
/**
 * Compares without an early exit, so the time taken does not tell how many leading bytes of a MAC
 * matched. (A JavaScript engine gives no hard guarantee, but nothing here branches on the data.)
 */
export declare function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean;
export declare function bytesEqual(a: Uint8Array, b: Uint8Array): boolean;
export declare function writeUint32BE(value: number, out: Uint8Array, offset: number): void;
export declare function readUint32BE(bytes: Uint8Array, offset: number): number;
export declare function toHex(bytes: Uint8Array): string;
export declare function fromHex(hex: string): Uint8Array;
