import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { errors } from "../core/errors.ts";
import { randomString } from "../core/crypto.ts";
import type { Homeserver } from "../homeserver.ts";
import type { RequestContext, Router } from "../http/router.ts";

const MAX_BYTES = 1024 * 1024;

const privateRanges = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  privateRanges.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["::ffff:0:0", 96]] as const) {
  privateRanges.addSubnet(net, prefix, "ipv6");
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const { address, family } of addresses) {
    if (privateRanges.check(address, family === 6 ? "ipv6" : "ipv4")) throw errors.forbidden("URL resolves to a private address");
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" })[m] ?? m);
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
  try { url = new URL(rawUrl); } catch { throw errors.invalidParam("Invalid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw errors.invalidParam("Only http(s) URLs can be previewed");
  for (let redirects = 0; redirects < 5; redirects++) {
    if (!opts.allowPrivateAddresses) await assertPublicHost(url.hostname);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "matrix-nodejs-homeserver" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok || !res.body) throw errors.notFound("Could not fetch URL");
    const type = res.headers.get("content-type") ?? "";
    if (type.startsWith("image/")) return { ...(await storeImage(hs, res, type)), "og:url": url.href };
    if (!type.includes("html")) return {};
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_BYTES) break;
      chunks.push(chunk);
    }
    const og: Record<string, any> = parseOpenGraph(Buffer.concat(chunks).toString("utf8"));
    if (og["og:image"]) {
      try {
        const imageUrl = new URL(og["og:image"], url);
        if (!opts.allowPrivateAddresses) await assertPublicHost(imageUrl.hostname);
        const img = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
        const imgType = img.headers.get("content-type") ?? "";
        if (img.ok && imgType.startsWith("image/")) Object.assign(og, await storeImage(hs, img, imgType));
      } catch { /* keep the preview without an image */ }
    }
    return og;
  }
  throw errors.notFound("Too many redirects");
}

/** Read width/height from PNG, GIF, JPEG or WebP headers. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    if (chunk === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
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
async function storeImage(hs: Homeserver, res: Response, type: string): Promise<Record<string, any>> {
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length > MAX_BYTES * 10) return {};
  const mediaId = randomString(24);
  await hs.media.put(mediaId, data, { contentType: type, filename: null, size: data.length });
  await hs.db.create("media", { media_id: mediaId, content_type: type, filename: null, size: data.length, uploader: "", created_ts: Date.now(), pending: false });
  const size = imageSize(data);
  return {
    "og:image": `mxc://${hs.serverName}/${mediaId}`, "og:image:type": type, "matrix:image:size": data.length,
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
  r.get("/_matrix/media/v3/preview_url", handler);
  r.get("/_matrix/media/r0/preview_url", handler);
  r.get("/_matrix/client/v1/media/preview_url", handler);
}
