export type Path = (string | number)[];
export interface Issue {
    path: Path;
    message: string;
    code: "invalid_type" | "too_small" | "too_big" | "unrecognized_keys" | "custom";
    /** The value that failed; `undefined` for a missing one. */
    input: unknown;
}
/** Options for a schema's own type check: `error` builds the message from the failing issue. */
export interface Options {
    error?: string | ((issue: {
        input: unknown;
    }) => string);
}
type Check = (value: unknown, path: Path, issues: Issue[]) => unknown;
export type SafeParseResult<O> = {
    success: true;
    data: O;
} | {
    success: false;
    error: {
        issues: Issue[];
        message: string;
    };
};
export interface Schema<O = unknown, I = O> {
    readonly _check: Check;
    /** Type-level only: what the schema produces and accepts. */
    readonly _types?: {
        output: O;
        input: I;
    };
    safeParse(value: unknown): SafeParseResult<O>;
    parse(value: unknown): O;
    optional(): Schema<O | undefined, I | undefined>;
    nullable(): Schema<O | null, I | null>;
    /** On any problem, `fallback` instead (the problems are dropped). */
    catch<T>(fallback: T): Schema<O | T, I>;
    refine(ok: (value: O) => boolean, message?: string): Schema<O, I>;
    transform<T>(fn: (value: O) => T): Schema<T, I>;
    /** At least `n`: the number itself, or the length of a string or array. */
    min(n: number, message?: string): Schema<O, I>;
    max(n: number, message?: string): Schema<O, I>;
    int(message?: string): Schema<O, I>;
}
export type output<S> = S extends {
    readonly _types?: {
        output: infer O;
    };
} ? O : never;
export type input<S> = S extends {
    readonly _types?: {
        input: infer I;
    };
} ? I : never;
export type Shape = Record<string, Schema<any, any>>;
type Optional<T extends Shape> = {
    [K in keyof T]: undefined extends output<T[K]> ? K : never;
}[keyof T];
type ObjectOutput<T extends Shape> = {
    [K in Exclude<keyof T, Optional<T>>]: output<T[K]>;
} & {
    [K in Optional<T>]?: output<T[K]>;
};
type Flat<T> = {
    [K in keyof T]: T[K];
} & {};
export declare const v: {
    string: (options?: Options) => Schema<string, string>;
    number: (options?: Options) => Schema<number, number>;
    boolean: (options?: Options) => Schema<boolean, boolean>;
    unknown: () => Schema<unknown, unknown>;
    enum: <const T extends readonly string[]>(values: T, options?: Options) => Schema<T[number], T[number]>;
    array: <S extends Schema<any, any>>(item: S, options?: Options) => Schema<output<S>[], input<S>[]>;
    record: <V extends Schema<any, any>>(key: Schema<string>, value: V, options?: Options) => Schema<Record<string, output<V>>, Record<string, input<V>>>;
    /** An object with these fields; other keys are dropped. */
    object: <T extends Shape>(shape: T, options?: Options) => Schema<Flat<ObjectOutput<T>>>;
    /** An object with these fields; other keys are kept as they are. */
    looseObject: <T extends Shape>(shape: T, options?: Options) => Schema<Flat<ObjectOutput<T>> & {
        [key: string]: unknown;
    }>;
    /** An object with these fields and no others. */
    strictObject: <T extends Shape>(shape: T, options?: Options) => Schema<Flat<ObjectOutput<T>>>;
};
export declare namespace v {
    export type { output, input, Schema, Shape, Issue };
}
export {};
