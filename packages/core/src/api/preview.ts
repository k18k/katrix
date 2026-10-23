import { MatrixError, errors } from "#core/errors.ts";
import { randomString } from "#core/crypto.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext, Router } from "#http/router.ts";
import { procedure } from "#http/procedure.ts";
import { publicGet } from "#core/outbound.ts";

const MAX_BYTES = 1024 * 1024;

function decodeEntities(s: string): string {
  return s.replace(
    /&(amp|lt|gt|quot|#39|#x27);/g,
    (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" })[m] ?? m,
  );
}

export function parseOpenGraph(html: string): Record<string, string> {
  const og: Record<string, string> = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
    const key = attr("property") ?? attr("name");
    const content = attr("content");
    if (!key || !content) continue;
    const k = (key[1] ?? key[2]).toLowerCase();
    if (k.startsWith("og:") && !(k in og)) og[k] = decodeEntities(content[1] ?? content[2]);
    if (k === "description" && !og["og:description"]) og["og:description"] = decodeEntities(content[1] ?? content[2]);
  }
  if (!og["og:title"]) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    if (title) og["og:title"] = decodeEntities(title[1].trim());
  }
  return og;
}

async function preview(hs: Homeserver, rawUrl: string): Promise<Record<string, any>> {
  const opts = hs.config.urlPreviews;
  if (!opts) throw errors.notFound("URL previews are disabled");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw errors.invalidParam("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw errors.invalidParam("Only http(s) URLs can be previewed");
  // https://github.com/k18k/matrix-nodejs-homeserver/issues/22: the address was checked with a DNS
  // lookup and then resolved again by fetch, so a name could pass the check and still lead to a
  // private address (DNS rebinding), and the og:image fetch followed redirects unchecked. Both now
  // go through the address policy, which checks the address connected to and every redirect.
  // `urlPreviews.allowPrivateAddresses` still lets previews alone reach private addresses.
  const get = opts.allowPrivateAddresses ? hs.fetch : hs.publicFetch;
  const headers = { "user-agent": "matrix-nodejs-homeserver" };
  // Up to 10 MB for an image; an HTML page is read up to 1 MB, enough for its head.
  const res = await publicGet(get, url, { maxBytes: MAX_BYTES * 10, truncate: true, timeoutMs: 10_000, headers }).catch((err) => {
    throw err instanceof MatrixError ? err : errors.notFound("Could not fetch URL");
  });
  if (res.status !== 200) throw errors.notFound("Could not fetch URL");
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("image/")) {
    if (res.body.length >= MAX_BYTES * 10) return {};
    return { ...(await storeImage(hs, res.body, type)), "og:url": res.url.href };
  }
  if (!type.includes("html")) return {};
  const og: Record<string, any> = parseOpenGraph(res.body.subarray(0, MAX_BYTES).toString("utf8"));
  if (og["og:image"]) {
    try {
      const img = await publicGet(get, new URL(og["og:image"], res.url), { maxBytes: MAX_BYTES * 10, timeoutMs: 10_000, headers });
      const imgType = img.headers.get("content-type") ?? "";
      if (img.status === 200 && imgType.startsWith("image/")) Object.assign(og, await storeImage(hs, img.body, imgType));
    } catch {
      /* keep the preview without an image */
    }
  }
  return og;
}

/** Read width/height from PNG, GIF, JPEG or WebP headers. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Store a fetched image in the media repository and describe it for a preview. */
async function storeImage(hs: Homeserver, body: Buffer, type: string): Promise<Record<string, any>> {
  const data = new Uint8Array(body);
  const mediaId = randomString(24);
  await hs.media.put(mediaId, data, { contentType: type, filename: null, size: data.length });
  await hs.db.create("media", {
    media_id: mediaId,
    content_type: type,
    filename: null,
    size: data.length,
    uploader: "",
    created_ts: Date.now(),
    pending: false,
  });
  const size = imageSize(data);
  return {
    "og:image": `mxc://${hs.serverName}/${mediaId}`,
    "og:image:type": type,
    "matrix:image:size": data.length,
    ...(size ? { "og:image:width": size.width, "og:image:height": size.height } : {}),
  };
}

export function registerPreviewRoutes(r: Router): void {
  const handler = async (ctx: RequestContext) => {
    await ctx.auth();
    const url = ctx.query.get("url");
    if (!url) throw errors.missingParam("Missing url");
    return preview(ctx.hs, url);
  };
  r.get("/_matrix/media/v3/preview_url", procedure({ handler: handler }));
  r.get("/_matrix/media/r0/preview_url", procedure({ handler: handler }));
  r.get("/_matrix/client/v1/media/preview_url", procedure({ handler: handler }));
}
