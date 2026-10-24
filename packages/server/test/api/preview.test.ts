import { test } from "node:test";
import assert from "node:assert/strict";
import { localServer, testServer } from "../helpers.ts";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000308060000000000000000", "hex");

async function preview(options: Parameters<typeof testServer>[0]) {
  const site = await localServer((req, res) => {
    if (req.url === "/img.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(png);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Page</title><meta property="og:image" content="/img.png">`);
  });
  const t = await testServer(options);
  try {
    const token = await t.user("alice");
    return await t.call("GET", `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(`${site.url}/page`)}`, { token });
  } finally {
    await t.close();
    await site.close();
  }
}

// https://github.com/k18k/katrix/issues/22
test("previews do not reach private addresses by default", async () => {
  const res = await preview({ urlPreviews: true });
  assert.equal(res.status, 403);
});

test("previews of allowed addresses include the image", async () => {
  for (const options of [{ urlPreviews: true, allowPrivateAddresses: true }, { urlPreviews: { allowPrivateAddresses: true } }]) {
    const res = await preview(options);
    assert.equal(res.status, 200);
    assert.equal(res.json["og:title"], "Page");
    assert.match(res.json["og:image"], /^mxc:\/\/localhost\//);
    assert.equal(res.json["og:image:width"], 2);
  }
});

test("a URL previewed again (also concurrently) is fetched and stored once (#104)", async () => {
  let fetches = 0;
  const site = await localServer((req, res) => {
    fetches++;
    if (req.url === "/img.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(png);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Page</title><meta property="og:image" content="/img.png">`);
  });
  const t = await testServer({ urlPreviews: true, allowPrivateAddresses: true });
  try {
    const token = await t.user("alice");
    const get = () => t.call("GET", `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(`${site.url}/page`)}`, { token });
    const results = [...(await Promise.all([get(), get()])), await get()];
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200, 200],
    );
    assert.equal(new Set(results.map((r) => r.json["og:image"])).size, 1);
    assert.equal(fetches, 2, "the page and its image, once");
    assert.equal((await t.hs.db.findMany("media")).length, 1);
  } finally {
    await t.close();
    await site.close();
  }
});
