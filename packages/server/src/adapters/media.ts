import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface MediaMetadata {
  contentType: string | null;
  filename: string | null;
  size: number;
}

/** Stores the bytes of uploaded media. Metadata is kept in the database. */
export interface MediaAdapter {
  put(mediaId: string, data: Uint8Array, meta: MediaMetadata): Promise<void>;
  get(mediaId: string): Promise<Uint8Array | null>;
  delete?(mediaId: string): Promise<void>;
  /** Maximum upload size in bytes. Default: 50 MiB. */
  maxUploadSize?: number;
}

export interface ThumbnailRequest {
  width: number;
  height: number;
  method: "crop" | "scale";
  animated: boolean;
}

/**
 * Produces a thumbnail. Return null to fall back to serving the original file
 * (e.g. for unsupported formats).
 */
export type Thumbnailer = (
  data: Uint8Array,
  contentType: string,
  request: ThumbnailRequest,
) => Promise<{ data: Uint8Array; contentType: string } | null>;

/** Minimal structural type of the `sharp` image library. */
type SharpLike = (
  input: Uint8Array,
  options?: { animated?: boolean },
) => {
  resize(opts: { width: number; height: number; fit: "cover" | "inside"; withoutEnlargement?: boolean }): {
    toFormat(format: "webp" | "png" | "jpeg"): { toBuffer(): Promise<Uint8Array> };
  };
};

/** Thumbnailer backed by `sharp`: `thumbnailer: sharpThumbnailer(sharp)`. */
export function sharpThumbnailer(sharp: SharpLike): Thumbnailer {
  return async (data, contentType, req) => {
    if (!/^image\/(png|jpeg|gif|webp|avif|tiff)$/.test(contentType)) return null;
    const animated = req.animated && (contentType === "image/gif" || contentType === "image/webp");
    const format = animated ? "webp" : contentType === "image/jpeg" ? "jpeg" : "png";
    const out = await sharp(data, { animated })
      .resize({ width: req.width, height: req.height, fit: req.method === "crop" ? "cover" : "inside", withoutEnlargement: true })
      .toFormat(format)
      .toBuffer();
    return { data: out, contentType: `image/${format}` };
  };
}

export function memoryMedia(): MediaAdapter {
  const store = new Map<string, Uint8Array>();
  return {
    async put(id, data) {
      store.set(id, data);
    },
    async get(id) {
      return store.get(id) ?? null;
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

/** Stores media as files inside `directory`. */
export function filesystemMedia(directory: string): MediaAdapter {
  const root = resolve(directory);
  // Media IDs become file names: anything but [A-Za-z0-9_-] is replaced, so an ID cannot name a
  // path outside the directory. The resolved path is checked as well, as a second line of defence.
  const path = (id: string) => {
    const file = resolve(root, id.replace(/[^A-Za-z0-9_-]/g, "_"));
    if (dirname(file) !== root) throw new Error("Invalid media ID");
    return file;
  };
  let ready: Promise<unknown> | null = null;
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
    },
  };
}
