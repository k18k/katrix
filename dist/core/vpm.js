// vpm: the small schema validator for request bodies and responses (it replaced zod, so the package
// has no runtime dependencies). A schema checks a value and returns it, cleaned up where the schema
// says so (unknown keys dropped, wrong types caught); problems are collected as issues with the path
// to the offending value.
//
//   const Body = v.looseObject({ name: v.string().min(1), tags: v.array(v.string()).optional() });
//   const result = Body.safeParse(json); // { success: true, data } or { success: false, error }
//   type Body = v.output<typeof Body>;
const issue = (issues, path, input, message, code) => {
    issues.push({ path, message, code, input });
    return undefined;
};
const sizeOf = (value) => (typeof value === "number" ? value : value.length);
function make(check) {
    /** A schema that runs this one, then `next` on its result if this one found no problem. */
    const then = (next) => make((value, path, issues) => {
        const before = issues.length;
        const out = check(value, path, issues);
        return issues.length === before ? next(out, path, issues) : undefined;
    });
    const bound = (ok, code, message) => then((value, path, issues) => (ok(sizeOf(value)) ? value : issue(issues, path, value, message, code)));
    return {
        _check: check,
        safeParse(value) {
            const issues = [];
            const data = check(value, [], issues);
            if (!issues.length)
                return { success: true, data };
            const message = issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
            return { success: false, error: { issues, message } };
        },
        parse(value) {
            const result = this.safeParse(value);
            if (!result.success)
                throw Object.assign(new Error(result.error.message), result.error);
            return result.data;
        },
        optional: () => make((value, path, issues) => (value === undefined ? undefined : check(value, path, issues))),
        nullable: () => make((value, path, issues) => (value === null ? null : check(value, path, issues))),
        catch: (fallback) => make((value, path) => {
            const own = [];
            const out = check(value, path, own);
            return own.length ? fallback : out;
        }),
        refine: (ok, message = "Invalid value") => then((value, path, issues) => (ok(value) ? value : issue(issues, path, value, message, "custom"))),
        transform: (fn) => then((value) => fn(value)),
        min: (n, message = `Must be at least ${n}`) => bound((size) => size >= n, "too_small", message),
        max: (n, message = `Must be at most ${n}`) => bound((size) => size <= n, "too_big", message),
        int: (message = "Expected an integer") => then((value, path, issues) => (Number.isInteger(value) ? value : issue(issues, path, value, message, "invalid_type"))),
    };
}
/** A type check: `ok` decides, and the options can give the message (as a Matrix error, see http/input.ts). */
function typed(expected, ok, options, inner) {
    return make((value, path, issues) => {
        if (!ok(value)) {
            const message = typeof options?.error === "function" ? options.error({ input: value }) : (options?.error ?? `Expected ${expected}`);
            return issue(issues, path, value, message, "invalid_type");
        }
        return inner ? inner(value, path, issues) : value;
    });
}
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function objectOf(shape, unknownKeys, options) {
    return typed("object", isObject, options, (value, path, issues) => {
        const input = value;
        const out = unknownKeys === "keep" ? { ...input } : {};
        for (const [key, field] of Object.entries(shape)) {
            const parsed = field._check(input[key], [...path, key], issues);
            if (parsed !== undefined)
                out[key] = parsed;
            else
                delete out[key];
        }
        if (unknownKeys === "reject") {
            const extra = Object.keys(input).filter((k) => !Object.hasOwn(shape, k));
            if (extra.length)
                issue(issues, path, value, `Unrecognized keys: ${extra.join(", ")}`, "unrecognized_keys");
        }
        return out;
    });
}
export const v = {
    string: (options) => typed("string", (x) => typeof x === "string", options),
    number: (options) => typed("number", (x) => typeof x === "number" && Number.isFinite(x), options),
    boolean: (options) => typed("boolean", (x) => typeof x === "boolean", options),
    unknown: () => make((value) => value),
    enum: (values, options) => typed(values.map((x) => JSON.stringify(x)).join(" | "), (x) => values.includes(x), options),
    array: (item, options) => typed("array", Array.isArray, options, (value, path, issues) => value.map((x, i) => item._check(x, [...path, i], issues))),
    record: (key, value, options) => typed("object", isObject, options, (input, path, issues) => {
        const out = {};
        for (const [k, x] of Object.entries(input)) {
            key._check(k, [...path, k], issues);
            out[k] = value._check(x, [...path, k], issues);
        }
        return out;
    }),
    /** An object with these fields; other keys are dropped. */
    object: (shape, options) => objectOf(shape, "strip", options),
    /** An object with these fields; other keys are kept as they are. */
    looseObject: (shape, options) => objectOf(shape, "keep", options),
    /** An object with these fields and no others. */
    strictObject: (shape, options) => objectOf(shape, "reject", options),
};
