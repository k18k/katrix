import { createHash, createHmac } from "node:crypto";
import type { MediaAdapter } from "#adapters/media.ts";

export interface S3MediaOptions {
  bucket: string;
  /** e.g. "us-east-1"; "auto" for Cloudflare R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials (STS) also carry a session token. */
  sessionToken?: string;
  /**
   * Service endpoint, for S3-compatible stores (MinIO, R2, Garage, Ceph...).
   * Default: AWS, `https://s3.<region>.amazonaws.com`.
   */
  endpoint?: string;
  /**
   * Address the bucket as `<endpoint>/<bucket>/<key>` instead of `<bucket>.<endpoint>/<key>`.
   * Default: true with a custom endpoint, false on AWS.
   */
  forcePathStyle?: boolean;
  /** Key prefix for all objects, e.g. "matrix/media/". */
  prefix?: string;
  /** Maximum upload size in bytes. Default: 50 MiB. */
  maxUploadSize?: number;
  /** Per-request timeout in ms. Default: 30 s. */
  timeoutMs?: number;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
// RFC 3986 encoding as SigV4 requires (keeping "/" in paths).
const encodePath = (path: string) =>
  path
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

/**
 * Media stored in an S3 bucket (AWS S3 or any S3-compatible store). Requests are signed with
 * AWS Signature Version 4; no SDK is needed.
 */
export function s3Media(options: S3MediaOptions): MediaAdapter {
  const endpoint = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`);
  const pathStyle = options.forcePathStyle ?? options.endpoint !== undefined;
  const prefix = options.prefix ?? "";
  const timeoutMs = options.timeoutMs ?? 30_000;

  const objectUrl = (mediaId: string): URL => {
    const key = prefix + mediaId.replace(/[^A-Za-z0-9_-]/g, "_");
    const url = new URL(endpoint);
    // The path is sent exactly as it is signed (fully percent-encoded).
    const base = endpoint.pathname.replace(/\/$/, "");
    if (pathStyle) {
      url.pathname = `${base}/${encodePath(options.bucket)}/${encodePath(key)}`;
    } else {
      url.hostname = `${options.bucket}.${endpoint.hostname}`;
      url.pathname = `${base}/${encodePath(key)}`;
    }
    return url;
  };

  const send = async (method: string, url: URL, body?: Uint8Array, extra: Record<string, string> = {}): Promise<Response> => {
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? "");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(options.sessionToken ? { "x-amz-security-token": options.sessionToken } : {}),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const names = Object.keys(headers).sort();
    const canonicalRequest = [
      method,
      url.pathname,
      "",
      names.map((n) => `${n}:${headers[n].trim()}\n`).join(""),
      names.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${day}/${options.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, day), options.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const { host: _host, ...sent } = headers;
    return fetch(url, {
      method,
      headers: {
        ...sent,
        authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  const fail = async (what: string, res: Response): Promise<never> => {
    const text = await res.text().catch(() => "");
    const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
    throw new Error(`S3 ${what} failed: ${res.status}${code ? ` ${code}` : ""}`);
  };

  return {
    maxUploadSize: options.maxUploadSize,
    async put(mediaId, data, meta) {
      const res = await send("PUT", objectUrl(mediaId), data, meta.contentType ? { "content-type": meta.contentType } : {});
      if (!res.ok) await fail("upload", res);
      await res.arrayBuffer();
    },
    async get(mediaId) {
      const res = await send("GET", objectUrl(mediaId));
      if (res.status === 404) {
        await res.arrayBuffer();
        return null;
      }
      if (!res.ok) await fail("download", res);
      return new Uint8Array(await res.arrayBuffer());
    },
    async delete(mediaId) {
      const res = await send("DELETE", objectUrl(mediaId));
      if (!res.ok && res.status !== 404) await fail("delete", res);
      await res.arrayBuffer();
    },
  };
}
