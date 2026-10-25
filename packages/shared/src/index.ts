// @katrix/shared: what the server and the client both need. Bundled into each of them by tsdown
// (it is not published), so everything here follows the client's rules: plain ECMAScript, no
// platform APIs (packages/client/test/unit/portability.test.ts checks this package too).

export { decodeBase64, encodeBase64, Base64Error } from "./base64.ts";
export { bytesEqual, concatBytes, constantTimeEqual, fromHex, readUint32BE, toHex, writeUint32BE } from "./bytes.ts";
export { canonicalJson, CanonicalJsonError, signingJson } from "./canonical-json.ts";
export { decodeUtf8, encodeUtf8, Utf8Error } from "./utf8.ts";
export { isValidAlias, isValidRoomId, isValidServerName, isValidUserId, LOCALPART_RE, parseId } from "./ids.ts";
export { isObject } from "./json.ts";
export { M, UNSTABLE } from "./m.ts";
export type * from "./errors.ts";
export type * from "./events.ts";
export type * from "./api/index.ts";
export { endpointPath, endpointUrlPath } from "./api/endpoints.ts";
