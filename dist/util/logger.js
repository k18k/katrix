import { platformConsole } from "../platform.js";
export const noopLogger = { debug() { }, info() { }, warn() { }, error() { } };
export function consoleLogger(prefix = "[matrix]") {
    const c = platformConsole();
    if (!c)
        return noopLogger;
    const line = (m, d) => (d ? [prefix, m, d] : [prefix, m]);
    return {
        debug: (m, d) => c.debug(...line(m, d)),
        info: (m, d) => c.info(...line(m, d)),
        warn: (m, d) => c.warn(...line(m, d)),
        error: (m, d) => c.error(...line(m, d)),
    };
}
/** A safe summary of an error for a log line: its class, code and message, never a stack of data. */
export function describeError(e) {
    if (e instanceof Error) {
        const code = e.errcode ?? e.code;
        return { error: e.name, ...(code !== undefined ? { code } : {}), message: e.message };
    }
    return { error: typeof e };
}
