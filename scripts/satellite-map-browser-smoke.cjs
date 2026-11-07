/* Real Leaflet and app workflows; synthetic images and a fake key, with zero production network calls. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.DONGGU_SATELLITE_ARTIFACTS || path.join(require('node:os').tmpdir(), 'streetlight-v62-satellite-browser');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const server = http.createServer((req, res) => {
  let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { return res.writeHead(400).end(); }
  if (pathname.endsWith('/firebase-config.js')) return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('window.FIREBASE_CONFIG=null;');
  const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function poll(page, predicate, argument) {
  const until = Date.now() + 30000;
  while (!await page.evaluate(predicate, argument)) { if (Date.now() > until) throw new Error('Timed out: ' + predicate); await page.waitForTimeout(40); }
}
(async () => {
  const results = [], errors = [], network = { interceptedImagery: 0, interceptedStreet: 0, invalidImageryPaths: 0, productionCalls: 0 }; let browser;
  fs.mkdirSync(artifacts, { recursive: true });
  const pass = text => { results.push(text); console.log('PASS: ' + text); };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://localhost:' + server.address().port;
  try {
    browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    async function fixture(key = '') {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      await context.addInitScript(() => localStorage.setItem('dg-device', 'phone'));
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) {
          if (url.pathname === '/app/map-config.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, 'app/map-config.js'), 'utf8') + '\nglobalThis.DONGGU_SATELLITE_CONFIG=' + JSON.stringify({ apiKey: key, maxNativeZoom: 18 }) + ';' });
          return route.continue();
        }
        if (url.hostname === 'api.vworld.kr') {
          network.interceptedImagery++;
          const prefix = '/req/wmts/1.0.0/' + encodeURIComponent(key) + '/';
          if (url.protocol !== 'https:' || !url.pathname.startsWith(prefix) || !/^(Satellite\/\d+\/\d+\/\d+\.jpeg|Hybrid\/\d+\/\d+\/\d+\.png)$/.test(url.pathname.slice(prefix.length)) || url.search || url.hash) network.invalidImageryPaths++;
          return route.fulfill({ contentType: 'image/png', body: pixel });
        }
        if (url.hostname.endsWith('openstreetmap.org')) { network.interceptedStreet++; return route.fulfill({ contentType: 'image/png', body: pixel }); }
        return route.fulfill({ status: 200, contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: '' });
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin); await poll(page, () => typeof S !== 'undefined' && S.live && DGOffline.ready && DGIntegration.initialized);
      assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null); return { context, page };
    }
    {
      const { context, page } = await fixture();
      await page.evaluate(() => { localStorage.setItem('dg-map-background-v1', 'hybrid'); openMap('all'); });
      await page.locator('#gmap .dg-map-layers').waitFor();
      assert.equal(await page.locator('#gmap [aria-label="지도 배경"]').inputValue(), 'street');
      assert.equal(await page.locator('#gmap option:disabled').count(), 2); assert.match(await page.locator('#gmap .dg-map-layers-note').innerText(), /연결 준비 중/);
      assert.equal(network.interceptedImagery, 0); pass('missing key disables both imagery choices, explains setup and retains ordinary map'); await context.close();
    }
    const { context, page } = await fixture('synthetic-only/public?key#segment');
    await page.evaluate(() => { S.demoRole = 'admin'; openMap('all'); window.__background = Object.values(gmap._layers).find(layer => typeof layer.getMode === 'function'); });
    await page.locator('#gmap .dg-map-layers').waitFor();
    const select = page.locator('#gmap [aria-label="지도 배경"]');
    assert.equal(await select.evaluate(el => { const r = el.closest('.dg-map-layers').getBoundingClientRect(), b = document.querySelector('#mapLoc').getBoundingClientRect(); return r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom; }), true, 'main background selector must not overlap the existing location button');
    await page.evaluate(() => { window.__locationCalls = 0; const watch = navigator.geolocation.watchPosition.bind(navigator.geolocation); navigator.geolocation.watchPosition = (...args) => { __locationCalls++; return watch(...args); }; });
    await page.locator('#mapLoc').click(); assert.ok(await page.evaluate(() => __locationCalls > 0), 'existing location button still starts its geolocation workflow');
    await page.evaluate(() => {
      gmap.setView([35.146, 126.923], 19, { animate: false });
      window.__route = L.polyline([[35.146,126.923],[35.147,126.924]]).addTo(gmap);
      window.__gps = L.circleMarker([35.1461,126.9231]).addTo(gmap);
      window.__markers = gmapLayer.getLayers(); window.__view = { center: gmap.getCenter(), zoom: gmap.getZoom() };
    });
    await page.waitForTimeout(350);
    await page.evaluate(() => { window.__view = { center: gmap.getCenter(), zoom: gmap.getZoom() }; window.__markers = gmapLayer.getLayers(); });
    for (const [mode, count] of [['satellite', 1], ['hybrid', 2], ['street', 1], ['hybrid', 2]]) {
      await select.selectOption(mode);
      const state = await page.evaluate(() => ({ mode: __background.getMode(), count: __background.getLayers().length, sameView: gmap.getCenter().equals(__view.center) && gmap.getZoom() === __view.zoom, overlays: gmap.hasLayer(__route) && gmap.hasLayer(__gps) && __markers.every(m => gmapLayer.hasLayer(m)), zooms: __background.getLayers().map(l => l.options.maxZoom), native: __background.getLayers().map(l => l.options.maxNativeZoom) }));
      assert.equal(state.mode, mode); assert.equal(state.count, count); assert.equal(state.sameView, true, JSON.stringify(state)); assert.equal(state.overlays, true, JSON.stringify(state)); assert.ok(state.zooms.every(z => z === 19));
      if (mode !== 'street') assert.ok(state.native.every(z => z === 18));
    }
    await poll(page, () => __background.getLayers().every(l => Object.values(l._tiles || {}).some(t => t.el.naturalWidth > 0)));
    assert.ok(network.interceptedImagery > 0); assert.equal(network.invalidImageryPaths, 0);
    assert.equal(await page.evaluate(() => __background.getLayers().every(l => /^https:\/\/api\.vworld\.kr\/req\/wmts\/1\.0\.0\/synthetic-only%2Fpublic%3Fkey%23segment\/(Satellite\/\{z\}\/\{y\}\/\{x\}\.jpeg|Hybrid\/\{z\}\/\{y\}\/\{x\}\.png)$/.test(l._url))), true);
    pass('real Leaflet three modes, exact Hybrid pair, encoded key and native overzoom preserve view, facility markers, GPS and route overlays');

    await page.evaluate(() => document.documentElement.style.setProperty('--map-tiles', 'invert(1)'));
    const filters = await page.evaluate(() => ({ street: getComputedStyle(gmap.getPane('tilePane')).filter, imagery: __background.getLayers().map(l => getComputedStyle(gmap.getPane(l.options.pane)).filter), z: __background.getLayers().map(l => +getComputedStyle(gmap.getPane(l.options.pane)).zIndex) }));
    assert.equal(filters.street, 'invert(1)'); assert.deepEqual(filters.imagery, ['none', 'none']); assert.ok(filters.z.every(z => z < 400));
    assert.deepEqual(await page.evaluate(() => __background.getLayers().map(l => getComputedStyle(Object.values(l._tiles).find(t => t.el.naturalWidth > 0).el).mixBlendMode)), ['normal', 'normal'], 'imagery and road labels must retain their source colors without additive blending');
    await select.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
    assert.equal(await select.inputValue(), 'satellite'); assert.equal(await page.evaluate(() => __background.getMode()), 'satellite');
    await page.keyboard.press('End'); assert.equal(await select.inputValue(), 'hybrid');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#gmap').count(), 1);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(100);
      assert.equal(await select.evaluate(el => { const r = el.getBoundingClientRect(), b = el.closest('.leaflet-container').getBoundingClientRect(); return r.width >= 120 && r.left >= b.left && r.right <= b.right && r.height >= 32; }), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(artifacts, 'main-' + width + '.png') });
    }
    pass('keyboard selection and Escape retain map; mobile/desktop fit; night filter stays on ordinary tiles while imagery remains original color');

    const fallback = await page.evaluate(() => {
      __background.setMode('hybrid'); const layers = __background.getLayers(), old = layers[0], center = gmap.getCenter(), zoom = gmap.getZoom();
      old.fire('tileerror'); old.fire('tileerror'); old.fire('tileload');
      for (let i = 0; i < 3; i++) old.fire('tileerror'); const before = __background.getMode(); old.fire('tileerror');
      return { before, mode: __background.getMode(), note: document.querySelector('#mapNote').textContent, message: document.querySelector('#gmap .dg-map-layers-note').textContent, saved: localStorage.getItem('dg-map-background-v1'), sameView: gmap.getCenter().equals(center) && gmap.getZoom() === zoom };
    });
    assert.equal(fallback.before, 'hybrid'); assert.equal(fallback.mode, 'street'); assert.equal(fallback.sameView, true); assert.equal(fallback.saved, 'hybrid'); assert.match(fallback.message, /일반 지도/);
    assert.doesNotMatch(fallback.note, /마커 위치만/);
    pass('success resets error streak; fourth current imagery failure falls back with explanation, preserves preferred imagery and clears stale main-map warning');

    await page.setViewportSize({ width: 390, height: 844 });
    const lightId = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat) && Number.isFinite(l.lng) && !l.removed).id);
    await page.evaluate(() => closeSheet('all')); await poll(page, () => !document.querySelector('#sheet').classList.contains('open') && NAV.stack.length === 0);
    await page.evaluate(id => { openLightEdit(id); window.__editBackground = Object.values(leMap._layers).find(l => typeof l.getMode === 'function'); window.__editBefore = { lat: document.querySelector('#leLat').value, lng: document.querySelector('#leLng').value, marker: leMarker, center: leMap.getCenter(), zoom: leMap.getZoom(), form: JSON.stringify(DGIntegration.captureForm(document.querySelector('#sheetIn'))) }; window.__editClicks = 0; leMap.on('click dblclick', () => __editClicks++); }, lightId);
    await page.waitForTimeout(350); await page.evaluate(() => { __editBefore.center = leMap.getCenter(); __editBefore.zoom = leMap.getZoom(); });
    const editSelect = page.locator('#leMapBox [aria-label="지도 배경"]');
    assert.equal(await editSelect.inputValue(), 'hybrid'); assert.equal(await editSelect.getAttribute('id'), null);
    await editSelect.selectOption('street'); await editSelect.selectOption('hybrid');
    await editSelect.evaluate(el => { for (const type of ['click', 'dblclick', 'mousedown', 'touchstart', 'pointerdown', 'wheel', 'keydown']) el.dispatchEvent(new Event(type, { bubbles: true })); });
    assert.equal(await page.evaluate(() => __editClicks === 0 && leMarker === __editBefore.marker && document.querySelector('#leLat').value === __editBefore.lat && document.querySelector('#leLng').value === __editBefore.lng && leMap.getCenter().equals(__editBefore.center) && leMap.getZoom() === __editBefore.zoom && JSON.stringify(DGIntegration.captureForm(document.querySelector('#sheetIn'))) === __editBefore.form), true);
    await page.screenshot({ path: path.join(artifacts, 'editor-390.png') });
    pass('facility editor inherits saved preference; selection gestures leave editor marker, coordinates and captured business form unchanged');

    await page.reload(); await poll(page, () => S.live && DGOffline.ready && DGIntegration.initialized);
    await page.evaluate(() => { openMap('all'); window.__background = Object.values(gmap._layers).find(l => typeof l.getMode === 'function'); });
    assert.equal(await page.locator('#gmap [aria-label="지도 배경"]').inputValue(), 'hybrid');
    const disposal = await page.evaluate(() => {
      const b = __background, oldTile = b.getLayers()[0], oldControl = document.querySelector('#gmap .dg-map-layers'), oldSelect = oldControl.querySelector('select');
      const error = oldTile._events.tileerror[0].fn;
      b.setMode('satellite'); for (let i = 0; i < 8; i++) error({}); const staleSafe = b.getMode() === 'satellite';
      const currentError = b.getLayers()[0]._events.tileerror[0].fn; b.remove(); const saved = localStorage.getItem('dg-map-background-v1');
      oldSelect.value = 'street'; oldSelect.dispatchEvent(new Event('change', { bubbles: true })); for (let i = 0; i < 8; i++) currentError({}); b.setMode('street');
      const disposedSafe = b.getMode() === 'satellite' && localStorage.getItem('dg-map-background-v1') === saved && !oldControl.isConnected;
      b.addTo(gmap); return { staleSafe, disposedSafe, controls: document.querySelectorAll('#gmap .dg-map-layers').length };
    });
    assert.deepEqual(disposal, { staleSafe: true, disposedSafe: true, controls: 1 });
    pass('reload restores display preference; old image events and disposed selector cannot write state; reattachment creates exactly one control');

    await page.evaluate(() => closeSheet('all')); await poll(page, () => !document.querySelector('#sheet').classList.contains('open') && NAV.stack.length === 0);
    await page.evaluate(() => { openPatrol('전체'); if (pt.watch != null) navigator.geolocation.clearWatch(pt.watch); pt.watch = null; ptView('map'); ptMapRotate(-63); window.__patrolBackground = Object.values(pt.map._layers).find(l => typeof l.getMode === 'function'); });
    const patrolSelect = page.locator('#ptMapBox > .dg-map-layers [aria-label="지도 배경"]'); await patrolSelect.waitFor();
    await page.waitForTimeout(350);
    const patrolBefore = await page.evaluate(() => { window.__patrolBefore = { marker: pt.mapMe, route: pt.mapTrack }; return { center: pt.map.getCenter(), zoom: pt.map.getZoom(), follow: pt.mapFollow }; });
    await patrolSelect.selectOption('hybrid');
    assert.equal(await patrolSelect.evaluate(el => { const box = document.querySelector('#ptMapBox').getBoundingClientRect(), r = el.getBoundingClientRect(); return !document.querySelector('#ptMapRot').contains(el) && getComputedStyle(el.closest('.dg-map-layers')).transform === 'none' && r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom; }), true);
    assert.equal(await patrolSelect.evaluate(el => { const r = el.closest('.dg-map-layers').getBoundingClientRect(); return ['ptMapFollow', 'ptMapHeadUp'].every(id => { const b = document.getElementById(id).getBoundingClientRect(); return r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom; }); }), true, 'patrol background selector must not overlap follow or heading controls');
    assert.equal(await page.evaluate(before => pt.map.getCenter().equals(before.center) && pt.map.getZoom() === before.zoom && pt.mapMe === __patrolBefore.marker && pt.mapTrack === __patrolBefore.route && pt.map.hasLayer(pt.mapMe) && pt.map.hasLayer(pt.mapTrack) && pt.mapFollow === before.follow, patrolBefore), true);
    assert.equal(await page.evaluate(() => document.querySelector('#ptMapRot').style.transform), 'rotate(-63deg)');
    await page.screenshot({ path: path.join(artifacts, 'patrol-390.png') });
    await page.evaluate(() => { ptMap(false); }); assert.equal(await page.locator('#ptMapBox > .dg-map-layers').count(), 0);
    await page.evaluate(() => { ptReset(); openMap('all'); window.__background = Object.values(gmap._layers).find(l => typeof l.getMode === 'function'); });
    pass('patrol heading rotation keeps selector upright, visible and outside turning plate; switching retains follow, GPS and route; removal cleans external host');

    assert.deepEqual(errors, []); assert.equal(network.invalidImageryPaths, 0); console.log(JSON.stringify({ results, browserErrors: errors, network, artifacts, evidence: 'Synthetic image and key fixtures only; live VWorld access and licence are not verified.' }, null, 2));
    await context.close();
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
