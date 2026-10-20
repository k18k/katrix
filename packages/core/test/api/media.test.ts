import { test } from "node:test";
import assert from "node:assert/strict";
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
