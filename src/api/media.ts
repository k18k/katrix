import { MatrixError, errors } from "#core/errors.ts";
import { randomString } from "#core/crypto.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";

const DEFAULT_MAX_UPLOAD = 50 * 1024 * 1024;
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|apng)|video\/(mp4|webm|ogg)|audio\/(mpeg|ogg|wav|webm|mp4|aac|flac)|text\/plain)$/;

const maxUpload = (hs: Homeserver) => hs.media.maxUploadSize ?? DEFAULT_MAX_UPLOAD;

async function storeUpload(ctx: RequestContext, mediaId: string): Promise<void> {
  const hs = ctx.hs;
  const data = await ctx.bytes();
  if (data.length > maxUpload(hs)) throw errors.tooLarge("Upload too large");
  const contentType = ctx.request.headers.get("content-type");
  const filename = ctx.query.get("filename");
  await hs.media.put(mediaId, data, { contentType, filename, size: data.length });
  return void (await hs.db.upsert("media", {
    media_id: mediaId,
    content_type: contentType,
    filename,
    size: data.length,
    uploader: (await ctx.auth()).userId,
    created_ts: Date.now(),
    pending: false,
  }));
}

function contentDisposition(contentType: string | null, filename: string | null): string {
  const type = INLINE_TYPES.test(contentType ?? "") ? "inline" : "attachment";
  return filename ? `${type}; filename*=utf-8''${encodeURIComponent(filename)}` : type;
}

/** Fetch (and cache) media from another server. */
async function remoteMedia(ctx: RequestContext): Promise<{ data: Uint8Array; contentType: string | null; filename: string | null }> {
  const hs = ctx.hs;
  const { serverName, mediaId } = ctx.params;
  if (ctx.query.get("allow_remote") === "false") throw errors.notFound("Remote media not allowed");
  const cached = await hs.db.findOne("remote_media", [
    { field: "server_name", value: serverName },
    { field: "media_id", value: mediaId },
  ]);
  if (cached) {
    const data = await hs.media.get(cached.local_id);
    if (data) return { data, contentType: cached.content_type, filename: cached.filename };
  }
  let fetched;
  try {
    fetched = await hs.federation.fetchMedia(serverName, mediaId);
  } catch (err) {
    if (err instanceof MatrixError) throw err;
    throw new MatrixError(502, "M_UNKNOWN", "Could not fetch remote media");
  }
  if (fetched.data.length > maxUpload(hs)) throw errors.tooLarge("Remote media too large");
  const localId = `remote_${randomString(24)}`;
  await hs.media.put(localId, fetched.data, { contentType: fetched.contentType, filename: fetched.filename, size: fetched.data.length });
  await hs.db.upsert("remote_media", {
    server_name: serverName,
    media_id: mediaId,
    local_id: localId,
    content_type: fetched.contentType,
    filename: fetched.filename,
    size: fetched.data.length,
    fetched_ts: Date.now(),
  });
  return fetched;
}

async function download(ctx: RequestContext): Promise<Response> {
  const hs = ctx.hs;
  const { serverName, mediaId } = ctx.params;
  if (serverName !== hs.serverName) {
    const remote = await remoteMedia(ctx);
    const filename = ctx.params.fileName ?? remote.filename;
    return new Response(remote.data as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "content-type": remote.contentType ?? "application/octet-stream",
        "content-disposition": contentDisposition(remote.contentType, filename),
        "content-security-policy":
          "sandbox; default-src 'none'; script-src 'none'; plugin-types application/pdf; style-src 'unsafe-inline'; media-src 'self'; object-src 'self';",
        "cross-origin-resource-policy": "cross-origin",
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  }
  const meta = await hs.db.findOne("media", [{ field: "media_id", value: mediaId }]);
  if (!meta) throw errors.notFound("Media not found");
  if (meta.pending) throw new MatrixError(504, "M_NOT_YET_UPLOADED", "Media has not been uploaded yet");
  const data = await hs.media.get(mediaId);
  if (!data) throw errors.notFound("Media not found");
  const filename = ctx.params.fileName ?? meta.filename;
  return new Response(data as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      "content-type": meta.content_type ?? "application/octet-stream",
      "content-disposition": contentDisposition(meta.content_type, filename),
      "content-security-policy":
        "sandbox; default-src 'none'; script-src 'none'; plugin-types application/pdf; style-src 'unsafe-inline'; media-src 'self'; object-src 'self';",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=86400, immutable",
    },
  });
}

/** Serve a thumbnail, generating and caching it with the configured thumbnailer. */
async function thumbnail(ctx: RequestContext): Promise<Response> {
  const hs = ctx.hs;
  const width = Number.parseInt(ctx.query.get("width") ?? "", 10);
  const height = Number.parseInt(ctx.query.get("height") ?? "", 10);
  if (!(width > 0) || !(height > 0)) throw errors.invalidParam("width and height must be positive integers");
  const method = ctx.query.get("method") === "crop" ? "crop" : "scale";
  const animated = ctx.query.get("animated") === "true";
  const { serverName, mediaId } = ctx.params;
  if (serverName !== hs.serverName || !hs.config.thumbnailer) return download(ctx);
  const meta = await hs.db.findOne("media", [{ field: "media_id", value: mediaId }]);
  if (!meta || meta.pending || !meta.content_type?.startsWith("image/")) return download(ctx);
  // Snap to a small set of sizes so the cache stays bounded.
  const sizes = [32, 96, 320, 640, 800, 1280];
  const w = sizes.find((s) => s >= width) ?? 1280;
  const h = sizes.find((s) => s >= height) ?? 1280;
  const thumbId = `${mediaId}_thumb_${w}x${h}_${method}${animated ? "_a" : ""}`;
  let thumb = await hs.media.get(thumbId);
  let contentType = (await hs.db.findOne("media", [{ field: "media_id", value: thumbId }]))?.content_type ?? null;
  if (!thumb || !contentType) {
    const original = await hs.media.get(mediaId);
    if (!original) throw errors.notFound("Media not found");
    const made = await hs.config.thumbnailer(original, meta.content_type, { width: w, height: h, method, animated }).catch((err) => {
      hs.logger.warn("Thumbnailing failed", mediaId, err);
      return null;
    });
    if (!made) return download(ctx);
    thumb = made.data;
    contentType = made.contentType;
    await hs.media.put(thumbId, thumb, { contentType, filename: null, size: thumb.length });
    await hs.db.upsert("media", {
      media_id: thumbId,
      content_type: contentType,
      filename: null,
      size: thumb.length,
      uploader: "",
      created_ts: Date.now(),
      pending: false,
    });
  }
  return new Response(thumb as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": "inline",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=86400, immutable",
    },
  });
}

export function registerMediaRoutes(r: Router): void {
  const config = (ctx: RequestContext) => ({ "m.upload.size": maxUpload(ctx.hs) });
  r.get("/_matrix/media/v3/config", async (ctx) => {
    await ctx.auth();
    return config(ctx);
  });
  r.get("/_matrix/media/r0/config", async (ctx) => {
    await ctx.auth();
    return config(ctx);
  });
  r.get("/_matrix/client/v1/media/config", async (ctx) => {
    await ctx.auth();
    return config(ctx);
  });

  const upload = async (ctx: RequestContext) => {
    await ctx.auth();
    await ctx.rateLimit("upload");
    const mediaId = randomString(24);
    await storeUpload(ctx, mediaId);
    return { content_uri: `mxc://${ctx.hs.serverName}/${mediaId}` };
  };
  r.post("/_matrix/media/v3/upload", upload);
  r.post("/_matrix/media/r0/upload", upload);

  r.post("/_matrix/media/v1/create", async (ctx) => {
    const s = await ctx.auth();
    const mediaId = randomString(24);
    await ctx.hs.db.create("media", {
      media_id: mediaId,
      content_type: null,
      filename: null,
      size: 0,
      uploader: s.userId,
      created_ts: Date.now(),
      pending: true,
    });
    return { content_uri: `mxc://${ctx.hs.serverName}/${mediaId}`, unused_expires_at: Date.now() + 24 * 3600_000 };
  });

  r.put("/_matrix/media/v3/upload/:serverName/:mediaId", async (ctx) => {
    const s = await ctx.auth();
    if (ctx.params.serverName !== ctx.hs.serverName) throw errors.notFound("Unknown media");
    const meta = await ctx.hs.db.findOne("media", [{ field: "media_id", value: ctx.params.mediaId }]);
    if (!meta) throw errors.notFound("Unknown media");
    if (meta.uploader !== s.userId) throw errors.forbidden("You did not create this media ID");
    if (!meta.pending) throw new MatrixError(409, "M_CANNOT_OVERWRITE_MEDIA", "Media already uploaded");
    await storeUpload(ctx, ctx.params.mediaId);
    return {};
  });

  // Legacy unauthenticated endpoints and authenticated (v1.11) endpoints.
  for (const prefix of ["/_matrix/media/v3", "/_matrix/media/r0"]) {
    r.get(`${prefix}/download/:serverName/:mediaId`, download);
    r.get(`${prefix}/download/:serverName/:mediaId/:fileName`, download);
    r.get(`${prefix}/thumbnail/:serverName/:mediaId`, thumbnail);
  }
  const authed = async (ctx: RequestContext) => {
    await ctx.auth();
    return download(ctx);
  };
  r.get("/_matrix/client/v1/media/download/:serverName/:mediaId", authed);
  r.get("/_matrix/client/v1/media/download/:serverName/:mediaId/:fileName", authed);
  r.get("/_matrix/client/v1/media/thumbnail/:serverName/:mediaId", async (ctx) => {
    await ctx.auth();
    return thumbnail(ctx);
  });
}
