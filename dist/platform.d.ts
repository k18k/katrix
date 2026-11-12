/**
 * The only module that reads platform globals. The SDK compiles against plain ECMAScript (no DOM,
 * no Node.js typings), so every global it needs is declared here with the smallest shape that
 * Node.js, browsers and React Native (Hermes) all provide.
 *
 * Deliberately not used anywhere in the SDK, because Hermes lacks them or ships incomplete
 * versions: `TextDecoder` and, for symmetry, `TextEncoder` (see @katrix/shared utf8.ts; Hermes has
 * TextEncoder since React Native 0.74, and @noble/curves needs it at import), `atob`/`btoa` (@katrix/shared base64.ts),
 * `URL`/`URLSearchParams` (util/query.ts), `crypto.subtle`, `WebAssembly`, `structuredClone`,
 * `AbortSignal.timeout`/`AbortSignal.any`, `Buffer`, `process`.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: {
    once?: boolean;
  }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
/** fetch as the HTTP adapter uses it (see http/adapter.ts). */
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignalLike;
}) => Promise<FetchResponseLike>;
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
//# sourceMappingURL=platform.d.ts.map