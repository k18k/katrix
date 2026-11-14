import { v } from "../core/vpm.js";
import { MatrixError } from "../core/errors.js";
// src/http/input.ts
/** A request body: a JSON object whose unknown keys are kept. */
const body = (shape) => v.looseObject(shape);
/**
* Errors carry their Matrix errcode in the message, as `M_CODE: text`: `fail` builds the vpm
* error option for a field. Without one, a missing field is M_MISSING_PARAM and any other
* problem M_BAD_JSON.
*/
const fail = (errcode, message, missing) => ({ error: (issue) => issue.input === void 0 && missing ? `M_MISSING_PARAM: ${missing}` : `${errcode}: ${message}` });
/** A field that, when its value has the wrong type, is ignored (treated as absent), as Matrix clients expect for optional fields. */
const lenient = (schema) => schema.optional().catch(void 0);
/** Turn a failed body parse into the Matrix error the client sees. */
function inputError(error) {
	const issue = error.issues[0];
	const path = issue?.path.join(".") ?? "";
	const tagged = /^(M_[A-Z_]+): ([\s\S]*)$/.exec(issue?.message ?? "");
	if (tagged) return new MatrixError(400, tagged[1], tagged[2]);
	if (issue?.code === "invalid_type" && issue.input === void 0) return new MatrixError(400, "M_MISSING_PARAM", `Missing ${path || "parameter"}`);
	return new MatrixError(400, "M_BAD_JSON", path ? `Invalid ${path}: ${issue.message}` : issue?.message ?? "Bad JSON");
}
export { body, fail, inputError, lenient };

//# sourceMappingURL=input.js.map