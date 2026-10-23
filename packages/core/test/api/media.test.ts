import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryMedia } from "#index.ts";
import { testServer } from "../helpers.ts";

test("thumbnails and downloads are sandboxed and not sniffed (#79)", async () => {
  // A thumbnailer that passes SVG through unchanged, as some do.
  const t = await testServer({ thumbnailer: async (data, contentType) => ({ data, contentType }) });
  try {
    const token = await t.user("alice");
    const uploaded = await t.handler(
      new Request("http://localhost/_matrix/media/v3/upload", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "image/svg+xml" },
        body: '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      }),
    );
    const mediaId = ((await uploaded.json()) as any).content_uri.split("/").pop();
    for (const path of [
      `/_matrix/client/v1/media/thumbnail/localhost/${mediaId}?width=32&height=32`,
      `/_matrix/client/v1/media/download/localhost/${mediaId}`,
    ]) {
      const res = await t.call("GET", path, { token });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-security-policy") ?? "", /^sandbox;/, path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    }
  } finally {
    await t.close();
  }
});

test("two uploads to one pending media ID: one is stored, the other gets 409 (#102)", async () => {
  // Hold each put until both uploads arrived, as on a slow storage backend.
  let release!: () => void;
  const both = new Promise<void>((resolve) => (release = resolve));
  const media = memoryMedia();
  const t = await testServer({ mediaAdapter: { ...media, put: async (...args) => (await both, media.put(...args)) } });
  try {
    const token = await t.user("alice");
    const { content_uri } = (await t.call("POST", "/_matrix/media/v1/create", { token })).json;
    const id = content_uri.split("/").pop();
    const put = (body: string) =>
      t.handler(
        new Request(`http://localhost/_matrix/media/v3/upload/localhost/${id}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
          body,
        }),
      );
    const pending = [put("one"), put("two")];
    setTimeout(release, 50);
    const statuses = (await Promise.all(pending)).map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
  } finally {
    await t.close();
  }
});
