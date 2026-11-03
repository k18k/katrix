import { type StateMap } from "#core/authrules.ts";
import { type Session } from "#core/auth.ts";
import type { Homeserver } from "#homeserver.ts";
import type { Router } from "#http/router.ts";
export declare const parseToken: (token: string | null) => number | null;
export declare const viewerOf: (s: Session) => {
    userId: string;
    deviceId: string;
};
export declare function requireRoom(hs: Homeserver, roomId: string): Promise<string>;
/**
 * State visible to the user: current state when joined (or world readable),
 * otherwise the state at the moment they left.
 */
export declare function visibleState(hs: Homeserver, roomId: string, userId: string): Promise<StateMap>;
export declare function ownEvent(hs: Homeserver, userId: string, eventId: unknown): Promise<boolean>;
export declare function registerRoomRoutes(r: Router): void;
