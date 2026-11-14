import { MatrixError, errors } from "../core/errors.js";
import { randomString } from "../core/crypto.js";
import { procedure } from "../http/procedure.js";
import { publicGet } from "../core/outbound.js";
// src/api/preview.ts
const MAX_BYTES = 1048576;
function decodeEntities(s) {
	return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ({
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": "\"",
		"&#39;": "'",
		"&#x27;": "'"
	})[m] ?? m);
}
function parseOpenGraph(html) {
	const og = {};
	for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
		const attr = (name) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
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
async function preview(hs, rawUrl) {
	const opts = hs.config.urlPreviews;
	if (!opts) throw errors.notFound("URL previews are disabled");
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw errors.invalidParam("Invalid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw errors.invalidParam("Only http(s) URLs can be previewed");
	const get = opts.allowPrivateAddresses ? hs.fetch : hs.publicFetch;
	const headers = { "user-agent": "katrix" };
	const res = await publicGet(get, url, {
		maxBytes: MAX_BYTES * 10,
		truncate: true,
		timeoutMs: 1e4,
		headers
	}).catch((err) => {
		throw err instanceof MatrixError ? err : errors.notFound("Could not fetch URL");
	});
	if (res.status !== 200) throw errors.notFound("Could not fetch URL");
	const type = res.headers.get("content-type") ?? "";
	if (type.startsWith("image/")) {
		if (res.body.length >= MAX_BYTES * 10) return {};
		return {
			...await storeImage(hs, res.body, type),
			"og:url": res.url.href
		};
	}
	if (!type.includes("html")) return {};
	const og = parseOpenGraph(res.body.subarray(0, MAX_BYTES).toString("utf8"));
	const image = og["og:image"];
	if (typeof image === "string" && image) try {
		const img = await publicGet(get, new URL(image, res.url), {
			maxBytes: MAX_BYTES * 10,
			timeoutMs: 1e4,
			headers
		});
		const imgType = img.headers.get("content-type") ?? "";
		if (img.status === 200 && imgType.startsWith("image/")) Object.assign(og, await storeImage(hs, img.body, imgType));
	} catch {}
	return og;
}
/** Read width/height from PNG, GIF, JPEG or WebP headers. */
function imageSize(data) {
	const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (b.length >= 24 && b.readUInt32BE(0) === 2303741511) return {
		width: b.readUInt32BE(16),
		height: b.readUInt32BE(20)
	};
	if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") return {
		width: b.readUInt16LE(6),
		height: b.readUInt16LE(8)
	};
	if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
		const chunk = b.toString("ascii", 12, 16);
		if (chunk === "VP8 ") return {
			width: b.readUInt16LE(26) & 16383,
			height: b.readUInt16LE(28) & 16383
		};
		if (chunk === "VP8L") {
			const bits = b.readUInt32LE(21);
			return {
				width: (bits & 16383) + 1,
				height: (bits >> 14 & 16383) + 1
			};
		}
		if (chunk === "VP8X") return {
			width: b.readUIntLE(24, 3) + 1,
			height: b.readUIntLE(27, 3) + 1
		};
	}
	if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 255) {
				i++;
				continue;
			}
			const marker = b[i + 1];
			const len = b.readUInt16BE(i + 2);
			if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) return {
				height: b.readUInt16BE(i + 5),
				width: b.readUInt16BE(i + 7)
			};
			i += 2 + len;
		}
	}
	return null;
}
/** Store a fetched image in the media repository and describe it for a preview. */
async function storeImage(hs, body, type) {
	const data = new Uint8Array(body);
	const mediaId = randomString(24);
	await hs.media.put(mediaId, data, {
		contentType: type,
		filename: null,
		size: data.length
	});
	await hs.db.create("media", {
		media_id: mediaId,
		content_type: type,
		filename: null,
		size: data.length,
		uploader: "",
		created_ts: Date.now(),
		pending: false
	});
	const size = imageSize(data);
	return {
		"og:image": `mxc://${hs.serverName}/${mediaId}`,
		"og:image:type": type,
		"matrix:image:size": data.length,
		...size ? {
			"og:image:width": size.width,
			"og:image:height": size.height
		} : {}
	};
}
/** How long a preview is reused (`preview:<url>` in the cluster key-value store). */
const PREVIEW_TTL_MS = 36e5;
/** Previews being built on this instance, by URL: concurrent requests for one URL share the work. */
const building = /* @__PURE__ */ new WeakMap();
/**
* https://github.com/k18k/katrix/issues/104 — uncontrolled resource consumption (CWE-400): every
* request fetched the page and its image again and stored a new copy of the image, so one account could make the
* server download and keep any amount of data. Previews are now reused for an hour (across instances), built once
* for concurrent requests, and rate limited per user (`preview`).
*/
async function cachedPreview(hs, url) {
	const key = `preview:${url}`;
	const cached = await hs.cluster.get(key);
	if (cached) return cached;
	let inflight = building.get(hs);
	if (!inflight) building.set(hs, inflight = /* @__PURE__ */ new Map());
	let pending = inflight.get(url);
	if (!pending) {
		pending = preview(hs, url).then(async (result) => {
			await hs.cluster.set(key, result, PREVIEW_TTL_MS);
			return result;
		}).finally(() => inflight.delete(url));
		inflight.set(url, pending);
	}
	return pending;
}
function registerPreviewRoutes(r) {
	const handler = async (ctx) => {
		await ctx.auth();
		await ctx.rateLimit("preview");
		const url = ctx.query.get("url");
		if (!url) throw errors.missingParam("Missing url");
		return cachedPreview(ctx.hs, url);
	};
	r.get("/_matrix/media/v3/preview_url", procedure({ handler }));
	r.get("/_matrix/media/r0/preview_url", procedure({ handler }));
	r.get("/_matrix/client/v1/media/preview_url", procedure({ handler }));
}
export { imageSize, parseOpenGraph, registerPreviewRoutes };

//# sourceMappingURL=preview.js.map