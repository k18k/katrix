import { isObject } from "@katrix/shared";
import { MatrixError, errors } from "#core/errors.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { v } from "#core/vpm.ts";
import { body, fail } from "#http/input.ts";

const required = fail("M_BAD_JSON", "algorithm and auth_data are required");
const createVersionBody = body({ algorithm: v.string(required), auth_data: v.looseObject({}, required) });

/** Server-side room key backups (`/room_keys`). */

async function latestVersion(hs: Homeserver, userId: string) {
  const rows = await hs.db.findMany("backup_versions", {
    where: [
      { field: "user_id", value: userId },
      { field: "deleted", value: false },
    ],
    sortBy: { field: "version", direction: "desc" },
    limit: 1,
  });
  return rows[0] ?? null;
}

async function getVersion(hs: Homeserver, userId: string, version: string | null) {
  if (version === null) return latestVersion(hs, userId);
  const n = Number(version);
  if (!Number.isInteger(n)) return null;
  const row = await hs.db.findOne("backup_versions", [
    { field: "user_id", value: userId },
    { field: "version", value: n },
  ]);
  return row && !row.deleted ? row : null;
}

async function countKeys(hs: Homeserver, userId: string, version: number): Promise<number> {
  return (
    await hs.db.findMany("backup_keys", {
      where: [
        { field: "user_id", value: userId },
        { field: "version", value: version },
      ],
    })
  ).length;
}

async function describe(hs: Homeserver, row: Record<string, any>) {
  return {
    algorithm: row.algorithm,
    auth_data: row.auth_data,
    version: String(row.version),
    etag: String(row.etag),
    count: await countKeys(hs, row.user_id, row.version),
  };
}

/** Whether `incoming` should replace `existing` according to the spec's key-selection rules. */
function better(incoming: Record<string, any>, existing: Record<string, any> | null): boolean {
  if (!existing) return true;
  if (!!incoming.is_verified !== !!existing.is_verified) return !!incoming.is_verified;
  if (incoming.first_message_index !== existing.first_message_index) return incoming.first_message_index < existing.first_message_index;
  return incoming.forwarded_count < existing.forwarded_count;
}

async function requireCurrentVersion(ctx: RequestContext, userId: string) {
  const version = ctx.query.get("version");
  if (!version) throw errors.missingParam("Missing version");
  const row = await getVersion(ctx.hs, userId, version);
  if (!row) throw errors.notFound("Unknown backup version");
  const latest = await latestVersion(ctx.hs, userId);
  return { row, isLatest: latest?.version === row.version };
}

export function registerBackupRoutes(r: Router): void {
  r.client(
    "POST",
    "/room_keys/version",
    procedure({
      auth: "user",
      input: createVersionBody,
      handler: async (ctx) => {
        const s = ctx.session;
        const body = ctx.input;
        const max = (await ctx.hs.db.findMany("backup_versions", { where: [{ field: "user_id", value: s.userId }] })).reduce(
          (m, v) => Math.max(m, v.version),
          0,
        );
        await ctx.hs.db.create("backup_versions", {
          user_id: s.userId,
          version: max + 1,
          algorithm: body.algorithm,
          auth_data: body.auth_data,
          etag: 0,
          deleted: false,
        });
        return { version: String(max + 1) };
      },
    }),
  );

  const getVersionHandler = async (ctx: RequestContext) => {
    const s = await ctx.auth();
    const row = await getVersion(ctx.hs, s.userId, ctx.params.version ?? null);
    if (!row) throw errors.notFound("No backup found");
    return describe(ctx.hs, row);
  };
  r.client("GET", "/room_keys/version", procedure({ handler: getVersionHandler }));
  r.client("GET", "/room_keys/version/:version", procedure({ handler: getVersionHandler }));

  r.client(
    "PUT",
    "/room_keys/version/:version",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const body = await ctx.json();
        const row = await getVersion(ctx.hs, s.userId, ctx.params.version);
        if (!row) throw errors.notFound("Unknown backup version");
        if (body.version !== undefined && String(body.version) !== ctx.params.version) throw errors.invalidParam("Version mismatch");
        if (body.algorithm !== row.algorithm) throw errors.invalidParam("Algorithm cannot be changed");
        if (!isObject(body.auth_data)) throw errors.badJson("auth_data is required");
        await ctx.hs.db.update(
          "backup_versions",
          [
            { field: "user_id", value: s.userId },
            { field: "version", value: row.version },
          ],
          { auth_data: body.auth_data },
        );
        return {};
      },
    }),
  );

  r.client(
    "DELETE",
    "/room_keys/version/:version",
    procedure({
      auth: "user",
      handler: async (ctx) => {
        const s = ctx.session;
        const row = await getVersion(ctx.hs, s.userId, ctx.params.version);
        if (!row) throw errors.notFound("Unknown backup version");
        await ctx.hs.db.update(
          "backup_versions",
          [
            { field: "user_id", value: s.userId },
            { field: "version", value: row.version },
          ],
          { deleted: true },
        );
        await ctx.hs.db.delete("backup_keys", [
          { field: "user_id", value: s.userId },
          { field: "version", value: row.version },
        ]);
        return {};
      },
    }),
  );

  const putKeys = async (ctx: RequestContext) => {
    const s = await ctx.auth();
    const hs = ctx.hs;
    const { row, isLatest } = await requireCurrentVersion(ctx, s.userId);
    if (!isLatest) {
      const latest = await latestVersion(hs, s.userId);
      throw new MatrixError(403, "M_WRONG_ROOM_KEYS_VERSION", "Wrong backup version", { current_version: String(latest?.version ?? "") });
    }
    const body = await ctx.json();
    let rooms: Record<string, any>;
    if (ctx.params.sessionId) rooms = { [ctx.params.roomId]: { sessions: { [ctx.params.sessionId]: body } } };
    else if (ctx.params.roomId) rooms = { [ctx.params.roomId]: body };
    else rooms = body.rooms ?? {};
    let changed = false;
    for (const [roomId, room] of Object.entries(rooms)) {
      if (!isObject(room) || !isObject(room.sessions)) continue;
      for (const [sessionId, data] of Object.entries(room.sessions)) {
        const where = [
          { field: "user_id", value: s.userId },
          { field: "version", value: row.version },
          { field: "room_id", value: roomId },
          { field: "session_id", value: sessionId },
        ];
        const existing = await hs.db.findOne("backup_keys", where);
        if (!better(data as Record<string, any>, existing?.data ?? null)) continue;
        await hs.db.upsert("backup_keys", { user_id: s.userId, version: row.version, room_id: roomId, session_id: sessionId, data });
        changed = true;
      }
    }
    const etag = changed ? row.etag + 1 : row.etag;
    if (changed)
      await hs.db.update(
        "backup_versions",
        [
          { field: "user_id", value: s.userId },
          { field: "version", value: row.version },
        ],
        { etag },
      );
    return { etag: String(etag), count: await countKeys(hs, s.userId, row.version) };
  };

  const getKeys = async (ctx: RequestContext) => {
    const s = await ctx.auth();
    const { row } = await requireCurrentVersion(ctx, s.userId);
    const where: any[] = [
      { field: "user_id", value: s.userId },
      { field: "version", value: row.version },
    ];
    if (ctx.params.roomId) where.push({ field: "room_id", value: ctx.params.roomId });
    if (ctx.params.sessionId) where.push({ field: "session_id", value: ctx.params.sessionId });
    const keys = await ctx.hs.db.findMany("backup_keys", { where });
    if (ctx.params.sessionId) {
      if (!keys[0]) throw errors.notFound("Key not found");
      return keys[0].data;
    }
    const rooms: Record<string, any> = {};
    for (const k of keys) (rooms[k.room_id] ??= { sessions: {} }).sessions[k.session_id] = k.data;
    if (ctx.params.roomId) return rooms[ctx.params.roomId] ?? { sessions: {} };
    return { rooms };
  };

  const deleteKeys = async (ctx: RequestContext) => {
    const s = await ctx.auth();
    const { row } = await requireCurrentVersion(ctx, s.userId);
    const where: any[] = [
      { field: "user_id", value: s.userId },
      { field: "version", value: row.version },
    ];
    if (ctx.params.roomId) where.push({ field: "room_id", value: ctx.params.roomId });
    if (ctx.params.sessionId) where.push({ field: "session_id", value: ctx.params.sessionId });
    await ctx.hs.db.delete("backup_keys", where);
    const etag = row.etag + 1;
    await ctx.hs.db.update(
      "backup_versions",
      [
        { field: "user_id", value: s.userId },
        { field: "version", value: row.version },
      ],
      { etag },
    );
    return { etag: String(etag), count: await countKeys(ctx.hs, s.userId, row.version) };
  };

  for (const path of ["/room_keys/keys", "/room_keys/keys/:roomId", "/room_keys/keys/:roomId/:sessionId"]) {
    r.client("PUT", path, procedure({ handler: putKeys }));
    r.client("GET", path, procedure({ handler: getKeys }));
    r.client("DELETE", path, procedure({ handler: deleteKeys }));
  }
}
