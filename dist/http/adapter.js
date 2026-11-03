import { platformFetch } from "../platform.js";
/** An adapter on a fetch function (the platform's by default). */
export function fetchHttpAdapter(fetchFn) {
    const f = fetchFn ?? platformFetch();
    if (!f)
        throw new Error("fetch is not available on this platform; pass an HttpAdapter");
    return {
        async request(req) {
            const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
            return {
                status: res.status,
                header: (name) => res.headers.get(name) ?? undefined,
                text: () => res.text(),
                bytes: async () => new Uint8Array(await res.arrayBuffer()),
            };
        },
    };
}
