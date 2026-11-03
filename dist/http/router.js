import { errors } from "#core/errors.ts";
export class Router {
    routes = [];
    add(method, path, handler) {
        this.routes.push({ method, segments: path.split("/").filter(Boolean), handler });
    }
    get = (path, h) => this.add("GET", path, h);
    post = (path, h) => this.add("POST", path, h);
    put = (path, h) => this.add("PUT", path, h);
    delete = (path, h) => this.add("DELETE", path, h);
    /** Register a client-server API route under both `r0` and `v3` (or the given versions). */
    client(method, path, handler, versions = ["r0", "v3"]) {
        for (const v of versions)
            this.add(method, `/_matrix/client/${v}${path}`, handler);
    }
    match(method, pathname) {
        const parts = pathname.split("/").filter(Boolean);
        let methodMismatch = false;
        for (const route of this.routes) {
            const params = matchSegments(route.segments, parts);
            if (!params)
                continue;
            if (route.method !== method) {
                methodMismatch = true;
                continue;
            }
            return { handler: route.handler, params };
        }
        return methodMismatch ? "method" : null;
    }
}
function matchSegments(segments, parts) {
    const params = {};
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.startsWith("*")) {
            // Greedy wildcard: consumes the rest of the path.
            params[seg.slice(1)] = parts.slice(i).map(decodeURIComponent).join("/");
            return params;
        }
        if (i >= parts.length)
            return null;
        if (seg.startsWith(":")) {
            try {
                params[seg.slice(1)] = decodeURIComponent(parts[i]);
            }
            catch {
                return null;
            }
        }
        else if (seg !== parts[i]) {
            return null;
        }
    }
    return segments.length === parts.length ? params : null;
}
export function notFound() {
    throw errors.unrecognized();
}
