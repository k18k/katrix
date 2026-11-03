/** Matrix canonical JSON: sorted keys, no whitespace, UTF-8, integers only. */
export declare function canonicalJson(value: unknown): string;
export declare function isObject(value: unknown): value is Record<string, any>;
export declare function clone<T>(value: T): T;
