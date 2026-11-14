import { Response } from "../node_modules/undici-types/fetch.js";
import { Homeserver } from "../homeserver.js";
export interface HandleOptions {
  ip?: string | null;
}
/** Turn a web-standard Request into a Response. */
export declare function handleRequest(hs: Homeserver, request: Request, options?: HandleOptions): Promise<Response>;
//# sourceMappingURL=handler.d.ts.map