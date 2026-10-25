/* Isolated local UI regression: no production requests or real field observations. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DONGGU_WORKFLOWS_ROOT || path.join(__dirname, '..'));
const latitude = 35.14, longitude = 126.93, lngAt = m => longitude + m / (111320 * Math.cos(latitude * Math.PI / 180));
const registry = { cols: ['id', 'kind', 'code', 'dong', 'lampType', 'lat', 'lng'], count: 2, rows: [
  ['workflow-light-a', '가로등', '검증로 1', '지산동', 'LED일반형', latitude, lngAt(-35)],
  ['workflow-light-b', '가로등', '검증로 2', '지산동', 'LED일반형', latitude, lngAt(35)]
] };
async function poll(page, predicate, arg, label) {
  const until = Date.now() + 30000;
  while (Date.now() < until) { if (await page.evaluate(predicate, arg)) return; await new Promise(r => setTimeout(r, 30)); }
  console.error(await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, review: S.review && { historyState: S.review.historyState, historyError: S.review.historyError }, import: { name: DGLightingWorkflows.state.import.name, progress: DGLightingWorkflows.state.import.progress, agency: DGLightingWorkflows.state.import.agency, dataset: DGLightingWorkflows.state.import.dataset, mapping: DGLightingWorkflows.state.import.mapping, busy: DGLightingWorkflows.state.import.busy, preview: DGLightingWorkflows.state.import.preview?.counts } })));
  throw new Error('Timed out: ' + label);
}
const server = http.createServer((req, res) => {
  let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { return res.writeHead(400).end(); }
  const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  const results = [], errors = []; let browser;
  const record = label => { results.push(label); console.log('PASS: ' + label); };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://localhost:' + server.address().port;
  try {
    browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC', serviceWorkers: 'block' });
    await context.route('**/*', route => { const u = new URL(route.request().url()); if (u.origin !== origin) return route.fulfill({ status: 200, body: '', contentType: u.pathname.endsWith('.js') ? 'text/javascript' : 'text/plain' }); if (u.pathname === '/data/lights.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(registry) }); return route.continue(); });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', dialog => dialog.accept());
    await page.goto(origin); await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGOffline.ready && typeof DGLightingWorkflows !== 'undefined');
    assert.equal(await page.evaluate(() => DGIntegration.whenReady()), true); assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null); assert.equal(await page.evaluate(() => S.me), 'local');
    await poll(page, () => DGLighting.state.loaded, null, 'lighting records ready');
    await page.evaluate(() => { window.__workflowDownloads = []; dl = { save: async options => window.__workflowDownloads.push(options) }; });
    const close = async () => { if (await page.locator('#sheet.open').count()) { await page.keyboard.press('Escape'); await page.locator('#sheet.open').waitFor({ state: 'hidden' }); } };
    const section = async key => { await close(); await page.locator('[data-tab="admin"]').click(); await page.locator('[data-asec="' + key + '"]').first().click(); };
    const minute = await page.evaluate(() => DGLightingModel.minuteOfKst(Date.now())), time = String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
    const review = async () => { await section('light'); await page.locator('[data-rvmode="pairs"]').click(); await page.locator('#rvTime').fill(time); await page.locator('#rvRun').click(); await poll(page, () => S.review?.historyState === 'synced', null, 'complete review archive'); };

    await review();
    assert.equal(await page.evaluate(() => S.review.cands.length), 1);
    const firstRun = await page.evaluate(() => db.readAll('lightingRuns'));
    assert.equal(firstRun.length, 1); assert.equal(firstRun[0].candidateCount, 1); assert.equal(JSON.parse(firstRun[0].candidatesJson).length, 1);
    await page.locator('[data-lw="candidate-task"]').first().click(); await page.locator('#lwTaskForm').waitFor();
    const taskId = await page.evaluate(() => DGLightingWorkflows.state.draft.recordId);
    await page.locator('#lwTitle').fill('현장 검증 재확인 업무'); await page.locator('#lwMinute').fill(time); await page.locator('#lwTaskForm button[type="submit"]').click();
    await poll(page, async id => (await db.doc('lightingTasks/' + id).get()).exists, taskId, 'task create');
    await page.evaluate(id => DGLightingWorkflows.openTask(null, id), taskId);
    await page.locator('[data-lw="task-observe"]').click(); await page.locator('#lcForm').waitFor();
    const observationId = await page.evaluate(() => DGLighting.state.draft.recordId);
    assert.equal(await page.evaluate(() => DGLighting.state.draft.data.originId), taskId);
    assert.equal(await page.locator('#lcNight').isChecked(), false, 'task link must not invent night confirmation');
    await page.locator('#lcLevel').selectOption('dark'); await page.locator('#lcNight').check(); await page.locator('#lcSave').click();
    await poll(page, id => DGLighting.state.records.some(r => r.id === id), observationId, 'linked observation commit');
    await page.evaluate(id => DGLightingWorkflows.openTask(null, id), taskId);
    await page.locator('#lwObservation').selectOption(observationId); await page.locator('#lwCompletion').fill('합성 현장 관찰 확인. 실제 운영 데이터가 아닙니다.'); await page.locator('[data-lw="task-complete"]').click();
    await poll(page, async id => (await db.doc('lightingTasks/' + id).get()).data()?.status === 'completed', taskId, 'task completion');
    assert.equal(await page.evaluate(async id => (await db.doc('lightingTasks/' + id).get()).data().observationId, taskId), observationId);
    record('candidate → assigned follow-up → observation → completion with preserved source link');

    const csv = 'id,name,lat,lng,updated_at\nexternal-a,타기관 정문,35.14,126.93,2026-01-01\nexternal-b,타기관 후문,35.141,126.931,2026-01-01\nexternal-a,파일 중복,35.14,126.93,2026-01-01\ninvalid,좌표 누락,,126.93,2026-01-01';
    const uploadCSV = async () => { await section('lightingimport'); await page.locator('#lwImportFile').setInputFiles({ name: 'agency.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }); await poll(page, () => !!DGLightingWorkflows.state.import.parsed, null, 'CSV parsed'); await page.locator('#lwImportAgency').fill('합성 검증기관'); await page.locator('#lwImportDataset').fill('검증 대장 2026'); await page.locator('[data-lw="import-preview"]').click(); await poll(page, () => !!DGLightingWorkflows.state.import.preview && !DGLightingWorkflows.state.import.busy, null, 'import preview'); };
    await uploadCSV();
    assert.deepEqual(await page.evaluate(() => DGLightingWorkflows.state.import.preview.counts), { new: 2, protected: 0, duplicate: 1, invalid: 1 });
    await page.locator('[data-lw="import-apply"]').click(); await poll(page, () => !DGLightingWorkflows.state.import.busy && DGLightingWorkflows.state.import.preview.rows.filter(r => r.result === '저장 완료').length === 2, null, 'new records imported');
    const imported = await page.evaluate(() => DGLighting.state.records.filter(r => r.sourceAgency === '합성 검증기관'));
    assert.equal(imported.length, 2); assert.ok(imported.every(r => !r.nightConfirmed && r.status === 'unknown' && r.schedule === 'unknown'));
    await page.evaluate(id => DGLighting.openEditor(null, null, id), imported[0].id); await page.locator('#lcNote').fill('현장에서 별도로 수정한 근거'); await page.locator('#lcSave').click();
    await poll(page, id => DGLighting.state.records.find(r => r.id === id)?.note === '현장에서 별도로 수정한 근거', imported[0].id, 'field edit');
    await uploadCSV();
    assert.deepEqual(await page.evaluate(() => DGLightingWorkflows.state.import.preview.counts), { new: 0, protected: 2, duplicate: 1, invalid: 1 });
    assert.equal(await page.locator('[data-lw="import-apply"]').isDisabled(), true);
    assert.equal(await page.evaluate(id => DGLighting.state.records.find(r => r.id === id).note, imported[0].id), '현장에서 별도로 수정한 근거');
    await page.locator('[data-lw="import-csv"]').click();
    assert.equal(await page.evaluate(() => __workflowDownloads.at(-1).data.split('\r\n').length), 5);
    record('CSV preview distinguishes duplicate/invalid rows and preserves previously edited agency records');

    const geo = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [126.932, 35.142] }, properties: { id: 'external-c', name: 'GeoJSON 조명' } }, { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { id: 'not-a-point' } }] };
    await page.locator('#lwImportFile').setInputFiles({ name: 'agency.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(geo)) });
    await poll(page, () => DGLightingWorkflows.state.import.name === 'agency.geojson' && !!DGLightingWorkflows.state.import.parsed, null, 'GeoJSON parsed');
    await page.locator('[data-lw="import-preview"]').click(); await poll(page, () => !!DGLightingWorkflows.state.import.preview && !DGLightingWorkflows.state.import.busy, null, 'GeoJSON preview');
    assert.deepEqual(await page.evaluate(() => DGLightingWorkflows.state.import.preview.counts), { new: 1, protected: 0, duplicate: 0, invalid: 1 });
    await page.locator('[data-lw="import-apply"]').click(); await poll(page, () => !DGLightingWorkflows.state.import.busy && DGLighting.state.records.some(r => r.sourceRecordId === 'external-c'), null, 'GeoJSON commit');
    const geoRecord = await page.evaluate(() => DGLighting.state.records.find(r => r.sourceRecordId === 'external-c'));
    assert.equal(geoRecord.lat, 35.142); assert.equal(geoRecord.lng, 126.932);
    record('GeoJSON Point coordinates map correctly and invalid geometry remains an explicit rejected row');

    await review(); await section('lightinghistory'); await poll(page, () => DGLightingWorkflows.state.runsLoaded, null, 'full archive history');
    const runs = await page.evaluate(() => DGLightingWorkflows.state.runs);
    assert.equal(runs.length, 2); assert.notEqual(runs[0].inputDigest, runs[1].inputDigest);
    assert.equal(runs[0].contextCount, 4); assert.equal(JSON.parse(runs[0].evaluationJson).counts.compared, 1);
    await page.locator('[data-lw="history-export"]').click(); await poll(page, () => __workflowDownloads.some(d => d.filename === '동구_밝기검토_전체.json'), null, 'full archive export');
    const exported = await page.evaluate(() => JSON.parse(__workflowDownloads.find(d => d.filename === '동구_밝기검토_전체.json').data));
    assert.equal(exported.count, 2); assert.equal(exported.runs.length, 2); assert.ok(exported.runs.every(r => JSON.parse(r.candidatesJson).length === r.candidateCount));
    await page.locator('[data-lw="run-evaluation-csv"]').first().click();
    assert.equal(await page.evaluate(() => __workflowDownloads.at(-1).data.split('\r\n').length), 2);
    record('immutable history contains every candidate/version and exports all runs and evaluated observations');

    await page.evaluate(async () => { const current = S.review; const large = { ...current, cands: Array.from({ length: 2000 }, () => current.cands[0]), historyState: '', historyJob: null, historyError: '' }; S.review = large; await DGLightingWorkflows.captureReview(large); });
    assert.equal(await page.evaluate(() => S.review.historyState), 'failed'); assert.match(await page.evaluate(() => S.review.historyError), /최대|600KB/);
    assert.equal(await page.evaluate(async () => (await db.readAll('lightingRuns')).length), 2);
    record('oversized review is explicitly rejected without storing a truncated archive');

    await close();
    await page.evaluate(() => { window.__taskGate = {}; __taskGate.promise = new Promise(resolve => { __taskGate.resolve = resolve; }); DGOffline.register('lighting-workflow', async job => { if (job.entity === 'task') { __taskGate.started = true; await __taskGate.promise; } return DGLightingWorkflowCommands.execute(job, { db, user: S.me, admin: can('admin') }); }); });
    await page.evaluate(() => DGLightingWorkflows.openTask({ title: '먼저 전송할 업무', lat: 35.14, lng: 126.93 }));
    const older = await page.evaluate(() => DGLightingWorkflows.state.draft.recordId);
    await page.locator('#lwTaskForm button[type="submit"]').click(); await poll(page, () => __taskGate.started, null, 'task save held');
    await page.evaluate(() => DGLightingWorkflows.openTask({ title: '다음 지점 업무', lat: 35.15, lng: 126.94 }));
    const newer = await page.evaluate(() => DGLightingWorkflows.state.draft.recordId);
    assert.notEqual(older, newer); await page.evaluate(() => __taskGate.resolve());
    await poll(page, async id => await DGOffline.get('lightingTaskDraft', id) === null, older, 'older draft completion');
    assert.equal(await page.locator('#lwTitle').inputValue(), '다음 지점 업무'); assert.equal(await page.evaluate(() => DGLightingWorkflows.state.draft.recordId), newer);
    assert.equal(await page.evaluate(async id => !!await DGOffline.get('lightingTaskDraft', id), newer), true);
    record('a delayed task save preserves the later editor and its durable draft');

    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2)); await context.close();
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
