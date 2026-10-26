/* Synthetic, device-only review-area workflows. External requests are never sent. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DONGGU_AREAS_ROOT || path.join(__dirname, '..'));
const latitude = 35.14, longitude = 126.93;
const lngAt = meters => longitude + meters / (111320 * Math.cos(latitude * Math.PI / 180));
const registry = { cols: ['id', 'kind', 'code', 'dong', 'lampType', 'lat', 'lng'], count: 2, rows: [
  ['area-light-a', '가로등', '구역검증 1', '지산동', 'LED일반형', latitude, lngAt(-35)],
  ['area-light-b', '가로등', '구역검증 2', '지산동', 'LED일반형', latitude, lngAt(35)]
] };
const server = http.createServer((req, res) => {
  let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { return res.writeHead(400).end(); }
  const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function poll(page, predicate, argument, label) {
  const deadline = Date.now() + 30000;
  do { if (await page.evaluate(predicate, argument)) return; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < deadline);
  console.error(await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, loaded: DGLightingAreas.state.loaded, error: DGLightingAreas.state.error, form: document.querySelector('#laForm')?.textContent, draft: DGLightingAreas.state.draft, records: DGLightingAreas.state.records.length })));
  throw new Error('Timed out: ' + label);
}
(async () => {
  const results = [], errors = []; let browser;
  const record = label => { results.push(label); console.log('PASS: ' + label); };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://localhost:' + server.address().port;
  try {
    browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.fulfill({ status: 200, body: '', contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/plain' });
      if (url.pathname === '/data/lights.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(registry) });
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    const ready = async () => { await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGOffline.ready && typeof DGLightingAreas !== 'undefined'); assert.equal(await page.evaluate(() => DGIntegration.whenReady()), true); await poll(page, () => DGLightingAreas.state.loaded, null, 'review areas loaded'); };
    await page.goto(origin); await ready();
    assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null); assert.equal(await page.evaluate(() => S.me), 'local');
    const close = async () => { if (await page.locator('#sheet.open').count()) { await page.keyboard.press('Escape'); await page.locator('#sheet.open').waitFor({ state: 'hidden' }); } };
    const section = async () => { await close(); await page.locator('[data-tab="admin"]').click(); await page.locator('[data-asec="lightingareas"]').first().click(); await page.locator('#laList').waitFor(); };
    const save = async (id, revision = 1) => { await page.locator('#laSave').click(); await poll(page, ({ id, revision }) => DGLightingAreas.state.records.find(r => r.id === id)?.revision === revision, { id, revision }, 'area commit'); await page.locator('#laForm').waitFor({ state: 'hidden' }); };
    const currentId = () => page.evaluate(() => DGLightingAreas.state.draft.recordId);

    await section(); await page.locator('[data-la="new"]').click(); await page.locator('#laForm').waitFor();
    await page.locator('#laLabel').fill('합성 산림 제외 구역');
    await page.locator('#laMap.leaflet-container').waitFor();
    await page.locator('#laMap').click({ position: { x: 130, y: 130 } });
    assert.ok(Number.isFinite(Number(await page.locator('#laLat').inputValue())), 'map click supplies center latitude');
    assert.notEqual(await page.locator('#laLat').inputValue(), '');
    await page.locator('#laLat').fill(String(latitude)); await page.locator('#laLng').fill(String(longitude)); await page.locator('#laRadius').fill('25');
    await page.locator('#laNote').fill('시험 데이터. 실제 산림·보행로를 판단한 자료가 아닙니다.');
    const circleId = await currentId(); await save(circleId);
    let row = await page.evaluate(id => DGLightingAreas.state.records.find(r => r.id === id), circleId);
    assert.equal(row.shape, 'circle'); assert.equal(row.radius, 25); assert.equal(row.reason, 'mountain'); assert.equal(row.disabled, false);
    assert.equal(await page.evaluate(point => DGLightingAreaCore.decision(DGLightingAreas.context(), point).excluded, { lat: latitude, lng: longitude }), true);
    const receipts = await page.evaluate(() => db.readAll('lightingAreaOperations'));
    assert.equal(receipts.length, 1); assert.equal(receipts[0].snapshot.label, row.label);
    assert.equal(await page.evaluate(() => S.lights.length), 2); assert.equal(await page.evaluate(() => DGLighting.state.records.length), 0);
    record('circle map selection creates a review-only exclusion with an immutable receipt');

    await close(); await page.reload(); await ready();
    assert.equal(await page.evaluate(id => DGLightingAreas.state.records.find(r => r.id === id)?.radius, circleId), 25);
    await page.evaluate(id => DGLightingAreas.openEditor(null, id), circleId); await page.locator('[data-la="toggle"]').click();
    await poll(page, id => DGLightingAreas.state.records.find(r => r.id === id)?.disabled === true, circleId, 'exclusion disabled');
    assert.equal(await page.evaluate(point => DGLightingAreaCore.decision(DGLightingAreas.context(), point).excluded, { lat: latitude, lng: longitude }), false);
    await page.locator('#laForm').waitFor({ state: 'hidden' });
    await page.locator('#laFilter').selectOption('disabled'); assert.match(await page.locator('#laList').textContent(), /합성 산림 제외 구역/);
    await page.locator('[data-la="edit"]').first().click(); await page.locator('[data-la="toggle"]').click();
    await poll(page, id => DGLightingAreas.state.records.find(r => r.id === id)?.revision === 3, circleId, 'exclusion re-enabled');
    assert.equal(await page.evaluate(point => DGLightingAreaCore.decision(DGLightingAreas.context(), point).excluded, { lat: latitude, lng: longitude }), true);
    record('saved areas survive reload and can be disabled, found, and re-enabled without deleting records');

    await page.locator('#laForm').waitFor({ state: 'hidden' }); await page.locator('[data-la="new-include"]').click();
    await page.locator('#laLabel').fill('합성 보행로 예외'); await page.locator('#laLat').fill(String(latitude)); await page.locator('#laLng').fill(String(longitude)); await page.locator('#laRadius').fill('10');
    const includeId = await currentId(); await save(includeId);
    assert.equal(await page.evaluate(point => DGLightingAreaCore.decision(DGLightingAreas.context(), point).excluded, { lat: latitude, lng: longitude }), false);
    assert.equal(await page.evaluate(point => DGLightingAreaCore.decision(DGLightingAreas.context(), point).excluded, { lat: latitude, lng: lngAt(20) }), true);
    record('a narrow public-path exception retains the included part while the surrounding mountain remains excluded');

    await page.locator('[data-la="new"]').click(); await page.locator('#laLabel').fill('합성 다각형 산림'); await page.locator('#laShape').selectOption('polygon');
    await page.locator('#laMap.leaflet-container').waitFor();
    for (const position of [{ x: 70, y: 70 }, { x: 170, y: 70 }, { x: 170, y: 170 }]) await page.locator('#laMap').click({ position });
    assert.equal((await page.locator('#laVertices').inputValue()).split('\n').length, 3);
    await page.locator('[data-la="undo-point"]').click(); assert.equal((await page.locator('#laVertices').inputValue()).split('\n').length, 2);
    const vertices = [{ lat: latitude - .0002, lng: lngAt(100) }, { lat: latitude + .0002, lng: lngAt(100) }, { lat: latitude + .0002, lng: lngAt(150) }, { lat: latitude - .0002, lng: lngAt(150) }];
    await page.locator('#laVertices').fill(vertices.map(p => p.lat + ', ' + p.lng).join('\n'));
    const polygonId = await currentId(); await save(polygonId);
    row = await page.evaluate(id => DGLightingAreas.state.records.find(r => r.id === id), polygonId);
    assert.deepEqual(row.vertices, vertices); assert.equal(row.radius, 0);
    assert.equal(await page.evaluate(point => DGLightingAreaCore.decision(DGLightingAreas.context(), point).excluded, { lat: latitude, lng: lngAt(125) }), true);
    await page.locator('#laFilter').selectOption('active'); await page.locator('#laSearch').fill('다각형'); assert.equal(await page.locator('#laList article').count(), 1);
    record('polygon map points, undo, coordinate editing, and list search preserve the chosen boundary');

    await page.evaluate(point => DGLightingAreas.openEditor({ label: '같은 구역 재열기 검증', ...point }), { lat: latitude + .006, lng: longitude });
    const immediateId = await currentId();
    await page.evaluate(() => {
      window.__areaAcknowledgement = { committed: false, resolve: null };
      DGOffline.register('lighting-area', async job => {
        const result = await DGLightingAreaCommands.execute(job, { db, fb: FB && FB.fs, user: S.me, admin: can('admin') });
        if (!__areaAcknowledgement.committed) { __areaAcknowledgement.committed = true; await new Promise(resolve => { __areaAcknowledgement.resolve = resolve; }); }
        return result;
      });
    });
    await page.locator('#laSave').click(); await poll(page, () => __areaAcknowledgement.committed, null, 'area committed before acknowledgement');
    const immediateOperation = await page.evaluate(() => DGLightingAreas.state.draft.pending);
    await page.evaluate(id => DGLightingAreas.openEditor(null, id), immediateId);
    assert.equal(await page.evaluate(() => DGLightingAreas.state.draft.pending), null, 'receipt-confirmed area opens at the committed revision');
    await page.locator('#laNote').fill('재열기 뒤 작성한 범위 설명');
    await page.evaluate(() => { __areaAcknowledgement.resolve(); DGOffline.register('lighting-area', job => DGLightingAreaCommands.execute(job, { db, fb: FB && FB.fs, user: S.me, admin: can('admin') })); });
    await poll(page, async id => (await DGOffline.jobs()).find(j => j.id === id)?.state === 'synced', immediateOperation, 'area acknowledgement released');
    assert.equal(await page.locator('#laNote').inputValue(), '재열기 뒤 작성한 범위 설명');
    assert.equal(await currentId(), immediateId); await save(immediateId, 2);
    record('reopening a committed area before its acknowledgement preserves a new editable draft at the latest revision');

    await page.evaluate(point => DGLightingAreas.openEditor({ label: '전송 전 다시 연 구역', ...point }), { lat: latitude + .007, lng: longitude });
    const resumedId = await currentId();
    await page.evaluate(() => {
      window.__areaBeforeCommit = { started: false, resolve: null };
      DGOffline.register('lighting-area', async job => {
        if (!__areaBeforeCommit.started) { __areaBeforeCommit.started = true; await new Promise(resolve => { __areaBeforeCommit.resolve = resolve; }); }
        return DGLightingAreaCommands.execute(job, { db, fb: FB && FB.fs, user: S.me, admin: can('admin') });
      });
    });
    await page.locator('#laSave').click(); await poll(page, () => __areaBeforeCommit.started, null, 'area write held before commit');
    await page.evaluate(id => DGLightingAreas.openEditor(null, id, true), resumedId);
    assert.notEqual(await page.evaluate(() => DGLightingAreas.state.draft.pending), null);
    await page.evaluate(() => { __areaBeforeCommit.resolve(); DGOffline.register('lighting-area', job => DGLightingAreaCommands.execute(job, { db, fb: FB && FB.fs, user: S.me, admin: can('admin') })); });
    await poll(page, id => DGLightingAreas.state.draft?.recordId === id && !DGLightingAreas.state.draft.pending && document.querySelector('#laForm fieldset')?.disabled === false, resumedId, 'reopened pending area unlocked');
    assert.equal(await page.locator('#laLabel').inputValue(), '전송 전 다시 연 구역');
    await page.locator('[data-la="discard"]').click(); await page.locator('#laForm').waitFor({ state: 'hidden' });
    record('an area resumed before commit refreshes its current view after delivery without closing it');

    await page.evaluate(async () => { window.__areaDraftPut = DGOffline.putIfCurrent; DGOffline.putIfCurrent = async (...args) => { if (args[0] === 'lightingAreaDraft') throw Object.assign(new Error('synthetic quota exhausted'), { code: 'quota-exceeded' }); return __areaDraftPut(...args); }; });
    await page.locator('[data-la="new"]').click(); await page.locator('#laForm').waitFor(); await page.locator('#laLabel').fill('보관 실패 입력 유지');
    await poll(page, () => document.querySelector('#laSaveState').textContent.includes('synthetic quota'), null, 'visible draft storage failure');
    assert.equal(await page.locator('#laLabel').inputValue(), '보관 실패 입력 유지');
    await page.evaluate(() => { DGOffline.putIfCurrent = __areaDraftPut; });
    await page.locator('#laLat').fill(String(latitude + .001)); await page.locator('#laLng').fill(String(longitude));
    const recoveredId = await currentId(); await save(recoveredId);
    assert.equal(await page.evaluate(id => DGLightingAreas.state.records.some(r => r.id === id), recoveredId), true);
    record('a failed durable draft write leaves the entered area visible and can recover after storage returns');

    const gateSubmit = async () => page.evaluate(() => {
      window.__areaGate = { started: false, resolve: null }; window.__areaSubmit = DGOffline.submit;
      DGOffline.submit = async (...args) => { if (args[0] === 'lighting-area' && !__areaGate.started) { __areaGate.started = true; await new Promise(resolve => { __areaGate.resolve = resolve; }); } return __areaSubmit(...args); };
    });
    await page.evaluate(point => DGLightingAreas.openEditor({ label: '응답이 늦은 제외 구역', ...point }), { lat: latitude + .002, lng: longitude });
    const olderId = await currentId(); await gateSubmit(); await page.locator('#laSave').click(); await poll(page, () => __areaGate.started, null, 'older save held');
    await page.evaluate(point => DGLightingAreas.openEditor({ label: '새 구역 입력을 유지', ...point }), { lat: latitude + .003, lng: longitude });
    const newerId = await currentId(); assert.notEqual(newerId, olderId);
    await page.evaluate(() => { __areaGate.resolve(); DGOffline.submit = __areaSubmit; });
    await poll(page, async id => DGLightingAreas.state.records.some(r => r.id === id) && !(await DGOffline.get('lightingAreaDraft', id)), olderId, 'older commit and draft cleanup');
    assert.equal(await page.locator('#laLabel').inputValue(), '새 구역 입력을 유지'); assert.equal(await currentId(), newerId);
    assert.equal(await page.evaluate(async id => !!await DGOffline.get('lightingAreaDraft', id), newerId), true);
    record('a delayed older save cannot replace a newer editor or remove its draft');

    await gateSubmit(); await page.locator('#laSave').click(); await poll(page, () => __areaGate.started, null, 'second save held');
    await close(); await page.evaluate(() => { __areaGate.resolve(); DGOffline.submit = __areaSubmit; });
    await poll(page, async id => DGLightingAreas.state.records.some(r => r.id === id) && !(await DGOffline.get('lightingAreaDraft', id)), newerId, 'closed editor commit');
    assert.equal(await page.locator('#sheet.open').count(), 0);
    record('a completed request does not reopen an editor that the user already closed');

    await page.evaluate(point => DGLightingAreas.openEditor({ label: '다른 탭 충돌', ...point }), { lat: latitude + .004, lng: longitude });
    const conflictId = await currentId(); await page.evaluate(async id => { await DGLightingAreas.persistActive(); const old = await DGOffline.get('lightingAreaDraft', id); old.data.note = '다른 탭의 최신 기록'; await DGOffline.putIfCurrent('lightingAreaDraft', id, old, old.draftRevision); }, conflictId);
    await page.locator('#laNote').fill('현재 탭에서 작성한 내용');
    await page.locator('#laDraftConflict').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(async id => (await DGOffline.get('lightingAreaDraft', id)).data.note, conflictId), '다른 탭의 최신 기록');
    await page.locator('[data-la="copy-draft"]').click();
    await poll(page, oldId => DGLightingAreas.state.draft.recordId !== oldId, conflictId, 'conflicted draft copied');
    assert.equal(await page.locator('#laNote').inputValue(), '현재 탭에서 작성한 내용');
    assert.equal(await page.evaluate(async id => (await DGOffline.get('lightingAreaDraft', id)).data.note, conflictId), '다른 탭의 최신 기록');
    record('draft revision conflicts preserve both tabs and allow an explicit copy into a new area');

    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2)); await context.close();
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
