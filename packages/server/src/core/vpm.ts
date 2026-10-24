// vpm: the small schema validator for request bodies and responses (it replaced zod, so the package
// has no runtime dependencies). A schema checks a value and returns it, cleaned up where the schema
// says so (unknown keys dropped, wrong types caught); problems are collected as issues with the path
// to the offending value.
//
//   const Body = v.looseObject({ name: v.string().min(1), tags: v.array(v.string()).optional() });
//   const result = Body.safeParse(json); // { success: true, data } or { success: false, error }
//   type Body = v.output<typeof Body>;

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
  error?: string | ((issue: { input: unknown }) => string);
}

type Check = (value: unknown, path: Path, issues: Issue[]) => unknown;

export type SafeParseResult<O> = { success: true; data: O } | { success: false; error: { issues: Issue[]; message: string } };

export interface Schema<O = unknown, I = O> {
  readonly _check: Check;
  /** Type-level only: what the schema produces and accepts. */
  readonly _types?: { output: O; input: I };
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

export type output<S> = S extends { readonly _types?: { output: infer O } } ? O : never;
export type input<S> = S extends { readonly _types?: { input: infer I } } ? I : never;
export type Shape = Record<string, Schema<any, any>>;

const issue = (issues: Issue[], path: Path, input: unknown, message: string, code: Issue["code"]): undefined => {
  issues.push({ path, message, code, input });
  return undefined;
};

const sizeOf = (value: unknown) => (typeof value === "number" ? value : (value as { length: number }).length);

function make<O, I = O>(check: Check): Schema<O, I> {
  /** A schema that runs this one, then `next` on its result if this one found no problem. */
  const then = <T, J = I>(next: (value: O, path: Path, issues: Issue[]) => unknown): Schema<T, J> =>
    make((value, path, issues) => {
      const before = issues.length;
      const out = check(value, path, issues);
      return issues.length === before ? next(out as O, path, issues) : undefined;
    });
  const bound = (ok: (size: number) => boolean, code: Issue["code"], message: string) =>
    then<O>((value, path, issues) => (ok(sizeOf(value)) ? value : issue(issues, path, value, message, code)));
  return {
    _check: check,
    safeParse(value) {
      const issues: Issue[] = [];
      const data = check(value, [], issues) as O;
      if (!issues.length) return { success: true, data };
      const message = issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
      return { success: false, error: { issues, message } };
    },
    parse(value) {
      const result = this.safeParse(value);
      if (!result.success) throw Object.assign(new Error(result.error.message), result.error);
      return result.data;
    },
    optional: () => make((value, path, issues) => (value === undefined ? undefined : check(value, path, issues))),
    nullable: () => make((value, path, issues) => (value === null ? null : check(value, path, issues))),
    catch: (fallback) =>
      make((value, path) => {
        const own: Issue[] = [];
        const out = check(value, path, own);
        return own.length ? fallback : out;
      }),
    refine: (ok, message = "Invalid value") =>
      then((value, path, issues) => (ok(value) ? value : issue(issues, path, value, message, "custom"))),
    transform: (fn) => then((value) => fn(value)),
    min: (n, message = `Must be at least ${n}`) => bound((size) => size >= n, "too_small", message),
    max: (n, message = `Must be at most ${n}`) => bound((size) => size <= n, "too_big", message),
    int: (message = "Expected an integer") =>
      then((value, path, issues) => (Number.isInteger(value) ? value : issue(issues, path, value, message, "invalid_type"))),
  };
}

/** A type check: `ok` decides, and the options can give the message (as a Matrix error, see http/input.ts). */
function typed<O>(expected: string, ok: (value: unknown) => boolean, options?: Options, inner?: Check): Schema<O> {
  return make<O>((value, path, issues) => {
    if (!ok(value)) {
      const message = typeof options?.error === "function" ? options.error({ input: value }) : (options?.error ?? `Expected ${expected}`);
      return issue(issues, path, value, message, "invalid_type");
    }
    return inner ? inner(value, path, issues) : value;
  });
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type Optional<T extends Shape> = { [K in keyof T]: undefined extends output<T[K]> ? K : never }[keyof T];
type ObjectOutput<T extends Shape> = { [K in Exclude<keyof T, Optional<T>>]: output<T[K]> } & { [K in Optional<T>]?: output<T[K]> };
type Flat<T> = { [K in keyof T]: T[K] } & {};

function objectOf<T extends Shape>(shape: T, unknownKeys: "strip" | "keep" | "reject", options?: Options) {
  return typed<any>("object", isObject, options, (value, path, issues) => {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = unknownKeys === "keep" ? { ...input } : {};
    for (const [key, field] of Object.entries(shape)) {
      const parsed = field._check(input[key], [...path, key], issues);
      if (parsed !== undefined) out[key] = parsed;
      else delete out[key];
    }
    if (unknownKeys === "reject") {
      const extra = Object.keys(input).filter((k) => !Object.hasOwn(shape, k));
      if (extra.length) issue(issues, path, value, `Unrecognized keys: ${extra.join(", ")}`, "unrecognized_keys");
    }
    return out;
  });
}

export const v = {
  string: (options?: Options) => typed<string>("string", (x) => typeof x === "string", options),
  number: (options?: Options) => typed<number>("number", (x) => typeof x === "number" && Number.isFinite(x), options),
  boolean: (options?: Options) => typed<boolean>("boolean", (x) => typeof x === "boolean", options),
  unknown: () => make<unknown>((value) => value),
  enum: <const T extends readonly string[]>(values: T, options?: Options) =>
    typed<T[number]>(values.map((x) => JSON.stringify(x)).join(" | "), (x) => values.includes(x as string), options),
  array: <S extends Schema<any, any>>(item: S, options?: Options) =>
    typed<output<S>[]>("array", Array.isArray, options, (value, path, issues) =>
      (value as unknown[]).map((x, i) => item._check(x, [...path, i], issues)),
    ) as Schema<output<S>[], input<S>[]>,
  record: <V extends Schema<any, any>>(key: Schema<string>, value: V, options?: Options) =>
    typed<Record<string, output<V>>>("object", isObject, options, (input, path, issues) => {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(input as Record<string, unknown>)) {
        key._check(k, [...path, k], issues);
        out[k] = value._check(x, [...path, k], issues);
      }
      return out;
    }) as Schema<Record<string, output<V>>, Record<string, input<V>>>,
  /** An object with these fields; other keys are dropped. */
  object: <T extends Shape>(shape: T, options?: Options) => objectOf(shape, "strip", options) as Schema<Flat<ObjectOutput<T>>>,
  /** An object with these fields; other keys are kept as they are. */
  looseObject: <T extends Shape>(shape: T, options?: Options) =>
    objectOf(shape, "keep", options) as Schema<Flat<ObjectOutput<T>> & { [key: string]: unknown }>,
  /** An object with these fields and no others. */
  strictObject: <T extends Shape>(shape: T, options?: Options) => objectOf(shape, "reject", options) as Schema<Flat<ObjectOutput<T>>>,
};

export declare namespace v {
  export type { output, input, Schema, Shape, Issue };
}
