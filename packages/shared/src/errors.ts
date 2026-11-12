/** The body of an error response (https://spec.matrix.org/v1.16/client-server-api/#standard-error-response). */
export interface MatrixErrorBody {
  errcode: string;
  error?: string;
  /** M_LIMIT_EXCEEDED. */
  retry_after_ms?: number;
  /** M_UNKNOWN_TOKEN. */
  soft_logout?: boolean;
  [key: string]: unknown;
}

/** Error codes of the Client-Server API (https://spec.matrix.org/v1.16/client-server-api/#common-error-codes and others). */
export type KnownErrcode =
  | "M_FORBIDDEN"
  | "M_UNKNOWN_TOKEN"
  | "M_MISSING_TOKEN"
  | "M_USER_LOCKED"
  | "M_USER_SUSPENDED"
  | "M_BAD_JSON"
  | "M_NOT_JSON"
  | "M_NOT_FOUND"
  | "M_LIMIT_EXCEEDED"
  | "M_UNRECOGNIZED"
  | "M_UNKNOWN"
  | "M_UNAUTHORIZED"
  | "M_USER_DEACTIVATED"
  | "M_USER_IN_USE"
  | "M_INVALID_USERNAME"
  | "M_ROOM_IN_USE"
  | "M_INVALID_ROOM_STATE"
  | "M_THREEPID_IN_USE"
  | "M_THREEPID_NOT_FOUND"
  | "M_THREEPID_AUTH_FAILED"
  | "M_THREEPID_DENIED"
  | "M_SERVER_NOT_TRUSTED"
  | "M_UNSUPPORTED_ROOM_VERSION"
  | "M_INCOMPATIBLE_ROOM_VERSION"
  | "M_BAD_STATE"
  | "M_GUEST_ACCESS_FORBIDDEN"
  | "M_CAPTCHA_NEEDED"
  | "M_CAPTCHA_INVALID"
  | "M_MISSING_PARAM"
  | "M_INVALID_PARAM"
  | "M_TOO_LARGE"
  | "M_EXCLUSIVE"
  | "M_RESOURCE_LIMIT_EXCEEDED"
  | "M_CANNOT_LEAVE_SERVER_NOTICE_ROOM"
  | "M_WEAK_PASSWORD"
  | "M_UNABLE_TO_AUTHORISE_JOIN"
  | "M_UNABLE_TO_GRANT_JOIN";
