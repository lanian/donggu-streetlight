/* Versioned public shell, deliberate updates, and bounded public runtime caches.
   No API, report submission, auth response, POST, or user attachment is cached.
   OSM tiles use the browser HTTP cache (Cache-Control/Expires/ETag) unchanged; no prefetch. */
importScripts('./app/map-config.js');
const VERSION = 'v18';
const SHELL = 'dg-shell-' + VERSION, RUNTIME = 'dg-runtime-public-v2', META = 'dg-cache-metadata-v2', TILES = 'dg-provider-tiles-v2';
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './firebase-config.js', './security.js', './report/config.js', './report/', './report/index.html', './data/lights.json', './seed/manifest.json', './vendor/jsQR.js', './vendor/leaflet.js', './vendor/qrcode.js', './app/field.js', './app/field-ui.js', './app/pwa.js', './app/map-config.js', './app/data.js', './app/restore.js', './app/integration.js', './app/legacy-bridge.js', './app/management.js', './app/offline.js', './app/operations-core.js', './app/reporting.js', './app/operations.css', './app/operations.js', './app/workflows.js', './app/lighting-model.js', './app/lighting-commands.js', './app/lighting-workflow-core.js', './app/lighting-workflow-commands.js', './app/lighting-workflows.js', './app/lighting.js', './app/lighting-review.js', './app/lighting-area-core.js', './app/lighting-area-commands.js', './app/lighting-areas.js', './app/registry-commands.js', './app/work-commands.js', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];
// All modules used by this release are installed atomically with its shell.
const PUBLIC_PATHS = new Set(SHELL_FILES.map(p => new URL(p, self.registration.scope).pathname));
const RUNTIME_HOSTS = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'tessdata.projectnaptha.com']);
const DAY = 86400000;

self.addEventListener('install', event => { event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(SHELL_FILES))); });
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Keep one previous shell so a tab with an unsaved draft can finish its loaded version.
    const names = await caches.keys(), shells = names.filter(n => n.startsWith('dg-shell-') && n !== SHELL);
    await Promise.all(shells.slice(0, -1).map(n => caches.delete(n)));
    await Promise.all(names.filter(n => /^dg-(runtime-v\d+|tiles-v\d+)$/.test(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'activate-update') event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'offline-status') event.waitUntil(offlineStatus().then(status => event.ports[0]?.postMessage(status)));
});

function metadataKey(url) { return new Request(new URL('__dg_cache_metadata__?url=' + encodeURIComponent(url), self.registration.scope)); }
async function readMetadata(url) { const r = await (await caches.open(META)).match(metadataKey(url)); return r ? r.json() : null; }
function cachePolicy(response, fallbackMs, now = Date.now()) {
  const control = response.headers.get('cache-control') || '';
  if (/\b(no-store|private|no-cache)\b/i.test(control)) return null;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(control);
  const date = Date.parse(response.headers.get('date'));
  const age = Math.max(0, Number(response.headers.get('age')) || 0) * 1000;
  const expires = Date.parse(response.headers.get('expires'));
  const expiresAt = maxAge ? Math.min(now, Number.isFinite(date) ? date : now) + Number(maxAge[1]) * 1000 - age : Number.isFinite(expires) ? expires : now + fallbackMs;
  return { storedAt: now, expiresAt, mustRevalidate: /\bmust-revalidate\b/i.test(control) };
}
async function putPublic(cache, request, response, fallbackMs) {
  if (!(response.ok || response.type === 'opaque')) return;
  const metadata = cachePolicy(response, fallbackMs); if (!metadata) return;
  await cache.put(request, response.clone());
  await (await caches.open(META)).put(metadataKey(request.url), new Response(JSON.stringify(metadata)));
}
async function trim(name, limit) {
  const cache = await caches.open(name), keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) { await cache.delete(key); await (await caches.open(META)).delete(metadataKey(key.url)); }
}
async function publicRuntime(request, name, fallbackMs, limit) {
  const cache = await caches.open(name), hit = await cache.match(request), metadata = hit && await readMetadata(request.url);
  if (hit && metadata && metadata.expiresAt > Date.now()) return hit;
  try {
    // Default fetch cache mode lets the browser revalidate expired HTTP entries conditionally.
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') { await putPublic(cache, request, response, fallbackMs); await trim(name, limit); }
    return response;
  } catch (_) { return hit && metadata && !metadata.mustRevalidate ? hit : Response.error(); }
}
function runtimeAsset(url) {
  if (!RUNTIME_HOSTS.has(url.hostname)) return false;
  if (url.hostname === 'www.gstatic.com') return /^\/firebasejs\/[^/]+\/firebase-[\w-]+\.js$/.test(url.pathname);
  return /\.(?:js|wasm|css|woff2?|ttf|traineddata(?:\.gz)?)$/.test(url.pathname) || url.hostname === 'fonts.googleapis.com' && /^\/css2?$/.test(url.pathname);
}
function providerTile(request, url) {
  const p = globalThis.DONGGU_MAP_PROVIDER;
  if (!p || p.offlineAllowed !== true || p.requiresKey && !p.apiKey || request.destination !== 'image') return false;
  try {
    const template = new URL(String(p.urlTemplate).replaceAll('{key}', encodeURIComponent(p.apiKey || '')), self.registration.scope).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
    const host = new URL(template).hostname;
    if (/(^|\.)openstreetmap\.org$/.test(host)) return false;
    const pattern = template.split(/(\{[zxy]\})/).map(part => /^\{[zxy]\}$/.test(part) ? '\\d+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp('^' + pattern + '$').test(url.href);
  } catch (_) { return false; }
}
async function offlineStatus() {
  const shell = await caches.open(SHELL);
  const files = await Promise.all(SHELL_FILES.map(p => shell.match(new URL(p, self.registration.scope).href)));
  const keys = await (await caches.open(RUNTIME)).keys(), paths = keys.map(k => k.url);
  const ocr = [/tesseract(?:\.min)?\.js/, /worker(?:\.min)?\.js/, /tesseract-core.*\.wasm\.js/, /\.wasm(?:\?|$)/, /kor\.traineddata/, /eng\.traineddata/].every(re => paths.some(p => re.test(p)));
  return { version: VERSION, shell: files.every(Boolean), registry: !!(await shell.match(new URL('./data/lights.json', self.registration.scope))), ocr, missing: SHELL_FILES.filter((_, i) => !files[i]) };
}
self.addEventListener('fetch', event => {
  const request = event.request; if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === location.origin && PUBLIC_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL), key = new Request(url.origin + url.pathname), hit = await cache.match(key);
      if (hit) return hit; // Executable assets stay with the active release until deliberate activation.
      try { const response = await fetch(request); if (response.ok) await cache.put(key, response.clone()); return response; }
      catch (_) { return new Response('앱 파일 준비가 완료되지 않았어요. 연결 후 다시 열어 주세요.', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } }); }
    })()); return;
  }
  if (url.hostname === 'tile.openstreetmap.org') return; // Browser HTTP caching; no tile archive or prefetch.
  if (providerTile(request, url)) { event.respondWith(publicRuntime(request, TILES, Math.max(1, Number(DONGGU_MAP_PROVIDER.cacheDays) || 7) * DAY, 600)); return; }
  if (runtimeAsset(url)) event.respondWith(publicRuntime(request, RUNTIME, 30 * DAY, 120));
});
