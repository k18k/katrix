import { MatrixError, errors } from "../core/errors.ts";
import { isObject } from "../core/json.ts";
import type { Homeserver } from "../homeserver.ts";
import type { RequestContext, Router } from "../http/router.ts";

// MSC4306: thread subscriptions. A subscription is either manual or "automatic" (made by a
// client in reaction to an event in the thread). Unsubscribing records the stream position so
// that automatic subscriptions caused by older events cannot silently resubscribe the user.

const VERSIONS = ["unstable/io.element.msc4306"];

const notInThread = () => new MatrixError(400, "IO.ELEMENT.MSC4306.M_NOT_IN_THREAD", "Event is not in this thread");
const conflicting = () => new MatrixError(409, "IO.ELEMENT.MSC4306.M_CONFLICTING_UNSUBSCRIPTION", "The thread was unsubscribed after this event");

function key(userId: string, roomId: string, threadId: string) {
  return [{ field: "user_id", value: userId }, { field: "room_id", value: roomId }, { field: "thread_id", value: threadId }];
}

/** Whether the user is subscribed to a thread: true, false (explicitly unsubscribed or never subscribed). */
export async function isSubscribed(hs: Homeserver, userId: string, roomId: string, threadId: string): Promise<boolean> {
  const row = await hs.db.findOne("thread_subscriptions", key(userId, roomId, threadId));
  return !!row?.subscribed;
}

async function visibleEvent(ctx: RequestContext, userId: string, roomId: string, eventId: string) {
  const ev = await ctx.hs.rooms.getEvent(eventId);
  if (!ev || ev.pdu.room_id !== roomId) return null;
  const [visible] = await ctx.hs.rooms.filterVisible(userId, roomId, [ev]);
  return visible ?? null;
}

async function threadRoot(ctx: RequestContext, userId: string) {
  const { roomId, threadId } = ctx.params;
  const root = await visibleEvent(ctx, userId, roomId, threadId);
  if (!root) throw errors.notFound("Unknown thread root");
  return root;
}

export function registerThreadSubscriptionRoutes(r: Router): void {
  const path = "/rooms/:roomId/thread/:threadId/subscription";

  r.client("GET", path, async (ctx) => {
    const s = await ctx.auth();
    await threadRoot(ctx, s.userId);
    const row = await ctx.hs.db.findOne("thread_subscriptions", key(s.userId, ctx.params.roomId, ctx.params.threadId));
    if (!row?.subscribed) throw errors.notFound("Not subscribed to this thread");
    return { automatic: !!row.automatic };
  }, VERSIONS);

  r.client("PUT", path, async (ctx) => {
    const s = await ctx.auth();
    const hs = ctx.hs;
    const { roomId, threadId } = ctx.params;
    await threadRoot(ctx, s.userId);
    const body = await ctx.json();
    const cause = isObject(body) ? body.automatic : undefined;
    if (cause !== undefined && typeof cause !== "string") throw errors.badJson("automatic must be an event ID");
    let causeStream: number | null = null;
    if (typeof cause === "string") {
      const ev = await visibleEvent(ctx, s.userId, roomId, cause);
      const rel = ev?.pdu.content?.["m.relates_to"];
      if (!ev || !isObject(rel) || rel.rel_type !== "m.thread" || rel.event_id !== threadId) throw notInThread();
      causeStream = ev.stream;
    }
    await hs.cluster.lock(`threadsub:${s.userId}:${roomId}:${threadId}`, async () => {
      const row = await hs.db.findOne("thread_subscriptions", key(s.userId, roomId, threadId));
      if (causeStream !== null) {
        if (row && row.unsubscribed_after !== null && causeStream <= row.unsubscribed_after) throw conflicting();
        // An automatic subscription never downgrades an existing one.
        if (row?.subscribed) return;
      } else if (row?.subscribed && !row.automatic) return;
      await hs.streams.write((stream) => hs.db.upsert("thread_subscriptions", {
        user_id: s.userId, room_id: roomId, thread_id: threadId, subscribed: true,
        automatic: causeStream !== null, unsubscribed_after: row?.unsubscribed_after ?? null, stream,
      }));
    });
    hs.notifier.notify([s.userId]);
    return {};
  }, VERSIONS);

  r.client("DELETE", path, async (ctx) => {
    const s = await ctx.auth();
    const hs = ctx.hs;
    const { roomId, threadId } = ctx.params;
    await threadRoot(ctx, s.userId);
    await hs.cluster.lock(`threadsub:${s.userId}:${roomId}:${threadId}`, async () => {
      const row = await hs.db.findOne("thread_subscriptions", key(s.userId, roomId, threadId));
      if (!row?.subscribed) return;
      const position = await hs.streams.position();
      await hs.streams.write((stream) => hs.db.upsert("thread_subscriptions", {
        user_id: s.userId, room_id: roomId, thread_id: threadId, subscribed: false, automatic: false, unsubscribed_after: position, stream,
      }));
    });
    hs.notifier.notify([s.userId]);
    return {};
  }, VERSIONS);
}

/** MSC4308 sliding sync extension: subscription changes in (since, to]. */
export async function threadSubscriptionsExtension(hs: Homeserver, userId: string, ext: Record<string, any>, since: number | null, to: number) {
  const limit = Math.min(Math.max(Number(ext.limit ?? 100) || 100, 1), 1000);
  const where: any[] = [{ field: "user_id", value: userId }];
  if (since !== null) where.push({ field: "stream", operator: "gt", value: since });
  const rows = (await hs.db.findMany("thread_subscriptions", { where }))
    .filter((r) => r.stream <= to && (since !== null || r.subscribed))
    .sort((a, b) => b.stream - a.stream);
  const out: Record<string, any> = {};
  for (const row of rows.slice(0, limit)) {
    const section = row.subscribed ? "subscribed" : "unsubscribed";
    ((out[section] ??= {})[row.room_id] ??= {})[row.thread_id] = row.subscribed
      ? { automatic: !!row.automatic, bump_stamp: row.stream }
      : { bump_stamp: row.stream };
  }
  if (rows.length > limit) out.prev_batch = String(rows[limit - 1].stream);
  return out;
}
