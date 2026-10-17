import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudflareTurn } from "#index.ts";
import { testServer } from "../helpers.ts";

test("Cloudflare TURN: /voip/turnServer hands out the service's credentials, without port 53", async () => {
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: String(init.body) });
    return new Response(
      JSON.stringify({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478"] },
          {
            urls: [
              "turn:turn.cloudflare.com:3478?transport=udp",
              "turn:turn.cloudflare.com:53?transport=udp",
              "turns:turn.cloudflare.com:443?transport=tcp",
            ],
            username: "user",
            credential: "secret",
          },
        ],
      }),
      { status: 201 },
    );
  }) as typeof fetch;
  const t = await testServer({ rtc: { turn: cloudflareTurn({ keyId: "key", apiToken: "token", ttlSeconds: 3600, fetch: fakeFetch }) } });
  try {
    const alice = await t.user("alice");
    const res = await t.call("GET", "/_matrix/client/v3/voip/turnServer", { token: alice });
    assert.deepEqual(res.json, {
      username: "user",
      password: "secret",
      uris: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
      ttl: 3600,
    });
    assert.equal(calls[0].url, "https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers");
    assert.equal(calls[0].auth, "Bearer token");
    assert.deepEqual(JSON.parse(calls[0].body), { ttl: 3600 });
    // Asking again within half the lifetime reuses the credentials.
    await t.call("GET", "/_matrix/client/v3/voip/turnServer", { token: alice });
    assert.equal(calls.length, 1);
  } finally {
    await t.close();
  }
});
