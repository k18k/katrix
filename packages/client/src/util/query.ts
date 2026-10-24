/**
 * Query strings and form bodies without URL/URLSearchParams: React Native's versions are
 * incomplete (several methods throw "not implemented").
 */

export type QueryValue = string | number | boolean | undefined | null | ReadonlyArray<string>;

export function encodeQuery(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const values = Array.isArray(v) ? v : [String(v)];
    for (const one of values) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(one)}`);
  }
  return parts.join("&");
}

/** Parse the query of a URL (for example an OAuth redirect) into its first value per key. */
export function parseQuery(url: string): Record<string, string> {
  const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : url;
  const query = q.includes("#") ? q.slice(0, q.indexOf("#")) : q;
  const out: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, " "));
    const v = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** `/rooms/${roomId}/send/…` with every interpolated value percent-encoded as one path segment. */
export function path(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  let out = strings[0];
  values.forEach((v, i) => {
    out += encodeURIComponent(String(v)) + strings[i + 1];
  });
  return out;
}
