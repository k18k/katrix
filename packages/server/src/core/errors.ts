export class MatrixError extends Error {
  readonly status: number;
  readonly errcode: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, errcode: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.errcode = errcode;
    this.extra = extra;
  }

  toJSON(): Record<string, unknown> {
    return { errcode: this.errcode, error: this.message, ...this.extra };
  }
}

export const errors = {
  forbidden: (msg = "Forbidden") => new MatrixError(403, "M_FORBIDDEN", msg),
  inviteBlocked: (msg = "This user does not accept invites from you") => new MatrixError(403, "M_INVITE_BLOCKED", msg),
  notFound: (msg = "Not found") => new MatrixError(404, "M_NOT_FOUND", msg),
  unrecognized: (msg = "Unrecognized request") => new MatrixError(404, "M_UNRECOGNIZED", msg),
  badJson: (msg = "Bad JSON") => new MatrixError(400, "M_BAD_JSON", msg),
  notJson: (msg = "Content not JSON") => new MatrixError(400, "M_NOT_JSON", msg),
  missingParam: (msg = "Missing parameter") => new MatrixError(400, "M_MISSING_PARAM", msg),
  invalidParam: (msg = "Invalid parameter") => new MatrixError(400, "M_INVALID_PARAM", msg),
  unknownToken: (msg = "Unknown access token", softLogout = false) =>
    new MatrixError(401, "M_UNKNOWN_TOKEN", msg, { soft_logout: softLogout }),
  userLocked: (msg = "This account has been locked") => new MatrixError(401, "M_USER_LOCKED", msg, { soft_logout: true }),
  userSuspended: (msg = "You cannot perform this action while suspended.") => new MatrixError(403, "M_USER_SUSPENDED", msg),
  missingToken: () => new MatrixError(401, "M_MISSING_TOKEN", "Missing access token"),
  userInUse: () => new MatrixError(400, "M_USER_IN_USE", "User ID already taken"),
  invalidUsername: (msg = "Invalid username") => new MatrixError(400, "M_INVALID_USERNAME", msg),
  roomInUse: () => new MatrixError(400, "M_ROOM_IN_USE", "Room alias already taken"),
  tooLarge: (msg = "Too large") => new MatrixError(413, "M_TOO_LARGE", msg),
  unsupportedRoomVersion: () => new MatrixError(400, "M_UNSUPPORTED_ROOM_VERSION", "Unsupported room version"),
  unknown: (msg = "Unknown error") => new MatrixError(400, "M_UNKNOWN", msg),
  limitExceeded: () => new MatrixError(429, "M_LIMIT_EXCEEDED", "Too many requests"),
  userDeactivated: () => new MatrixError(403, "M_USER_DEACTIVATED", "User is deactivated"),
  invalidRoomState: (msg = "Invalid room state") => new MatrixError(400, "M_INVALID_ROOM_STATE", msg),
  exclusive: (msg = "Exclusive namespace") => new MatrixError(400, "M_EXCLUSIVE", msg),
  threepidDenied: () => new MatrixError(403, "M_THREEPID_DENIED", "Third party identifiers are not supported"),
};
