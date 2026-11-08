/* Synthetic polygon editor workflows. No Firebase, service worker, live tiles, or external mutation is used. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DONGGU_AREAS_ROOT || path.join(__dirname, '..'));
const latitude = 35.14, longitude = 126.93;
const registry = { cols: ['id', 'kind', 'code', 'dong', 'lampType', 'lat', 'lng'], count: 1, rows: [
  ['polygon-fixture-light', '가로등', '다각형검증 1', '지산동', 'LED일반형', latitude, longitude]
] };
const server = http.createServer((req, res) => {
  if (req.url.split('?')[0].endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG=null;'); }
  let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { return res.writeHead(400).end(); }
  const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function poll(page, fn, arg, label) {
  const until = Date.now() + 20000;
  do { if (await page.evaluate(fn, arg)) return; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < until);
  throw new Error('Timed out: ' + label);
}
const parse = text => text.trim() ? text.trim().split(/\r?\n/).map(line => { const [lat, lng] = line.split(',').map(Number); return { lat, lng }; }) : [];
const serialize = points => points.map(point => point.lat + ', ' + point.lng).join('\n');
(async () => {
  const results = [], errors = [], mutations = []; let browser;
  const record = label => { results.push(label); console.log('PASS: ' + label); };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  try {
    browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') { mutations.push({ method: request.method(), path: url.pathname }); return route.abort(); }
      if (url.origin !== origin) return route.fulfill({ status: 200, body: '', contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/plain' });
      if (url.pathname === '/data/lights.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(registry) });
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(() => {
      window.__polygonAutoDialog = true;
      new MutationObserver(() => { const ok = document.querySelector('#dgDialog:not([hidden]) [data-dgdlg="ok"]'); if (ok && window.__polygonAutoDialog) ok.click(); }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    });
    const ready = async () => {
      await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGOffline.ready && typeof DGLightingAreas !== 'undefined');
      assert.equal(await page.evaluate(() => DGIntegration.whenReady()), true);
      await poll(page, () => DGLightingAreas.state.loaded, null, 'area records loaded');
      await page.evaluate(() => { const original = L.map; L.map = function (...args) { const map = original.apply(this, args); if (args[0]?.id === 'laMap') window.__polygonMap = map; return map; }; });
    };
    const text = () => page.locator('#laVertices').inputValue();
    const points = async () => parse(await text());
    const count = () => page.locator('.la-vertex').count();
    const coordinates = async () => { if (!await page.locator('#laCoordinateDetails').evaluate(el => el.open)) await page.locator('#laCoordinateDetails > summary').click(); };
    const setCoordinates = async value => { await coordinates(); await page.locator('#laVertices').fill(value); };
    const marker = index => page.locator('.la-vertex').nth(index);
    const captureMarker = async index => page.evaluate(index => { window.__oldPolygonMarker = Object.values(__polygonMap._layers).find(layer => layer.getElement?.()?.classList.contains('la-vertex') && layer.getElement()?.getAttribute('aria-label') === '경계점 ' + (index + 1)); if (!__oldPolygonMarker) throw new Error('Fixture marker not found'); }, index);
    const save = async (id, revision) => {
      await page.locator('#laSave').click(); await poll(page, ({ id, revision }) => DGLightingAreas.state.records.find(row => row.id === id)?.revision === revision, { id, revision }, 'polygon saved');
      await page.locator('#laForm').waitFor({ state: 'hidden' });
    };
    const clickMap = async position => {
      await page.locator('#laMap').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#laMap').evaluate((map, point) => { const bounds = map.getBoundingClientRect(), x = bounds.left + point.x, y = bounds.top + point.y; return [...map.querySelectorAll('.leaflet-control')].some(control => { const b = control.getBoundingClientRect(); return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom; }); }, position), false, 'Fixture click must hit the map canvas');
      await page.locator('#laMap').click({ position });
    };

    await page.goto(origin); await ready();
    assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null); assert.equal(await page.evaluate(() => S.me), 'local');
    await page.evaluate(() => DGLightingAreas.openEditor({ label: '합성 다각형 편집', lat: 35.14, lng: 126.93 }));
    await page.locator('#laShape').selectOption('polygon'); await page.locator('#laMap.leaflet-container').waitFor();
    assert.equal(await page.locator('#laDrawMode').count(), 1, 'The explicit polygon draw/edit controls must exist.');
    assert.equal(await page.locator('#laDrawMode').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#laCoordinateDetails').evaluate(el => el.open), false);
    assert.equal(await page.locator('#laMap').evaluate(map => Boolean(map.compareDocumentPosition(document.querySelector('#laCoordinateDetails')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    record('polygon drawing starts on the map with raw coordinates collapsed below it');

    for (const position of [{ x: 85, y: 100 }, { x: 235, y: 100 }, { x: 235, y: 235 }, { x: 85, y: 235 }]) await clickMap(position);
    assert.equal((await points()).length, 4); assert.equal(await count(), 4);
    for (let index = 0; index < 4; index++) assert.equal(await marker(index).getAttribute('aria-label'), '경계점 ' + (index + 1));
    assert.match(await page.locator('#laPointState').textContent(), /4/);
    await page.locator('#laEditMode').click(); assert.equal(await page.locator('#laEditMode').getAttribute('aria-pressed'), 'true');
    const firstBoundary = await text(); await clickMap({ x: 165, y: 275 }); assert.equal(await text(), firstBoundary);
    record('numbered vertices and finish drawing prevent accidental extra points while editing');

    await page.locator('#laMap').scrollIntoViewIfNeeded(); const beforeDrag = await text(), beforePoints = await points();
    const bounds = await marker(1).boundingBox(); assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 18, bounds.y + bounds.height / 2 + 12, { steps: 8 }); await page.mouse.up();
    await poll(page, before => document.querySelector('#laVertices').value !== before, beforeDrag, 'vertex drag commits');
    const afterDrag = await text(), afterPoints = await points();
    assert.equal(afterPoints.length, 4); assert.notDeepEqual(afterPoints[1], beforePoints[1]);
    for (const index of [0, 2, 3]) assert.deepEqual(afterPoints[index], beforePoints[index]);
    await page.locator('#laUndo').click(); assert.equal(await text(), beforeDrag);
    await page.locator('#laRedo').click(); assert.equal(await text(), afterDrag);
    record('real pointer dragging moves only the chosen vertex and supports undo and redo');

    await marker(2).press('Enter'); assert.equal(await marker(2).evaluate(el => el.classList.contains('is-selected')), true);
    await page.locator('#laDeletePoint').click(); assert.deepEqual(await points(), afterPoints.filter((_, index) => index !== 2));
    await page.locator('#laUndo').click(); assert.equal(await text(), afterDrag);
    record('a selected middle vertex can be removed and restored without retyping the other points');

    const beforeInsert = await points(); await page.locator('.la-midpoint').first().click();
    const inserted = await points(); assert.equal(inserted.length, 5);
    assert.ok(inserted.some(point => Math.abs(point.lat - (beforeInsert[0].lat + beforeInsert[1].lat) / 2) < .000002 && Math.abs(point.lng - (beforeInsert[0].lng + beforeInsert[1].lng) / 2) < .000002));
    assert.deepEqual(inserted[0], beforeInsert[0]); assert.deepEqual(inserted.slice(2), beforeInsert.slice(1));
    const validBoundary = await text();
    record('an edge midpoint inserts a new editable point into the correct boundary order');

    await page.locator('#laDrawMode').click(); await clickMap({ x: 165, y: 275 }); assert.equal((await points()).length, 6);
    await page.locator('#laUndo').click(); assert.equal(await text(), validBoundary); await page.locator('#laEditMode').click();
    record('adding more vertices requires the explicit draw mode and remains reversible');

    const invalid = '35.14, 126.93\nnot a coordinate'; await setCoordinates(invalid);
    assert.match(await page.locator('#laGeometryHint').textContent(), /2번째|좌표|위도/);
    await page.locator('#laUndo').click(); assert.equal(await text(), validBoundary);
    await page.locator('#laRedo').click(); assert.equal(await text(), invalid);
    await page.locator('#laUndo').click(); assert.equal(await text(), validBoundary);
    record('manual coordinate edits, including invalid raw text, can be undone and redone exactly');

    const p = parse(firstBoundary), crossed = serialize([p[0], p[2], p[1], p[3]]);
    await setCoordinates(crossed); assert.match(await page.locator('#laGeometryHint').textContent(), /교차|겹|형상|경계/);
    const recordsBefore = await page.evaluate(() => DGLightingAreas.state.records.length);
    await page.locator('#laSave').evaluate(button => button.click());
    assert.equal(await page.evaluate(() => DGLightingAreas.state.records.length), recordsBefore); assert.equal(await page.locator('#laForm').isVisible(), true);
    await page.locator('#laUndo').click(); assert.equal(await text(), validBoundary);
    record('self-crossing geometry stays visible for correction and cannot be committed');

    await page.evaluate(() => { window.__polygonAutoDialog = false; });
    await page.locator('[data-la="clear-points"]').click(); await page.locator('#dgDialog:not([hidden])').waitFor();
    await page.locator('#dgDialog [data-dgdlg="cancel"]').click(); assert.equal(await text(), validBoundary);
    await page.evaluate(() => { window.__polygonAutoDialog = true; }); await page.locator('[data-la="clear-points"]').click();
    await poll(page, () => document.querySelector('#laVertices').value === '', null, 'clear points confirmed');
    await page.locator('#laUndo').click(); assert.equal(await text(), validBoundary);
    record('clearing a boundary asks first and a confirmed clear can still be undone');

    const many = Array.from({ length: 32 }, (_, index) => ({ lat: +(latitude + .0008 * Math.sin(index * 2 * Math.PI / 32)).toFixed(6), lng: +(longitude + .0008 * Math.cos(index * 2 * Math.PI / 32)).toFixed(6) }));
    await page.locator('#laDrawMode').click(); await setCoordinates(serialize(many));
    assert.equal(await page.locator('#laDrawMode').isDisabled(), true);
    await clickMap({ x: 45, y: 285 });
    await page.evaluate(() => __polygonMap.fire('click', { latlng: L.latLng(35.141, 126.931) }));
    assert.equal((await points()).length, 32); assert.match(await page.locator('#laPointState').textContent(), /32/);
    await page.locator('#laUndo').click(); assert.equal(await text(), validBoundary);
    record('the 32-point limit rejects further map points without losing the current boundary');

    const id = await page.evaluate(() => DGLightingAreas.state.draft.recordId); await page.evaluate(() => DGLightingAreas.persistActive());
    await page.reload(); await ready(); await page.evaluate(id => DGLightingAreas.openEditor(null, id, true), id);
    await page.locator('#laMap.leaflet-container').waitFor(); assert.equal(await text(), validBoundary);
    assert.equal(await page.locator('#laEditMode').getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('#laCoordinateDetails').evaluate(el => el.open), false);
    await save(id, 1);
    const saved = await page.evaluate(id => DGLightingAreas.state.records.find(row => row.id === id), id);
    assert.equal(saved.shape, 'polygon'); assert.equal(saved.radius, 0); assert.deepEqual(saved.vertices, parse(validBoundary));
    for (const key of ['history', 'redo', 'mode', 'selected']) assert.equal(Object.hasOwn(saved, key), false);
    record('a recovered draft preserves the boundary and saving keeps the existing polygon payload contract');

    await page.evaluate(id => DGLightingAreas.openEditor(null, id), id); await page.locator('#laMap.leaflet-container').waitFor();
    await captureMarker(1); const beforeRole = await text();
    await page.evaluate(() => { S.demoRole = 'inspector'; __oldPolygonMarker.setLatLng([35.141, 126.931]); __oldPolygonMarker.fire('dragend'); __polygonMap.fire('click', { latlng: L.latLng(35.141, 126.931) }); });
    assert.equal(await text(), beforeRole); await page.evaluate(() => { S.demoRole = 'admin'; });
    await page.evaluate(() => DGLightingAreas.openEditor({ label: '이전 지도 콜백 차단', lat: 35.14, lng: 126.93, shape: 'polygon' }));
    const replacementId = await page.evaluate(() => DGLightingAreas.state.draft.recordId); const replacementText = await text();
    await page.evaluate(() => { __oldPolygonMarker.fire('click'); __oldPolygonMarker.fire('dragend'); });
    assert.equal(await text(), replacementText); assert.equal(await page.evaluate(() => DGLightingAreas.state.draft.recordId), replacementId);
    record('lost permissions and stale vertex callbacks cannot modify the active or replacement draft');

    await page.evaluate(id => DGLightingAreas.openEditor(null, id), id); await page.locator('#laMap.leaflet-container').waitFor();
    await captureMarker(0); const beforePending = await text(); await page.locator('#laNote').fill('합성 저장 대기 검사');
    await page.evaluate(() => {
      window.__polygonPending = { started: false, resolve: null };
      DGOffline.register('lighting-area', async job => { __polygonPending.started = true; await new Promise(resolve => { __polygonPending.resolve = resolve; }); return DGLightingAreaCommands.execute(job, { db, fb: FB && FB.fs, user: S.me, admin: can('admin') }); });
    });
    await page.locator('#laSave').click(); await poll(page, () => __polygonPending.started, null, 'pending write reached handler');
    await page.evaluate(() => { __oldPolygonMarker.setLatLng([35.141, 126.931]); __oldPolygonMarker.fire('dragend'); __polygonMap.fire('click', { latlng: L.latLng(35.141, 126.931) }); });
    assert.equal(await text(), beforePending);
    await page.evaluate(() => { __polygonPending.resolve(); DGOffline.register('lighting-area', job => DGLightingAreaCommands.execute(job, { db, fb: FB && FB.fs, user: S.me, admin: can('admin') })); });
    await poll(page, id => DGLightingAreas.state.records.find(row => row.id === id)?.revision === 2, id, 'pending write completed');
    await page.locator('#laForm').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(id => DGLightingAreas.state.records.find(row => row.id === id).vertices, id), parse(beforePending));
    record('a pending save keeps its fixed geometry despite late map or drag callbacks');

    await page.evaluate(() => { S.demoRole = 'inspector'; }); await page.evaluate(id => DGLightingAreas.openEditor(null, id), id);
    await page.locator('#laMap.leaflet-container').waitFor(); const readonly = await text();
    assert.equal(await page.locator('#laForm fieldset').evaluate(element => element.disabled), true);
    assert.equal(await page.locator('#laShape').isDisabled(), true);
    await page.evaluate(() => __polygonMap.fire('click', { latlng: L.latLng(35.141, 126.931) })); assert.equal(await text(), readonly);
    await page.evaluate(() => { S.demoRole = 'admin'; }); await page.evaluate(id => DGLightingAreas.openEditor(null, id), id);
    await page.locator('#laMap.leaflet-container').waitFor();
    record('read-only staff can inspect a saved boundary without activating drawing tools');

    await page.evaluate(vertices => DGLightingAreas.openEditor({ label: '합성 경계 편집 미리보기', shape: 'polygon', vertices, lat: 35.14, lng: 126.93, note: '화면 검증용 자료입니다. 실제 제외 범위를 판단한 자료가 아닙니다.' }), saved.vertices);
    await page.locator('#laMap.leaflet-container').waitFor();
    await marker(1).press('ArrowRight'); await marker(1).press('ArrowDown'); await page.locator('#laUndo').click();
    assert.equal(await page.locator('#laUndo').isEnabled(), true);
    assert.equal(await page.locator('#laRedo').isEnabled(), true);
    assert.equal(await page.locator('#laDeletePoint').isEnabled(), true);
    await page.locator('#toast').waitFor({ state: 'hidden' });
    const artifacts = process.env.DONGGU_ARTIFACT_DIR; if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
    for (const colorScheme of ['light', 'dark']) for (const width of [390, 1280]) {
      await page.emulateMedia({ colorScheme }); await page.setViewportSize({ width, height: 844 });
      await page.locator('#laCoordinateDetails').evaluate(el => { el.open = false; });
      await page.locator('[data-la="fit-area"]').click(); await page.locator('#laMap').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const bad = await page.locator('#laForm').evaluate(form => { const frame = form.getBoundingClientRect(); return [...form.querySelectorAll('#laDrawMode,#laEditMode,#laUndo,#laRedo,#laDeletePoint,#laMap')].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && (b.left < frame.left - 1 || b.right > frame.right + 1); }).map(el => el.id); });
      assert.deepEqual(bad, []);
      const hits = await page.locator('.la-vertex').evaluateAll(nodes => nodes.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
      assert.ok(hits.length >= 3); assert.ok(hits.every(hit => hit.width >= 44 && hit.height >= 44), 'Vertex touch targets are at least 44px');
      if (artifacts) {
        await page.locator('#sheet').evaluate(sheet => { sheet.scrollTop = 0; });
        await page.locator('#sheet').screenshot({ path: path.join(artifacts, 'polygon-' + width + '-' + colorScheme + '-entry.png') });
        await page.locator('#laMap').evaluate(map => { const sheet = document.querySelector('#sheet'), header = sheet.querySelector('.sheet-head'); sheet.scrollTop += map.getBoundingClientRect().top - sheet.getBoundingClientRect().top - (header?.getBoundingClientRect().height || 0) - 8; });
        await page.locator('#sheet').screenshot({ path: path.join(artifacts, 'polygon-' + width + '-' + colorScheme + '-edit.png') });
      }
      await coordinates(); await page.locator('#laVertices').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    record('390px and 1280px light/dark layouts keep tools inside the card and touch handles reachable');

    assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
    console.log(JSON.stringify({ results, browserErrors: errors, mutations }, null, 2)); await context.close();
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
