import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
// src/adapters/media.ts
/** Thumbnailer backed by `sharp`: `thumbnailer: sharpThumbnailer(sharp)`. */
function sharpThumbnailer(sharp) {
	return async (data, contentType, req) => {
		if (!/^image\/(png|jpeg|gif|webp|avif|tiff)$/.test(contentType)) return null;
		const animated = req.animated && (contentType === "image/gif" || contentType === "image/webp");
		const format = animated ? "webp" : contentType === "image/jpeg" ? "jpeg" : "png";
		return {
			data: await sharp(data, { animated }).resize({
				width: req.width,
				height: req.height,
				fit: req.method === "crop" ? "cover" : "inside",
				withoutEnlargement: true
			}).toFormat(format).toBuffer(),
			contentType: `image/${format}`
		};
	};
}
function memoryMedia() {
	const store = /* @__PURE__ */ new Map();
	return {
		async put(id, data) {
			store.set(id, data);
		},
		async get(id) {
			return store.get(id) ?? null;
		},
		async delete(id) {
			store.delete(id);
		}
	};
}
/** Stores media as files inside `directory`. */
function filesystemMedia(directory) {
	const root = resolve(directory);
	const path = (id) => {
		const file = resolve(root, id.replace(/[^A-Za-z0-9_-]/g, "_"));
		if (dirname(file) !== root) throw new Error("Invalid media ID");
		return file;
	};
	let ready = null;
	return {
		async put(id, data) {
			ready ??= mkdir(directory, { recursive: true });
			await ready;
			await writeFile(path(id), data);
		},
		async get(id) {
			try {
				return await readFile(path(id));
			} catch {
				return null;
			}
		},
		async delete(id) {
			await rm(path(id), { force: true });
		}
	};
}
export { filesystemMedia, memoryMedia, sharpThumbnailer };

//# sourceMappingURL=media.js.map