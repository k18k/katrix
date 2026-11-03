export declare const LOCALPART_RE: RegExp;
export declare function parseId(id: string, sigil: string): {
    localpart: string;
    server: string;
} | null;
export declare function isValidServerName(name: string): boolean;
export declare function isValidUserId(id: unknown): id is string;
export declare function isValidRoomId(id: unknown): id is string;
export declare function isValidAlias(id: unknown): id is string;
export declare function generateRoomId(serverName: string): string;
export declare function generateDeviceId(): string;
