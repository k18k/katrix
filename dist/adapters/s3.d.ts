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
/**
 * Media stored in an S3 bucket (AWS S3 or any S3-compatible store). Requests are signed with
 * AWS Signature Version 4; no SDK is needed.
 */
export declare function s3Media(options: S3MediaOptions): MediaAdapter;
