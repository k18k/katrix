import { errors } from "#core/errors.ts";
import { canonicalJson, isObject } from "#core/json.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { jsonResponse } from "#http/handler.ts";
import { requireUia } from "#api/uia.ts";
import { v } from "#core/vpm.ts";
import { body, fail } from "#http/input.ts";
import { M } from "#core/m.ts";

const deleteDevicesBody = body({ devices: v.array(v.unknown(), fail("M_BAD_JSON", "devices must be a list")) });
const keysQueryBody = body({
  device_keys: v.record(
    v.string(),
    v.array(v.string(), fail("M_BAD_JSON", "device_keys values must be lists of device IDs")),
    fail("M_BAD_JSON", "device_keys must be an object"),
  ),
  timeout: v.unknown().optional(),
});
const keysClaimBody = body({ one_time_keys: v.record(v.string(), v.unknown(), fail("M_BAD_JSON", "one_time_keys must be an object")) });

const SERVER_MANAGED_TYPES: readonly string[] = [M.FULLY_READ, M.PUSH_RULES];

async function setAccountData(hs: Homeserver, userId: string, roomId: string, type: string, content: Record<string, any>) {
  await hs.streams.write((stream) => hs.db.upsert("account_data", { user_id: userId, room_id: roomId, type, content, stream }));
  hs.notifier.notify([userId]);
}

async function getAccountData(hs: Homeserver, userId: string, roomId: string, type: string) {
  const row = await hs.db.findOne("account_data", [
    { field: "user_id", value: userId },
    { field: "room_id", value: roomId },
    { field: "type", value: type },
  ]);
  // Deleted account data is stored as empty content.
  if (!row || Object.keys(row.content ?? {}).length === 0) throw errors.notFound("Account data not found");
  return row.content;
}

async function checkUser(ctx: RequestContext) {
  const s = await ctx.auth();
  if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot access another user's data");
  return s;
}

async function checkRoom(ctx: RequestContext) {
  if (!ctx.params.roomId.startsWith("!")) throw errors.invalidParam("Invalid room ID");
}

export function registerUserRoutes(r: Router): void {
  r.client(
    "PUT",
    "/user/:userId/account_data/:type",
    procedure({
      handler: async (ctx) => {
        const s = await checkUser(ctx);
        if (SERVER_MANAGED_TYPES.includes(ctx.params.type)) throw errors.badJson("This type is managed by the server");
        await setAccountData(ctx.hs, s.userId, "", ctx.params.type, await ctx.json());
        return {};
      },
    }),
  );
  r.client(
    "GET",
    "/user/:userId/account_data/:type",
    procedure({
      handler: async (ctx) => {
        const s = await checkUser(ctx);
        return getAccountData(ctx.hs, s.userId, "", ctx.params.type);
      },
    }),
  );
  r.client(
    "PUT",
    "/user/:userId/rooms/:roomId/account_data/:type",
    procedure({
      handler: async (ctx) => {
        const s = await checkUser(ctx);
        await checkRoom(ctx);
        if (SERVER_MANAGED_TYPES.includes(ctx.params.type)) throw errors.badJson("This type is managed by the server");
        await setAccountData(ctx.hs, s.userId, ctx.params.roomId, ctx.params.type, await ctx.json());
        return {};
      },
    }),
  );
  r.client(
    "GET",
    "/user/:userId/rooms/:roomId/account_data/:type",
    procedure({
      handler: async (ctx) => {
        const s = await checkUser(ctx);
        await checkRoom(ctx);
        return getAccountData(ctx.hs, s.userId, ctx.params.roomId, ctx.params.type);
      },
    }),
  );

  // MSC3391: deleting account data (stored as empty content, hidden from GET and initial syncs).
  const del = "/_matrix/client/unstable/org.matrix.msc3391";
  r.delete(
    `${del}/user/:userId/account_data/:type`,
    procedure({
      handler: async (ctx) => {
        const s = await checkUser(ctx);
        await setAccountData(ctx.hs, s.userId, "", ctx.params.type, {});
        return {};
      },
    }),
  );
  r.delete(
    `${del}/user/:userId/rooms/:roomId/account_data/:type`,
    procedure({
      handler: async (ctx) => {
        const s = await checkUser(ctx);
        await setAccountData(ctx.hs, s.userId, ctx.params.roomId, ctx.params.type, {});
        return {};
      },
    }),
  );

  // Tags live in the per-room `m.tag` account data.
  const readTags = async (hs: Homeserver, userId: string, roomId: string): Promise<Record<string, any>> => {
    const row = await hs.db.findOne("account_data", [
      { field: "user_id", value: userId },
      { field: "room_id", value: roomId },
      { field: "type", value: M.TAG },
    ]);
    return isObject(row?.content?.tags) ? row!.content.tags : {};
  };
  r.client(
    "GET",
    "/user/:userId/rooms/:roomId/tags",
    procedure({
      handler: async (ctx) => {
        const s = await checkUser(ctx);
        return { tags: await readTags(ctx.hs, s.userId, ctx.params.roomId) };
      },
    }),
  );
  r.client(
    "PUT",
    "/user/:userId/rooms/:roomId/tags/:tag",
    procedure({
      handler: async (ctx) => {
        const s = await checkUser(ctx);
        const body = await ctx.json();
        if (body.order !== undefined && typeof body.order !== "number") throw errors.badJson("order must be a number");
        const tags = await readTags(ctx.hs, s.userId, ctx.params.roomId);
        tags[ctx.params.tag] = body;
        await setAccountData(ctx.hs, s.userId, ctx.params.roomId, M.TAG, { tags });
        return {};
      },
    }),
  );
  r.client(
    "DELETE",
    "/user/:userId/rooms/:roomId/tags/:tag",
    procedure({
      handler: async (ctx) => {
        const s = await checkUser(ctx);
        const tags = await readTags(ctx.hs, s.userId, ctx.params.roomId);
        delete tags[ctx.params.tag];
        await setAccountData(ctx.hs, s.userId, ctx.params.roomId, M.TAG, { tags });
        return {};
      },
    }),
  );

  // --- Devices ---------------------------------------------------------------

  const formatDevice = (d: Record<string, any>) => ({
    device_id: d.device_id,
    display_name: d.display_name ?? undefined,
    last_seen_ip: d.last_seen_ip ?? undefined,
    last_seen_ts: d.last_seen_ts ?? undefined,
  });

  r.client(
    "GET",
    "/devices",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const rows = await ctx.hs.db.findMany("devices", { where: [{ field: "user_id", value: s.userId }] });
        return { devices: rows.map(formatDevice) };
      },
    }),
  );
  r.client(
    "GET",
    "/devices/:deviceId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const row = await ctx.hs.db.findOne("devices", [
          { field: "user_id", value: s.userId },
          { field: "device_id", value: ctx.params.deviceId },
        ]);
        if (!row) throw errors.notFound("Device not found");
        return formatDevice(row);
      },
    }),
  );
  r.client(
    "PUT",
    "/devices/:deviceId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const body = await ctx.json();
        const where = [
          { field: "user_id", value: s.userId },
          { field: "device_id", value: ctx.params.deviceId },
        ];
        if (body.display_name !== undefined && typeof body.display_name !== "string") throw errors.badJson("display_name must be a string");
        if (!(await ctx.hs.db.findOne("devices", where))) {
          // https://github.com/k18k/katrix/issues/85: application services create their users'
          // devices here (spec v1.17, MSC4190), answered with 201; for everyone else an unknown device is 404.
          if (!s.appservice) throw errors.notFound("Device not found");
          await ctx.hs.auth.createDevice(s.userId, ctx.params.deviceId, body.display_name);
          return jsonResponse({}, 201);
        }
        if (body.display_name !== undefined) {
          await ctx.hs.db.update("devices", where, { display_name: body.display_name });
          await ctx.hs.keys.deviceChanged(s.userId);
        }
        return {};
      },
    }),
  );
  r.client(
    "DELETE",
    "/devices/:deviceId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const body = await ctx.json();
        const where = [
          { field: "user_id", value: s.userId },
          { field: "device_id", value: ctx.params.deviceId },
        ];
        if (!(await ctx.hs.db.findOne("devices", where))) throw errors.notFound("Device not found");
        // Application services delete their users' devices without UIA (#85, MSC4190).
        if (!s.appservice) await requireUia(ctx.hs, body, [[M.LOGIN.PASSWORD]], s.userId, { session: s });
        await ctx.hs.auth.deleteDevice(s.userId, ctx.params.deviceId);
        return {};
      },
    }),
  );
  r.client(
    "POST",
    "/delete_devices",
    procedure({
      auth: "user",
      input: deleteDevicesBody,
      handler: async (ctx) => {
        const s = ctx.session;
        const body = ctx.input;
        if (!s.appservice) await requireUia(ctx.hs, body, [[M.LOGIN.PASSWORD]], s.userId, { session: s });
        for (const d of body.devices) if (typeof d === "string") await ctx.hs.auth.deleteDevice(s.userId, d);
        return {};
      },
    }),
  );

  // --- E2EE keys -------------------------------------------------------------

  // The key payloads are checked by the key service.
  r.client(
    "POST",
    "/keys/upload",
    procedure({
      auth: "user",
      input: body({}),
      handler: async (ctx) => {
        const s = ctx.session;
        return { one_time_key_counts: await ctx.hs.keys.upload(s.userId, s.deviceId, ctx.input) };
      },
    }),
  );
  r.client(
    "POST",
    "/keys/query",
    procedure({
      auth: "user",
      rateLimit: "keyQuery",
      input: keysQueryBody,
      handler: async (ctx) => {
        const s = ctx.session;
        const body = ctx.input;
        return ctx.hs.keys.query(s.userId, body.device_keys, Math.min(Number(body.timeout ?? 10_000) || 10_000, 30_000));
      },
    }),
  );
  r.client(
    "POST",
    "/keys/claim",
    procedure({
      auth: "user",
      input: keysClaimBody,
      handler: async (ctx) => {
        const body = ctx.input;
        const local: Record<string, Record<string, string>> = {};
        const remote: Record<string, Record<string, string>> = {};
        for (const [userId, devices] of Object.entries(body.one_time_keys))
          (ctx.hs.isLocalUser(userId) ? local : remote)[userId] = devices as Record<string, string>;
        const claimed = await ctx.hs.keys.claim(local);
        const fed = Object.keys(remote).length ? await ctx.hs.federation.claimKeys(remote) : { results: {}, failures: {} };
        return { one_time_keys: { ...claimed, ...fed.results }, failures: fed.failures };
      },
    }),
  );
  r.client(
    "GET",
    "/keys/changes",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const parse = (v: string | null) => {
          const m = /^s?(\d+)/.exec(v ?? "");
          if (!m) throw errors.invalidParam("Invalid token");
          return Number(m[1]);
        };
        return ctx.hs.keys.changesSince(s.userId, parse(ctx.query.get("from")), parse(ctx.query.get("to")));
      },
    }),
  );
  // The keys themselves are checked by the key service.
  r.client(
    "POST",
    "/keys/device_signing/upload",
    procedure({
      auth: "user",
      input: body({}),
      handler: async (ctx) => {
        const s = ctx.session;
        const body: Record<string, any> = ctx.input;
        const existing = await ctx.hs.db.findOne("cross_signing_keys", [
          { field: "user_id", value: s.userId },
          { field: "key_type", value: "master" },
        ]);
        // Once cross-signing is set up, changing keys requires re-authentication (MSC3967);
        // re-uploading exactly the keys we already have is a no-op that needs none.
        if (existing) {
          const stored = new Map(
            (await ctx.hs.db.findMany("cross_signing_keys", { where: [{ field: "user_id", value: s.userId }] })).map((row) => [
              row.key_type,
              canonicalJson(row.key),
            ]),
          );
          const types = ["master", "self_signing", "user_signing"].filter((type) => body[`${type}_key`] !== undefined);
          if (types.every((type) => stored.get(type) === canonicalJson(body[`${type}_key`]))) return {};
          await requireUia(ctx.hs, body, [[M.LOGIN.PASSWORD]], s.userId, { session: s, crossSigningReset: true });
        }
        await ctx.hs.keys.uploadCrossSigning(s.userId, body);
        return {};
      },
    }),
  );
  r.client(
    "POST",
    "/keys/signatures/upload",
    procedure({
      auth: "user",
      input: body({}),
      handler: async (ctx) => {
        const s = ctx.session;
        return ctx.hs.keys.uploadSignatures(s.userId, ctx.input);
      },
    }),
  );

  r.client(
    "PUT",
    "/sendToDevice/:eventType/:txnId",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const hs = ctx.hs;
        const body = await ctx.json();
        if (!isObject(body.messages)) throw errors.badJson("messages must be an object");
        const txnKey = `${s.userId}|${s.deviceId}|${ctx.params.txnId}`;
        if (!(await hs.cluster.setIfAbsent(`todevice-txn:${txnKey}`, true, 24 * 3600_000))) return {};
        const recipients = new Set<string>();
        for (const [userId, devices] of Object.entries(body.messages)) {
          if (!isObject(devices) || !hs.isLocalUser(userId)) continue;
          let targets = Object.keys(devices);
          if (targets.includes("*")) {
            targets = (await hs.db.findMany("devices", { where: [{ field: "user_id", value: userId }] })).map((d) => d.device_id);
          }
          for (const deviceId of targets) {
            const content = devices[deviceId] ?? devices["*"];
            await hs.streams.write((stream) =>
              hs.db.create("to_device", {
                stream,
                user_id: userId,
                device_id: deviceId,
                sender: s.userId,
                type: ctx.params.eventType,
                content,
              }),
            );
          }
          recipients.add(userId);
        }
        hs.notifier.notify(recipients);
        await hs.federation.sendToDevice(s.userId, ctx.params.eventType, body.messages, `${s.deviceId}-${ctx.params.txnId}`);
        return {};
      },
    }),
  );
}
