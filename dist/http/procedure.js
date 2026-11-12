import { inputError } from "./input.js";
// src/http/procedure.ts
function procedure(def) {
	return async (ctx) => {
		const session = def.auth === "user" ? await ctx.auth() : def.auth === "optional" ? await ctx.optionalAuth() : void 0;
		const extra = def.guard ? await def.guard(ctx) : {};
		if (def.rateLimit) await ctx.rateLimit(def.rateLimit);
		let input;
		if (def.input) {
			const parsed = def.input.safeParse(await ctx.json());
			if (!parsed.success) throw inputError(parsed.error);
			input = parsed.data;
		}
		const result = await def.handler(Object.assign(ctx, extra, {
			session,
			input
		}));
		if (!def.output || result instanceof Response) return result;
		const checked = def.output.safeParse(result);
		if (!checked.success) throw new Error(`Response does not match the output schema: ${checked.error.message}`);
		return checked.data;
	};
}
export { procedure };

//# sourceMappingURL=procedure.js.map