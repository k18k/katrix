import { EncryptedFile } from "../shared/events.js";
import { MediaBody, UrlPreviewResponse } from "../shared/api/media.js";
import { MatrixHttpApi } from "../http/api.js";
import { CryptoPrimitives } from "../crypto/primitives.js";
/** The server name and media ID of an mxc:// URI (https://spec.matrix.org/v1.19/client-server-api/#matrix-content-mxc-uris). */
export declare function parseMxc(uri: string): {
  serverName: string;
  mediaId: string;
};
/**
 * The content repository (https://spec.matrix.org/v1.19/client-server-api/#content-repository):
 * uploads, authenticated downloads and thumbnails (v1.11; the unauthenticated /_matrix/media/v3
 * downloads are deprecated and not used), URL previews, and encrypted attachments.
 */
export declare class MediaApi {
  private readonly api;
  private readonly primitives;
  constructor(api: MatrixHttpApi, primitives: CryptoPrimitives);
  /** Upload a file; resolves with its mxc:// URI. */
  upload(data: Uint8Array, opts?: {
    contentType?: string;
    filename?: string;
  }): Promise<string>;
  /**
   * Reserve an mxc:// URI before the file exists (asynchronous upload, v1.7): the URI can be sent
   * in an event at once, and uploadTo fills it in. Unused URIs expire at `unusedExpiresAt`.
   */
  create(): Promise<{
    contentUri: string;
    unusedExpiresAt?: number;
  }>;
  uploadTo(mxcUri: string, data: Uint8Array, opts?: {
    contentType?: string;
    filename?: string;
  }): Promise<void>;
  /** Download a file. `timeoutMs` waits for one still being uploaded asynchronously. */
  download(mxcUri: string, opts?: {
    filename?: string;
    timeoutMs?: number;
  }): Promise<MediaBody>;
  /**
   * A thumbnail of at least `width` × `height` (the server picks the nearest size it has).
   * `scale` keeps the aspect ratio, `crop` fills the box. `animated` asks for an animated
   * thumbnail of an animated image.
   */
  thumbnail(mxcUri: string, opts: {
    width: number;
    height: number;
    method?: "crop" | "scale";
    animated?: boolean;
    timeoutMs?: number;
  }): Promise<MediaBody>;
  /**
   * OpenGraph data for a URL, fetched by the server. In an encrypted room this tells the server
   * which links are being sent: apps should not preview them there by default.
   */
  previewUrl(url: string, ts?: number): Promise<UrlPreviewResponse>;
  /** The largest upload the server accepts, in bytes, if it says. */
  maxUploadSize(): Promise<number | undefined>;
  /**
   * Encrypt and upload a file for an encrypted room. Put the returned EncryptedFile in the
   * event's `file` (instead of `url`); the server only ever sees ciphertext, uploaded as
   * application/octet-stream.
   */
  uploadEncrypted(data: Uint8Array): Promise<EncryptedFile>;
  /** Download and decrypt an encrypted attachment; throws an AttachmentError if it was tampered with. */
  downloadEncrypted(file: EncryptedFile, opts?: {
    timeoutMs?: number;
  }): Promise<Uint8Array>;
}
//# sourceMappingURL=media.d.ts.map