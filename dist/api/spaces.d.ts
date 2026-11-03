import type { Homeserver } from "#homeserver.ts";
import type { Router } from "#http/router.ts";
/** Room-level details shared by /hierarchy, /room_summary and /publicRooms. */
export declare function roomDetails(hs: Homeserver, roomId: string): Promise<Record<string, any>>;
export declare function registerSpaceRoutes(r: Router): void;
