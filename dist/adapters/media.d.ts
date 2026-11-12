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
export type Thumbnailer = (data: Uint8Array, contentType: string, request: ThumbnailRequest) => Promise<{
  data: Uint8Array;
  contentType: string;
} | null>;
/** Minimal structural type of the `sharp` image library. */
type SharpLike = (input: Uint8Array, options?: {
  animated?: boolean;
}) => {
  resize(opts: {
    width: number;
    height: number;
    fit: "cover" | "inside";
    withoutEnlargement?: boolean;
  }): {
    toFormat(format: "webp" | "png" | "jpeg"): {
      toBuffer(): Promise<Uint8Array>;
    };
  };
};
/** Thumbnailer backed by `sharp`: `thumbnailer: sharpThumbnailer(sharp)`. */
export declare function sharpThumbnailer(sharp: SharpLike): Thumbnailer;
export declare function memoryMedia(): MediaAdapter;
/** Stores media as files inside `directory`. */
export declare function filesystemMedia(directory: string): MediaAdapter;
export {};
//# sourceMappingURL=media.d.ts.map