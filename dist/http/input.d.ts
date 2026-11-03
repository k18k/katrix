import { v } from "#core/vpm.ts";
import { MatrixError } from "#core/errors.ts";
/** A request body: a JSON object whose unknown keys are kept. */
export declare const body: <T extends v.Shape>(shape: T) => v.Schema<({ [K in Exclude<keyof T, { [K in keyof T]: undefined extends v.output<T[K]> ? K : never; }[keyof T]>]: v.output<T[K]>; } & { [K in { [K in keyof T]: undefined extends v.output<T[K]> ? K : never; }[keyof T]]?: v.output<T[K]> | undefined; } extends infer T_1 ? { [K in keyof T_1]: T_1[K]; } : never) & {
    [key: string]: unknown;
}, ({ [K in Exclude<keyof T, { [K in keyof T]: undefined extends v.output<T[K]> ? K : never; }[keyof T]>]: v.output<T[K]>; } & { [K in { [K in keyof T]: undefined extends v.output<T[K]> ? K : never; }[keyof T]]?: v.output<T[K]> | undefined; } extends infer T_1 ? { [K in keyof T_1]: T_1[K]; } : never) & {
    [key: string]: unknown;
}>;
/**
 * Errors carry their Matrix errcode in the message, as `M_CODE: text`: `fail` builds the vpm
 * error option for a field. Without one, a missing field is M_MISSING_PARAM and any other
 * problem M_BAD_JSON.
 */
export declare const fail: (errcode: string, message: string, missing?: string) => {
    error: (issue: {
        input?: unknown;
    }) => string;
};
/** A field that, when its value has the wrong type, is ignored (treated as absent), as Matrix clients expect for optional fields. */
export declare const lenient: <O, I>(schema: v.Schema<O, I>) => v.Schema<O | undefined, I | undefined>;
/** Turn a failed body parse into the Matrix error the client sees. */
export declare function inputError(error: {
    issues: v.Issue[];
}): MatrixError;
