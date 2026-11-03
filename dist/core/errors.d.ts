export declare class MatrixError extends Error {
    readonly status: number;
    readonly errcode: string;
    readonly extra: Record<string, unknown>;
    constructor(status: number, errcode: string, message: string, extra?: Record<string, unknown>);
    toJSON(): Record<string, unknown>;
}
export declare const errors: {
    forbidden: (msg?: string) => MatrixError;
    inviteBlocked: (msg?: string) => MatrixError;
    notFound: (msg?: string) => MatrixError;
    unrecognized: (msg?: string) => MatrixError;
    badJson: (msg?: string) => MatrixError;
    notJson: (msg?: string) => MatrixError;
    missingParam: (msg?: string) => MatrixError;
    invalidParam: (msg?: string) => MatrixError;
    unknownToken: (msg?: string, softLogout?: boolean) => MatrixError;
    userLocked: (msg?: string) => MatrixError;
    userSuspended: (msg?: string) => MatrixError;
    missingToken: () => MatrixError;
    userInUse: () => MatrixError;
    invalidUsername: (msg?: string) => MatrixError;
    roomInUse: () => MatrixError;
    tooLarge: (msg?: string) => MatrixError;
    unsupportedRoomVersion: () => MatrixError;
    unknown: (msg?: string) => MatrixError;
    limitExceeded: () => MatrixError;
    userDeactivated: () => MatrixError;
    invalidRoomState: (msg?: string) => MatrixError;
    exclusive: (msg?: string) => MatrixError;
    threepidDenied: () => MatrixError;
};
