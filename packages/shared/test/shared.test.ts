import { test } from "node:test";
import assert from "node:assert/strict";
import {
  endpointPath,
  isValidAlias,
  isValidRoomId,
  isValidServerName,
  isValidUserId,
  M,
  parseId,
  type EndpointParams,
} from "../src/index.ts";

// The vectors of canonical JSON, JSON signing, Base64 and UTF-8 are in
// packages/client/test/unit/encoding.test.ts, next to the client code that uses them most.

test("endpointPath fills in parameters as single, percent-encoded path segments", () => {
  const params: EndpointParams<"PUT /v3/rooms/:roomId/state/:eventType/:stateKey"> = {
    roomId: "!a b/c:x",
    eventType: "m.room.name",
    stateKey: "",
  };
  assert.equal(endpointPath("/v3/rooms/:roomId/state/:eventType/:stateKey", params), "/v3/rooms/!a%20b%2Fc%3Ax/state/m.room.name/");
  assert.equal(
    endpointPath("/v3/sendToDevice/:eventType/:txnId", { eventType: "m.room.encrypted", txnId: "t/1?" }),
    "/v3/sendToDevice/m.room.encrypted/t%2F1%3F",
  );
  assert.throws(() => endpointPath("/v3/rooms/:roomId/leave", {}), /Missing path parameter roomId/);
});

test("identifiers: the spec's grammar", () => {
  assert.deepEqual(parseId("@alice:example.org", "@"), { localpart: "alice", server: "example.org" });
  assert.equal(parseId("alice:example.org", "@"), null);
  assert.ok(isValidUserId("@alice:example.org:8448"));
  assert.ok(!isValidUserId("@alice"));
  assert.ok(!isValidUserId(`@${"a".repeat(250)}:example.org`));
  assert.ok(isValidRoomId("!abc:example.org"));
  assert.ok(isValidRoomId("!31hneApxJ_1o-63DmFrpeqnkFfWppnzWso1JvH3ogLM"), "room version 12 IDs have no server name");
  assert.ok(!isValidRoomId("!a b:x"));
  assert.ok(isValidAlias("#room:example.org"));
  assert.ok(isValidServerName("[1234:5678::abcd]:8448"));
  assert.ok(!isValidServerName("exa mple.org"));
});

test("the m.* identifiers are frozen", () => {
  assert.equal(M.ROOM.MEMBER, "m.room.member");
  assert.ok(Object.isFrozen(M) && Object.isFrozen(M.ROOM));
});
