const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const scope = 'https://example.test/app/';
function swContext() {
  const listeners = {}, stores = new Map();
  const key = x => x.url || new URL(String(x), scope).href;
  const cache = name => {
    if (stores.has(name)) return stores.get(name);
    const data = new Map();
    const c = { data, async match(k) { return data.get(key(k))?.clone(); },
      async put(k, v) { data.set(key(k), v.clone()); }, async delete(k) { return data.delete(key(k)); },
      async keys() { return [...data.keys()].map(url => new Request(url)); },
      async addAll(paths) { for (const p of paths) data.set(key(p), new Response('public static file')); }
    }; stores.set(name, c); return c;
  };
  const counts = { skip: 0, claim: 0, network: 0 };
  const context = vm.createContext({ URL, Request, Response, Date, Set, DONGGU_MAP_PROVIDER: null, importScripts() {},
    self: { registration: { scope }, addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: async () => { counts.skip++; }, clients: { claim: async () => { counts.claim++; } } },
    location: { origin: 'https://example.test' },
    caches: { open: async name => cache(name), keys: async () => [...stores.keys()], delete: async name => stores.delete(name) },
    fetch: async () => { counts.network++; return new Response('fresh', { headers: { 'Cache-Control': 'max-age=3600' } }); }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), context);
  return { context, listeners, stores, cache, counts };
}

test('install keeps updates waiting; only the explicit update message activates them', async () => {
  const { context, listeners, counts } = swContext();
  let task;
  listeners.install({ waitUntil(p) { task = p; } }); await task;
  assert.equal(counts.skip, 0);
  const status = await context.offlineStatus(); assert.equal(status.shell, true); assert.equal(status.registry, true); assert.equal(status.ocr, false);
  listeners.message({ data: 'skipWaiting', waitUntil() { assert.fail('legacy automatic activation must not run'); } });
  assert.equal(counts.skip, 0);
  listeners.message({ data: { type: 'activate-update' }, waitUntil(p) { task = p; } }); await task;
  assert.equal(counts.skip, 1);
});

test('public shell whitelist excludes API/report submissions and leaves OSM HTTP caching untouched', () => {
  const { listeners } = swContext();
  for (const [url, method] of [['api/gateway', 'GET'], ['citizen_reports/private-id', 'GET'], ['index.html', 'POST'], ['https://tile.openstreetmap.org/16/1/2.png', 'GET']]) {
    listeners.fetch({ request: { url: new URL(url, scope).href, method }, respondWith() { assert.fail(`${method} ${url} must not be intercepted`); } });
  }
});

test('cache TTL honors cache-control and excludes private/no-store responses', () => {
  const { context } = swContext(), now = Date.parse('2026-10-22T12:00:00Z');
  for (const control of ['private, max-age=500', 'no-store', 'no-cache']) assert.equal(context.cachePolicy(new Response('', { headers: { 'Cache-Control': control } }), 1000, now), null);
  const policy = context.cachePolicy(new Response('', { headers: { 'Cache-Control': 'max-age=3600, must-revalidate', Date: 'Thu, 22 Oct 2026 12:00:00 GMT' } }), 1000, now);
  assert.equal(policy.expiresAt, now + 3600000); assert.equal(policy.mustRevalidate, true);
  assert.equal(context.cachePolicy(new Response(''), 7000, now).expiresAt, now + 7000);
});

test('fresh runtime assets avoid network; expired assets are revalidated and bounded', async () => {
  const { context, counts, cache } = swContext();
  const request = new Request('https://cdn.jsdelivr.net/npm/example/file.js');
  const response = new Response('cached', { headers: { 'Cache-Control': 'max-age=3600' } });
  await context.putPublic(cache('test-runtime'), request, response, 1000);
  assert.equal(await (await context.publicRuntime(request, 'test-runtime', 1000, 2)).text(), 'cached');
  assert.equal(counts.network, 0);
  await cache('dg-cache-metadata-v2').put(context.metadataKey(request.url), new Response(JSON.stringify({ expiresAt: 0, mustRevalidate: true })));
  assert.equal(await (await context.publicRuntime(request, 'test-runtime', 1000, 2)).text(), 'fresh');
  assert.equal(counts.network, 1);
});

test('only explicitly permitted provider image tiles can enter the optional offline cache', () => {
  const { context } = swContext();
  const request = { destination: 'image' };
  context.DONGGU_MAP_PROVIDER = { urlTemplate: 'https://maps.example/{z}/{x}/{y}.png?key={key}', offlineAllowed: true, requiresKey: true, apiKey: '' };
  assert.equal(context.providerTile(request, new URL('https://maps.example/1/2/3.png?key=')), false);
  context.DONGGU_MAP_PROVIDER.apiKey = 'public-key';
  assert.equal(context.providerTile(request, new URL('https://maps.example/1/2/3.png?key=public-key')), true);
  assert.equal(context.providerTile({ destination: 'script' }, new URL('https://maps.example/1/2/3.png?key=public-key')), false);
  context.DONGGU_MAP_PROVIDER = { urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', offlineAllowed: true };
  assert.equal(context.providerTile(request, new URL('https://tile.openstreetmap.org/1/2/3.png')), false);
});

test('every required shell asset exists, and OCR readiness requires both languages and both core components', async () => {
  const { context, cache } = swContext();
  const files = vm.runInContext('SHELL_FILES', context);
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file.endsWith('/') ? file + 'index.html' : file)), file);
  const runtime = cache('dg-runtime-public-v2');
  // what tesseract.js 5.x actually fetches: the core wasm is embedded in the .wasm.js file, no separate .wasm request
  const assets = ['tesseract.min.js', 'worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'kor.traineddata.gz', 'eng.traineddata.gz'];
  for (const asset of assets.slice(0, -1)) await runtime.put('https://cdn.jsdelivr.net/' + asset, new Response('asset'));
  assert.equal((await context.offlineStatus()).ocr, false);
  await runtime.put('https://cdn.jsdelivr.net/' + assets.at(-1), new Response('asset'));
  assert.equal((await context.offlineStatus()).ocr, true);
});

async function pwaContext(dirty = false) {
  const listeners = {}, calls = { posts: 0, reloads: 0, notices: 0 };
  const waiting = { addEventListener() {}, postMessage() { calls.posts++; } };
  const c = vm.createContext({ URL, encodeURIComponent, setTimeout, clearTimeout, MessageChannel,
    document: { readyState: 'complete', baseURI: scope, getElementById: () => null, addEventListener() {} },
    location: { origin: 'https://example.test', reload() { calls.reloads++; } },
    navigator: { serviceWorker: { controller: {}, addEventListener(type, fn) { listeners[type] = fn; }, register: async () => ({ waiting, addEventListener() {} }) } },
    DONGGU_MAP_PROVIDER: null
  }); c.window = c;
  vm.runInContext(fs.readFileSync(path.join(root, 'app/pwa.js'), 'utf8'), c);
  const flags = { dirty };
  c.DongguPWA.start({ hasPendingWork: async () => flags.dirty, notice: () => { calls.notices++; } });
  await new Promise(setImmediate);
  return { c, flags, calls, listeners };
}

test('applying an update awaits durable drafts/outbox checks and never reloads dirty work', async () => {
  const { c, flags, calls, listeners } = await pwaContext(true);
  assert.equal(await c.DongguPWA.applyUpdate(), false); assert.equal(calls.posts, 0);
  flags.dirty = false; assert.equal(await c.DongguPWA.applyUpdate(), true); assert.equal(calls.posts, 1); assert.equal(calls.reloads, 0);
  flags.dirty = true; await listeners.controllerchange(); assert.equal(calls.reloads, 0);
  flags.dirty = false; await c.DongguPWA.applyUpdate(); assert.equal(calls.reloads, 1);
});

test('activation by another tab does not reload this tab, and missing provider keys are explicit', async () => {
  const { c, calls, listeners } = await pwaContext(false);
  await listeners.controllerchange(); assert.equal(calls.reloads, 0);
  c.DONGGU_MAP_PROVIDER = { requiresKey: true, apiKey: '', urlTemplate: 'https://maps.example/{z}/{x}/{y}.png' };
  const p = c.DongguPWA.provider(); assert.equal(p.offlineAllowed, false); assert.match(p.reason, /키가 없어/);
});
