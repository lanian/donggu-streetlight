// Node 22 has a global `navigator` without Web Locks; Node 24 and browsers have both. app/data.js treats "navigator
// without locks" as a browser that cannot store safely, so tests that load it directly provide the same single-tab lock
// a browser gives. Loaded by test files, not a test itself.
if (globalThis.navigator && !globalThis.navigator.locks) {
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request: async (_name, fn) => fn() } });
}
