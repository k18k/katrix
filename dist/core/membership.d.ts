import { Homeserver } from "../homeserver.js";
/** Room membership: resolving a room to join, joins (local and over federation), invites, leaves, kicks, bans, knocks. */
export declare class MembershipService {
  private readonly hs;
  constructor(hs: Homeserver);
  resolveRoomIdOrAlias(idOrAlias: string): Promise<any>;
  /** Resolve a room ID or alias, including remote aliases; returns candidate servers for joining. */
  resolveRoom(idOrAlias: string): Promise<{
    roomId: any;
    servers: string[];
  }>;
  /** Servers that might help with a remote membership change for `userId` in `roomId`. */
  private remoteServersFor;
  join(userId: string, roomId: string, extra?: {
    reason?: string;
    content?: Record<string, unknown>;
    servers?: string[];
  }): Promise<string>;
  private joinLocal;
  /** Whether an allowed room exists that we can't check (or the user is joined to), so another server might authorise. */
  private mayQualifyRemotely;
  private findRestrictedAuthoriser;
  invite(roomId: string, sender: string, target: string, opts?: {
    reason?: string;
    isDirect?: boolean;
    thirdPartyInvite?: {
      display_name: string;
      signed: Record<string, unknown>;
    };
  }): Promise<void>;
  /** Make this server's guests leave a room that no longer allows guests (spec, guest access module; #87). */
  removeGuests(roomId: string): Promise<void>;
  setMembership(roomId: string, sender: string, target: string, membership: "leave" | "ban" | "knock", reason?: string, via?: string[]): Promise<void>;
  private remoteMembership;
  /** Update the member event in every joined room after a profile change. */
  propagateProfile(userId: string): Promise<void>;
}
//# sourceMappingURL=membership.d.ts.map