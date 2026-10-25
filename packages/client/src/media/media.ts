import type { CryptoPrimitives } from "../crypto/primitives.ts";
import type { MatrixHttpApi } from "../http/api.ts";
import { decryptAttachment, encryptAttachment } from "./attachments.ts";
import type { EncryptedFile, MediaBody, UrlPreviewResponse } from "@katrix/shared";

/** The server name and media ID of an mxc:// URI (https://spec.matrix.org/v1.19/client-server-api/#matrix-content-mxc-uris). */
export function parseMxc(uri: string): { serverName: string; mediaId: string } {
  const m = /^mxc:\/\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(uri);
  if (!m) throw new Error("Not a valid mxc:// URI");
  return { serverName: m[1], mediaId: m[2] };
}

/**
 * The content repository (https://spec.matrix.org/v1.19/client-server-api/#content-repository):
 * uploads, authenticated downloads and thumbnails (v1.11; the unauthenticated /_matrix/media/v3
 * downloads are deprecated and not used), URL previews, and encrypted attachments.
 */
export class MediaApi {
  private readonly api: MatrixHttpApi;
  private readonly primitives: CryptoPrimitives;

  constructor(api: MatrixHttpApi, primitives: CryptoPrimitives) {
    this.api = api;
    this.primitives = primitives;
  }

  /** Upload a file; resolves with its mxc:// URI. */
  async upload(data: Uint8Array, opts: { contentType?: string; filename?: string } = {}): Promise<string> {
    const res = await this.api.endpoint(
      "POST /_matrix/media/v3/upload",
      {},
      { query: { filename: opts.filename }, body: { data, contentType: opts.contentType } },
    );
    return res.content_uri;
  }

  /**
   * Reserve an mxc:// URI before the file exists (asynchronous upload, v1.7): the URI can be sent
   * in an event at once, and uploadTo fills it in. Unused URIs expire at `unusedExpiresAt`.
   */
  async create(): Promise<{ contentUri: string; unusedExpiresAt?: number }> {
    const res = await this.api.endpoint("POST /_matrix/media/v1/create", {}, {});
    return { contentUri: res.content_uri, unusedExpiresAt: res.unused_expires_at };
  }

  async uploadTo(mxcUri: string, data: Uint8Array, opts: { contentType?: string; filename?: string } = {}): Promise<void> {
    const { serverName, mediaId } = parseMxc(mxcUri);
    await this.api.endpoint(
      "PUT /_matrix/media/v3/upload/:serverName/:mediaId",
      { serverName, mediaId },
      { query: { filename: opts.filename }, body: { data, contentType: opts.contentType } },
    );
  }

  /** Download a file. `timeoutMs` waits for one still being uploaded asynchronously. */
  download(mxcUri: string, opts: { filename?: string; timeoutMs?: number } = {}): Promise<MediaBody> {
    const { serverName, mediaId } = parseMxc(mxcUri);
    const query = { timeout_ms: opts.timeoutMs };
    return opts.filename === undefined
      ? this.api.endpoint("GET /v1/media/download/:serverName/:mediaId", { serverName, mediaId }, { query })
      : this.api.endpoint(
          "GET /v1/media/download/:serverName/:mediaId/:fileName",
          { serverName, mediaId, fileName: opts.filename },
          { query },
        );
  }

  /**
   * A thumbnail of at least `width` × `height` (the server picks the nearest size it has).
   * `scale` keeps the aspect ratio, `crop` fills the box. `animated` asks for an animated
   * thumbnail of an animated image.
   */
  thumbnail(
    mxcUri: string,
    opts: { width: number; height: number; method?: "crop" | "scale"; animated?: boolean; timeoutMs?: number },
  ): Promise<MediaBody> {
    const { serverName, mediaId } = parseMxc(mxcUri);
    return this.api.endpoint(
      "GET /v1/media/thumbnail/:serverName/:mediaId",
      { serverName, mediaId },
      { query: { width: opts.width, height: opts.height, method: opts.method, animated: opts.animated, timeout_ms: opts.timeoutMs } },
    );
  }

  /**
   * OpenGraph data for a URL, fetched by the server. In an encrypted room this tells the server
   * which links are being sent: apps should not preview them there by default.
   */
  previewUrl(url: string, ts?: number): Promise<UrlPreviewResponse> {
    return this.api.endpoint("GET /v1/media/preview_url", {}, { query: { url, ts } });
  }

  /** The largest upload the server accepts, in bytes, if it says. */
  async maxUploadSize(): Promise<number | undefined> {
    const res = await this.api.endpoint("GET /v1/media/config", {}, {});
    return typeof res["m.upload.size"] === "number" ? res["m.upload.size"] : undefined;
  }

  /**
   * Encrypt and upload a file for an encrypted room. Put the returned EncryptedFile in the
   * event's `file` (instead of `url`); the server only ever sees ciphertext, uploaded as
   * application/octet-stream.
   */
  async uploadEncrypted(data: Uint8Array): Promise<EncryptedFile> {
    const { ciphertext, file } = encryptAttachment(this.primitives, data);
    const url = await this.upload(ciphertext, { contentType: "application/octet-stream" });
    return { ...file, url };
  }

  /** Download and decrypt an encrypted attachment; throws an AttachmentError if it was tampered with. */
  async downloadEncrypted(file: EncryptedFile, opts: { timeoutMs?: number } = {}): Promise<Uint8Array> {
    const res = await this.download(file.url, opts);
    return decryptAttachment(this.primitives, res.data, file);
  }
}
