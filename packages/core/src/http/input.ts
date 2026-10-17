import { z } from "zod";
import { MatrixError } from "#core/errors.ts";

// Request body schemas (zod), used as a procedure's `input` (see http/procedure.ts). Matrix
// requires servers to ignore unknown keys, so body schemas are loose objects: unknown fields pass
// through untouched.

/** A request body: a JSON object whose unknown keys are kept. */
export const body = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

/**
 * Errors carry their Matrix errcode in the message, as `M_CODE: text`: `fail` builds the zod
 * error option for a field. Without one, a missing field is M_MISSING_PARAM and any other
 * problem M_BAD_JSON.
 */
export const fail = (errcode: string, message: string, missing?: string) => ({
  error: (issue: { input?: unknown }) => (issue.input === undefined && missing ? `M_MISSING_PARAM: ${missing}` : `${errcode}: ${message}`),
});

/** A field that, when its value has the wrong type, is ignored (treated as absent), as Matrix clients expect for optional fields. */
export const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/** Turn a failed body parse into the Matrix error the client sees. */
export function inputError(error: z.ZodError): MatrixError {
  const issue = error.issues[0];
  const path = issue?.path.join(".") ?? "";
  const tagged = /^(M_[A-Z_]+): ([\s\S]*)$/.exec(issue?.message ?? "");
  if (tagged) return new MatrixError(400, tagged[1], tagged[2]);
  if (issue?.code === "invalid_type" && (issue as { input?: unknown }).input === undefined) {
    return new MatrixError(400, "M_MISSING_PARAM", `Missing ${path || "parameter"}`);
  }
  return new MatrixError(400, "M_BAD_JSON", path ? `Invalid ${path}: ${issue.message}` : (issue?.message ?? "Bad JSON"));
}
