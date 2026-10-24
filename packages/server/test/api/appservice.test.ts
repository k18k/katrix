import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "../helpers.ts";

const AS = {
  id: "bridge",
  url: null,
  as_token: "as_secret",
  hs_token: "hs_secret",
  sender_localpart: "bridgebot",
  namespaces: { users: [{ exclusive: true, regex: "@bridge_.*:localhost" }] },
};

test("application services create and delete their users' devices without logging in (#85, MSC4190)", async () => {
  const t = await testServer({ appservices: [AS] });
  try {
    const registered = await t.call("POST", "/_matrix/client/v3/register", {
      token: AS.as_token,
      body: { type: "m.login.application_service", username: "bridge_alice", inhibit_login: true },
    });
    assert.equal(registered.status, 200, registered.text);
    const as = (path: string) => `${path}${path.includes("?") ? "&" : "?"}user_id=${encodeURIComponent("@bridge_alice:localhost")}`;

    const created = await t.call("PUT", as("/_matrix/client/v3/devices/BRIDGEDEV"), {
      token: AS.as_token,
      body: { display_name: "Bridge" },
    });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual(created.json, {});
    const listed = await t.call("GET", as("/_matrix/client/v3/devices"), { token: AS.as_token });
    assert.deepEqual(
      listed.json.devices.map((d: any) => [d.device_id, d.display_name]),
      [["BRIDGEDEV", "Bridge"]],
    );
    // Updating an existing device is a plain 200.
    assert.equal(
      (await t.call("PUT", as("/_matrix/client/v3/devices/BRIDGEDEV"), { token: AS.as_token, body: { display_name: "B" } })).status,
      200,
    );
    // Deleting needs no User-Interactive Authentication.
    assert.equal((await t.call("DELETE", as("/_matrix/client/v3/devices/BRIDGEDEV"), { token: AS.as_token, body: {} })).status, 200);
    assert.deepEqual((await t.call("GET", as("/_matrix/client/v3/devices"), { token: AS.as_token })).json.devices, []);

    // Ordinary users can neither create devices this way nor delete them without UIA.
    const alice = await t.user("alice");
    assert.equal((await t.call("PUT", "/_matrix/client/v3/devices/NEWDEV", { token: alice, body: {} })).status, 404);
    const own = (await t.call("GET", "/_matrix/client/v3/devices", { token: alice })).json.devices[0].device_id;
    assert.equal((await t.call("DELETE", `/_matrix/client/v3/devices/${own}`, { token: alice, body: {} })).status, 401);
  } finally {
    await t.close();
  }
});
