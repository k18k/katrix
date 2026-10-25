/**
 * The content repository (https://spec.matrix.org/v1.19/client-server-api/#content-repository).
 * Downloads and uploads carry bytes, not JSON: the map types them as a `MediaBody`.
 */

/** A file's bytes and its media type. */
export interface MediaBody {
  data: Uint8Array;
  contentType?: string;
  /** From Content-Disposition on downloads. */
  filename?: string;
}

export interface UploadResponse {
  content_uri: string;
}

export interface CreateMediaResponse {
  content_uri: string;
  unused_expires_at?: number;
}

export interface MediaConfigResponse {
  "m.upload.size"?: number;
}

/** GET /v1/media/preview_url: OpenGraph data. */
export interface UrlPreviewResponse {
  "matrix:image:size"?: number;
  "og:image"?: string;
  "og:title"?: string;
  "og:description"?: string;
  [key: string]: unknown;
}
