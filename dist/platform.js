// src/platform.ts
const g = globalThis;
function setTimer(fn, ms) {
	return g.setTimeout(fn, ms);
}
function clearTimer(handle) {
	g.clearTimeout(handle);
}
/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const onAbort = () => {
			clearTimer(handle);
			reject(abortError());
		};
		const handle = setTimer(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function newAbortController() {
	if (!g.AbortController) throw new Error("AbortController is not available on this platform");
	return new g.AbortController();
}
var AbortError = class extends Error {
	constructor() {
		super("The operation was aborted");
		this.name = "AbortError";
	}
};
function abortError() {
	return new AbortError();
}
function isAbortError(e) {
	return e instanceof Error && e.name === "AbortError";
}
/**
* crypto.getRandomValues: native in Node.js and browsers; in React Native it comes from a
* polyfill (react-native-get-random-values) that the app imports before the SDK.
*/
function platformRandomValues() {
	const c = g.crypto;
	if (!c || typeof c.getRandomValues !== "function") return void 0;
	return (array) => c.getRandomValues(array);
}
function platformConsole() {
	return g.console;
}
function platformFetch() {
	const f = globalThis.fetch;
	return typeof f === "function" ? f.bind(globalThis) : void 0;
}
export { AbortError, abortError, clearTimer, isAbortError, newAbortController, platformConsole, platformFetch, platformRandomValues, setTimer, sleep };

//# sourceMappingURL=platform.js.map