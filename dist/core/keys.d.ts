import { Row } from "../storage/types.js";
import { Homeserver } from "../homeserver.js";
/** End-to-end encryption key storage (device keys, one-time keys, cross-signing). */
export declare class KeyService {
  private hs;
  constructor(hs: Homeserver);
  /** A local user's devices or device keys changed: update local clients and remote servers. */
  deviceChanged(userId: string, deletedDeviceId?: string): Promise<void>;
  markDeviceListChanged(userId: string, notify?: boolean): Promise<void>;
  /**
   * A partial-state room got its full state (MSC3902): device list updates received meanwhile for
   * users we could not place count as changes now, if those users turned out to be members.
   */
  onPartialStateComplete(roomId: string, pendingUsers: string[]): Promise<void>;
  upload(userId: string, deviceId: string, body: Record<string, any>): Promise<Record<string, number>>;
  oneTimeKeyCounts(userId: string, deviceId: string): Promise<Record<string, number>>;
  unusedFallbackKeyTypes(userId: string, deviceId: string): Promise<string[]>;
  query(requester: string, deviceKeys: Record<string, string[]>, timeoutMs?: number): Promise<Record<string, any>>;
  /** Whether a remote user shares a room with a local user (by known membership). */
  isTracked(userId: string): Promise<boolean>;
  dropRemoteCache(userId: string): Promise<void>;
  /** A tracked user's device list changed: refetch it on the next query. */
  markRemoteStale(userId: string): Promise<void>;
  private storeRemoteCache;
  private fromRemoteCache;
  private withSignatures;
  claim(request: Record<string, Record<string, string>>): Promise<Record<string, any>>;
  uploadCrossSigning(userId: string, body: Record<string, any>): Promise<void>;
  uploadSignatures(signer: string, body: Record<string, any>): Promise<Record<string, any>>;
  /** Users (sharing a room with `userId`) whose device lists changed after `since`. */
  /**
   * Device-list changes for /sync and /keys/changes. /sync passes what it has already read (the
   * membership changes, the device-list rows, the user's joined rooms) to save the queries.
   */
  changesSince(userId: string, since: number, upTo: number, known?: {
    memberChanges?: Row[];
    deviceRows?: Row[];
    joinedRooms?: string[];
  }): Promise<{
    changed: string[];
    left: string[];
  }>;
}
//# sourceMappingURL=keys.d.ts.map