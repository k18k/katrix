import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../../src/auth/login.ts";
import { MatrixClient } from "../../src/client.ts";
import type { IceCandidateLike, PeerConnectionLike, SessionDescriptionLike } from "../../src/voip/call.ts";
import type { MatrixCall } from "../../src/voip/call.ts";
import { homeserver, until } from "./helpers.ts";

/** A stand-in for RTCPeerConnection: "connects" once both descriptions are set and a remote candidate arrived. */
class FakePeerConnection implements PeerConnectionLike {
  static all: FakePeerConnection[] = [];
  signalingState = "stable";
  iceConnectionState = "new";
  local?: SessionDescriptionLike;
  remote?: SessionDescriptionLike;
  remoteCandidates: IceCandidateLike[] = [];
  closed = false;
  private listeners = new Map<string, Array<(e: any) => void>>();
  readonly name: string;
  constructor(name: string) {
    this.name = name;
    FakePeerConnection.all.push(this);
  }
  addEventListener(type: string, l: (e: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  private fire(type: string, e: unknown = {}) {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
  async createOffer() {
    return { type: "offer" as const, sdp: `v=0\r\no=${this.name}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: `v=0\r\no=${this.name} answer\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` };
  }
  async setLocalDescription(d: SessionDescriptionLike) {
    this.local = d;
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
    setTimeout(() => {
      this.fire("icecandidate", {
        candidate: { candidate: `candidate:1 1 udp 1 10.0.0.1 1234 typ host ${this.name}`, sdpMid: "0", sdpMLineIndex: 0 },
      });
      this.fire("icecandidate", { candidate: null });
    }, 5);
    this.check();
  }
  async setRemoteDescription(d: SessionDescriptionLike) {
    this.remote = d;
    this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
    this.check();
  }
  async addIceCandidate(c: IceCandidateLike) {
    this.remoteCandidates.push(c);
    this.check();
  }
  private check() {
    if (this.local && this.remote && this.remoteCandidates.some((c) => c.candidate) && this.iceConnectionState !== "connected") {
      this.iceConnectionState = "connected";
      this.fire("iceconnectionstatechange");
    }
  }
  close() {
    this.closed = true;
  }
}

type T = Awaited<ReturnType<typeof homeserver>>;

async function client(t: T, localpart: string, create = true): Promise<MatrixClient> {
  const opts = { calls: { peerConnectionFactory: () => new FakePeerConnection(localpart) } };
  let c: MatrixClient;
  if (create) c = await t.login(localpart, opts);
  else {
    const credentials = await new Auth({ baseUrl: t.baseUrl, http: t.http }).loginWithPassword(localpart, "password");
    c = new MatrixClient({ baseUrl: t.baseUrl, http: t.http, credentials, sync: { pollTimeoutMs: 1000 }, ...opts });
  }
  await c.start();
  await c.waitForPrepared();
  return c;
}

async function dm(alice: MatrixClient, bob: MatrixClient): Promise<string> {
  const roomId = await alice.createDirectRoom(bob.userId);
  await until("the invite", () => bob.getRoom(roomId)?.membership === "invite");
  await bob.joinRoom(roomId);
  await until("bob joined", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");
  await until("bob has the room", () => bob.getRoom(roomId)?.state.membership(alice.userId) === "join");
  return roomId;
}

const nextCall = (c: MatrixClient) => new Promise<MatrixCall>((resolve) => c.calls.once("incoming", resolve));

test("calls: invite, answer, candidates, connected, hang up (in an encrypted room)", async () => {
  const t = await homeserver();
  try {
    const alice = await client(t, "alice");
    const bob = await client(t, "bob");
    const roomId = await dm(alice, bob);
    const ringing = nextCall(bob);
    const outbound = await alice.calls.place(roomId, () => {}, { invitee: bob.userId });
    assert.equal(outbound.state, "inviting");
    const inbound = await ringing;
    assert.equal(inbound.opponent?.userId, alice.userId);
    assert.equal(inbound.state, "ringing");
    await inbound.answer(() => {});
    await until("both connected", () => outbound.state === "connected" && inbound.state === "connected");
    assert.equal(outbound.opponent?.userId, bob.userId);
    await outbound.hangup();
    await until("bob's call ended", () => inbound.state === "ended");
    assert.equal(inbound.hangupReason, "user_hangup");
  } finally {
    await t.close();
  }
});

test("calls: a rejected call; a call answered on another device stops ringing on the others", async () => {
  const t = await homeserver();
  const extra: MatrixClient[] = [];
  try {
    const alice = await client(t, "alice");
    const bob = await client(t, "bob");
    const bob2 = await client(t, "bob", false);
    extra.push(bob2);
    const roomId = await dm(alice, bob);
    await until("bob2 has the room", () => bob2.getRoom(roomId)?.membership === "join");

    let ringing = nextCall(bob);
    const first = await alice.calls.place(roomId, () => {});
    await (await ringing).reject();
    await until("rejected", () => first.state === "ended");
    assert.equal(first.hangupReason, "rejected");

    ringing = nextCall(bob);
    const ringing2 = nextCall(bob2);
    const second = await alice.calls.place(roomId, () => {});
    const [onBob, onBob2] = await Promise.all([ringing, ringing2]);
    await onBob.answer(() => {});
    await until("answered elsewhere", () => onBob2.state === "ended");
    assert.equal(onBob2.hangupReason, "answered_elsewhere");
    await until("connected", () => second.state === "connected");
    await second.hangup();
  } finally {
    for (const c of extra) await c.stop();
    await t.close();
  }
});

test("calls: glare, both call at once: the call with the lesser ID wins and connects", async () => {
  const t = await homeserver();
  try {
    const alice = await client(t, "alice");
    const bob = await client(t, "bob");
    const roomId = await dm(alice, bob);
    const [a, b] = await Promise.all([alice.calls.place(roomId, () => {}), bob.calls.place(roomId, () => {})]);
    const winner = a.callId < b.callId ? a : b;
    const loser = winner === a ? b : a;
    await until("the loser ends", () => loser.state === "ended");
    assert.equal(loser.hangupReason, "replaced");
    await until("the winner connects", () => winner.state === "connected");
  } finally {
    await t.close();
  }
});

test("calls: TURN servers from the homeserver", async () => {
  const t = await homeserver({ rtc: { turn: { uris: ["turn:turn.example.com:3478?transport=udp"], sharedSecret: "s3cret" } } });
  try {
    const alice = await client(t, "alice");
    const servers = await alice.calls.turnServers();
    assert.deepEqual(servers[0]?.urls, ["turn:turn.example.com:3478?transport=udp"]);
    assert.ok(servers[0]?.username && servers[0]?.credential);
  } finally {
    await t.close();
  }
});
