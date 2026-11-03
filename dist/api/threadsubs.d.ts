import type { Homeserver } from "#homeserver.ts";
import type { Router } from "#http/router.ts";
/** Whether the user is subscribed to a thread: true, false (explicitly unsubscribed or never subscribed). */
export declare function isSubscribed(hs: Homeserver, userId: string, roomId: string, threadId: string): Promise<boolean>;
export declare function registerThreadSubscriptionRoutes(r: Router): void;
/** MSC4308 sliding sync extension: subscription changes in (since, to]. */
export declare function threadSubscriptionsExtension(hs: Homeserver, userId: string, ext: Record<string, any>, since: number | null, to: number): Promise<Record<string, any>>;
