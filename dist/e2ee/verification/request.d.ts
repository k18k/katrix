import { Logger } from "../../util/logger.js";
import { CryptoPrimitives } from "../../crypto/primitives.js";
import { DeviceTracker } from "../devices.js";
import { CrossSigning } from "../cross-signing.js";
import { TypedEmitter } from "../../util/emitter.js";
export type VerificationPhase = "requested" | "ready" | "started" | "done" | "cancelled";
/** How the messages of one verification travel: to-device, or as events in a room. */
export interface VerificationChannel {
  readonly kind: "to-device" | "room";
  /** The transaction ID (to-device), or the request event's ID (in a room). */
  readonly transactionId: string;
  /** Send a message; resolves with the content as sent (the start content goes into the SAS commitment). */
  send(type: string, content: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** After the other side answered from one device: only that device gets the rest. */
  narrowTo?(deviceId: string): void;
}
export interface SasCode {
  emoji: Array<{
    emoji: string;
    description: string;
  }>;
  decimal: [number, number, number];
}
export interface VerificationEvents {
  /** The phase changed, or something the app shows did (an SAS, a scanned code, a cancellation). */
  change: [];
  /** The short authentication string to compare: call confirmSas() or mismatchSas(). */
  sas: [sas: SasCode];
  /** The other device says it scanned our QR code: ask the user whether it did, then confirmQrScanned(). */
  qrScanned: [];
}
/** What a verification needs from the client. */
export interface VerificationContext {
  primitives: CryptoPrimitives;
  crossSigning: CrossSigning;
  devices: DeviceTracker;
  logger: Logger;
  userId: string;
  deviceId: string;
  /** This device's Ed25519 key. */
  deviceEd25519(): string;
  /** After a verification succeeded (to fetch secrets from a newly verified own device). */
  onVerified?: (request: VerificationRequest) => void;
}
/** The methods this SDK supports; showing and scanning QR codes needs the app's camera and screen. */
export declare const ALL_METHODS: string[];
/**
 * One key verification (https://spec.matrix.org/v1.19/client-server-api/#key-verification-framework):
 * request → ready → start (SAS or QR) → done, or cancelled at any point. The keys verified are
 * fixed when the method starts, as the spec requires, and checked again at the end.
 */
export declare class VerificationRequest extends TypedEmitter<VerificationEvents> {
  phase: VerificationPhase;
  readonly initiatedByMe: boolean;
  readonly otherUserId: string;
  /** The other side's device: known once it answered (or for a request it sent). */
  otherDeviceId?: string;
  theirMethods: string[];
  readonly ourMethods: string[];
  /** "m.sas.v1" or "m.reciprocate.v1" once started. */
  method?: string;
  cancelCode?: string;
  cancelReason?: string;
  /** The verification finished on another of our devices, or the other side answered elsewhere. */
  handledElsewhere: boolean;
  readonly createdAt: number;
  readonly channel: VerificationChannel;
  private readonly ctx;
  private sas?;
  /** Keys fixed at the start: the other device's Ed25519 key and the other user's master key. */
  private pinned?;
  private qr?;
  private scanned?;
  private theirDone;
  private ourDone;
  constructor(ctx: VerificationContext, channel: VerificationChannel, opts: {
    initiatedByMe: boolean;
    otherUserId: string;
    otherDeviceId?: string;
    ourMethods?: string[];
  });
  get transactionId(): string;
  /** The SAS to compare, once the keys are exchanged. */
  get sasCode(): SasCode | undefined;
  private setPhase;
  private get common();
  /** Accept a request from the other side (m.key.verification.ready). */
  accept(): Promise<void>;
  /** Decline or abort (m.key.verification.cancel). */
  cancel(code?: string, reason?: string): Promise<void>;
  /** A message of this verification from the other side (`fromDevice` from its content). */
  handle(type: string, content: Record<string, any>, sender: string): Promise<void>;
  private onReady;
  private unexpected;
  /** Start SAS verification (after ready). */
  startSas(): Promise<void>;
  /** Whether our start wins over theirs when both sent one: the lexicographically smaller user (then device) wins. */
  private weWinStartRace;
  private onStart;
  private onAccept;
  private onKey;
  /** The user says the SAS matches: send our MACs (and finish, if theirs are here and check out). */
  confirmSas(): Promise<void>;
  /** The user says the SAS does not match. */
  mismatchSas(): Promise<void>;
  private onMac;
  private checkTheirMac;
  /**
   * The QR code to show the other side (its bytes, to draw as a byte-mode QR code), when it can
   * scan and we can show one; undefined otherwise.
   */
  qrCode(): Promise<Uint8Array | undefined>;
  /**
   * We scanned the other side's QR code: check its keys against what we know, verify the other
   * side, and tell it (m.reciprocate.v1). Throws (and cancels) if the code does not match.
   */
  scanQrCode(bytes: Uint8Array): Promise<void>;
  private onReciprocate;
  /** The user confirms the other device scanned our QR code (it showed success): verify it, finish. */
  confirmQrScanned(): Promise<void>;
  private onDone;
  private sendDone;
  /** Fix the keys being verified (spec: they must not change during the verification). */
  private pinKeys;
  /** Record what was verified: the other device, the other user's (or our own) master key. */
  private trust;
}
//# sourceMappingURL=request.d.ts.map