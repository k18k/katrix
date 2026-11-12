export interface TurnOptions {
  uris: string[];
  /** coturn `static-auth-secret`: time-limited credentials are derived from it. */
  sharedSecret?: string;
  /** Static credentials, when not using a shared secret. */
  username?: string;
  password?: string;
  /** Credential lifetime in seconds. Default: 86400. */
  ttlSeconds?: number;
  /** Whether guests may obtain credentials. Default: false. */
  allowGuests?: boolean;
}
export interface RtcOptions {
  /** VoIP TURN servers. */
  turn?: TurnOptions;
  /**
   * MatrixRTC transports (MSC4143), e.g. `[{ type: "livekit", livekit_service_url: "https://lk-jwt.example.com" }]`.
   * Advertised at /rtc/transports and in /.well-known/matrix/client.
   */
  transports?: Record<string, unknown>[];
}
//# sourceMappingURL=rtc.d.ts.map