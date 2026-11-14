import { M } from "@katrix/shared";
import { test } from "node:test";
import assert from "node:assert/strict";
import { localServer, testServer } from "../helpers.ts";

// Invites by email address through an identity server (POST /rooms/{roomId}/invite with id_server).

const KEY = { public_key: "pk", key_validity_url: "https://id.example/isvalid" };

test("an invite by email asks the identity server, and stores the invite when nobody is bound", async () => {
  let stored: unknown = { token: "tok", public_keys: [KEY, { public_key: 1 }], display_name: "c...@example.org" };
  const bound: Record<string, string> = { "bob@example.org email": "@bob:localhost" };
  const idp = await localServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/_matrix/identity/v2/hash_details") return res.end(JSON.stringify({ algorithms: ["none"] }));
      if (req.url === "/_matrix/identity/v2/lookup") {
        const [address] = JSON.parse(body).addresses;
        return res.end(JSON.stringify({ mappings: bound[address] ? { [address]: bound[address] } : {} }));
      }
      if (req.url === "/_matrix/identity/v2/store-invite") return res.end(JSON.stringify(stored));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  const t = await testServer({ threepid: { identityServerProtocol: "http" }, allowPrivateAddresses: true });
  try {
    const alice = await t.user("alice");
    await t.user("bob");
    const room = (await t.call("POST", "/_matrix/client/v3/createRoom", { token: alice, body: {} })).json.room_id;
    const idServer = idp.url.replace("http://", "");
    const invite = (address: string) =>
      t.call("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`, {
        token: alice,
        body: { id_server: idServer, id_access_token: "at", medium: "email", address },
      });

    assert.equal((await invite("bob@example.org")).status, 200);
    const member = await t.call("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/${M.ROOM.MEMBER}/@bob:localhost`, {
      token: alice,
    });
    assert.equal(member.json.membership, "invite", "a bound address invites its user");

    const res = await invite("carol@example.org");
    assert.equal(res.status, 200, res.text);
    const pending = await t.call("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/${M.ROOM.THIRD_PARTY_INVITE}/tok`, {
      token: alice,
    });
    assert.deepEqual(pending.json, {
      display_name: "c...@example.org",
      key_validity_url: KEY.key_validity_url,
      public_key: KEY.public_key,
      public_keys: [KEY],
    });

    stored = { token: "tok2", public_keys: [{ public_key: 1 }], display_name: "d...@example.org" };
    assert.equal((await invite("dave@example.org")).status, 502, "an answer without a usable key is refused");
    const missing = await t.call("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`, {
      token: alice,
      body: { id_server: idServer, medium: "email", address: "erin@example.org" },
    });
    assert.equal(missing.json.errcode, "M_MISSING_PARAM");
  } finally {
    await t.close();
    await idp.close();
  }
});
