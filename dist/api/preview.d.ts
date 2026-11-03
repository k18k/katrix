import type { Router } from "#http/router.ts";
export declare function parseOpenGraph(html: string): Record<string, string>;
/** Read width/height from PNG, GIF, JPEG or WebP headers. */
export declare function imageSize(data: Uint8Array): {
    width: number;
    height: number;
} | null;
export declare function registerPreviewRoutes(r: Router): void;
