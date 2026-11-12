import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMxc } from "../../src/media/media.ts";
import { encodeUtf8 } from "@katrix/shared";
import { findEvent, homeserver, until } from "./helpers.ts";

// A 1×1 PNG, so the server can make thumbnails of it.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) =>
  c.charCodeAt(0),
);

test("media: upload, download, async upload, thumbnails, config", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice", { e2ee: false });
    const mxc = await alice.media.upload(encodeUtf8("hello file"), { contentType: "text/plain", filename: "hello.txt" });
    assert.equal(parseMxc(mxc).serverName, "localhost");
    const file = await alice.media.download(mxc);
    assert.equal(new TextDecoder().decode(file.data), "hello file");
    assert.match(file.contentType ?? "", /^text\/plain/);
    assert.equal(file.filename, "hello.txt");
    const renamed = await alice.media.download(mxc, { filename: "other.txt" });
    assert.equal(renamed.filename, "other.txt");

    const reserved = await alice.media.create();
    await alice.media.uploadTo(reserved.contentUri, PNG, { contentType: "image/png" });
    assert.deepEqual((await alice.media.download(reserved.contentUri)).data, PNG);
    const thumb = await alice.media.thumbnail(reserved.contentUri, { width: 32, height: 32, method: "scale" });
    assert.ok(thumb.data.length > 0);
    assert.match(thumb.contentType ?? "", /^image\//);

    const max = await alice.media.maxUploadSize();
    assert.ok(max === undefined || max > 0);
    assert.throws(() => parseMxc("https://example.com/x"));
  } finally {
    await t.close();
  }
});

test("media: files in an encrypted room are encrypted before upload", async () => {
  const t = await homeserver();
  try {
    const alice = await t.login("alice");
    const bob = await t.login("bob");
    await Promise.all([alice.start(), bob.start()]);
    await Promise.all([alice.waitForPrepared(), bob.waitForPrepared()]);
    const roomId = await alice.createRoom({ encrypted: true, invite: [bob.userId] });
    await until("the invite", () => bob.getRoom(roomId)?.membership === "invite");
    await bob.joinRoom(roomId);
    await until("bob joined", () => alice.getRoom(roomId)?.state.membership(bob.userId) === "join");

    const secret = encodeUtf8("the plans");
    await alice.sendFile(roomId, secret, { filename: "plans.txt", contentType: "text/plain" });
    const event = await until("the file", () =>
      findEvent(bob, roomId, (e) => (e.content as { filename?: string }).filename === "plans.txt"),
    );
    const content = event.content as { url?: string; file?: import("@katrix/shared").EncryptedFile; info?: { size?: number } };
    assert.equal(content.url, undefined, "no plaintext URL");
    assert.ok(content.file);
    assert.equal(content.info?.size, secret.length);
    const stored = await bob.media.download(content.file.url);
    assert.notDeepEqual(stored.data, secret, "the server has only ciphertext");
    assert.deepEqual(await bob.media.downloadEncrypted(content.file), secret);
  } finally {
    await t.close();
  }
});
