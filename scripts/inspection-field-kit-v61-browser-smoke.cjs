/* Real local browser: explicit inspection evidence, retained drafts and prepared offline reads. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.endsWith('/firebase-config.js')) return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('window.FIREBASE_CONFIG=null;');
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
async function poll(page, fn, arg) { const end = Date.now() + 30000; while (!await page.evaluate(fn, arg)) { if (Date.now() > end) throw new Error('Timed out waiting for browser state: ' + String(fn)); await page.waitForTimeout(50); } }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('dg-device', 'phone'));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  const page = await context.newPage(), errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin); await poll(page, () => S.live && S.me === 'local' && DGOffline.ready && DGIntegration.initialized);
    const id = await page.evaluate(async () => { S.demoRole = 'admin'; S.tab = 'inspect'; render(); const light = S.lights.find(l => !l.removed && !l.posApprox); await db.doc('lights/' + light.id).set({ status: '고장', statusAt: 1000, lastInspected: 1000, lastResult: '고장', redoNote: '전선 재점검', updatedAt: 1000 }); return light.id; });
    await page.evaluate(id => openLight(id), id); await page.locator('#iMemo').waitFor();
    await page.locator('#allOk').click(); await page.locator('[data-ck="leak"][data-v="uninspected"]').click();
    await page.locator('[data-inspection-reason="leak"]').fill('장비 미지참으로 측정 못함');
    await page.locator('#iInsulation').fill('0.7'); await page.locator('#iMemo').fill('일부 확인만 진행');
    await page.locator('[data-res="정상"]').click();
    await poll(page, async id => !!(await DGOffline.get('draft', id))?.readings?.some(row => row.value === 0.7), id);
    await page.reload(); await poll(page, () => S.live && DGOffline.ready && DGIntegration.initialized); await page.evaluate(id => openLight(id), id);
    assert.equal(await page.locator('#iInsulation').inputValue(), '0.7'); assert.equal(await page.locator('[data-inspection-reason="leak"]').inputValue(), '장비 미지참으로 측정 못함');
    await page.locator('#saveInsp').click();
    await poll(page, async id => (await db.readAll('inspections', { where: [['lightId', '==', id]] })).some(row => row.inspectionComplete === false), id);
    const partial = await page.evaluate(async id => ({ light: (await db.doc('lights/' + id).get()).data(), inspection: (await db.readAll('inspections', { where: [['lightId', '==', id]] })).find(row => row.inspectionComplete === false) }), id);
    assert.equal(partial.light.status, '고장'); assert.equal(partial.light.lastInspected, 1000); assert.equal(partial.light.redoNote, '전선 재점검');
    assert.equal(partial.inspection.result, '점검필요'); assert.equal(partial.inspection.readings[0].unit, 'MΩ'); assert.equal(partial.inspection.checks.leak, 'uninspected');
    const receipt = await page.evaluate(async inspection => (await db.doc('inspectionDetails/' + inspection.id).get()).data(), partial.inspection);
    assert.equal(receipt.inspectionId, partial.inspection.id); assert.deepEqual(receipt.readings, partial.inspection.readings); assert.deepEqual(receipt.checks, partial.inspection.checks); assert.equal(Object.keys(receipt).length, 10);
    const measurements = await page.evaluate(async inspection => (await db.doc('inspectionMeasurements/' + inspection.id).get()).data(), partial.inspection);
    assert.deepEqual(measurements, { schemaVersion: 1, inspectionId: partial.inspection.id, lightId: id, date: partial.inspection.date, inspector: partial.inspection.inspector, readings: partial.inspection.readings });
    results.push('not-inspected reasons and typed readings survive reload; partial inspection preserves fault/reinspection/formal date and stores the matching immutable receipt');
    await poll(page, () => !document.querySelector('#sheet').classList.contains('open'));
    await page.evaluate(id => openLight(id), id); await page.locator('#allOk').click(); await page.locator('#iMemo').fill('전체 확인 완료'); await page.locator('#saveInsp').click();
    await poll(page, async id => (await db.doc('lights/' + id).get()).data()?.status === '정상', id);
    assert.equal(await page.evaluate(async id => (await db.doc('lights/' + id).get()).data().redoNote, id), null);
    const emptyMeasurement = await page.evaluate(async id => { const inspection = (await db.readAll('inspections', { where: [['lightId', '==', id]] })).find(row => row.inspectionComplete === true); return { readingCount: inspection.readings.length, measurementExists: (await db.doc('inspectionMeasurements/' + inspection.id).get()).exists }; }, id);
    assert.deepEqual(emptyMeasurement, { readingCount: 0, measurementExists: false });
    results.push('only an explicitly completed full inspection resets formal inspection state');
    await poll(page, () => !document.querySelector('#sheet').classList.contains('open'));
    await page.evaluate(async id => {
      const light = byId(id), work = DGOperationsCore.createOrder({ title: '출동 자료 작업', assignedTo: 'local', beforePhotos: ['kit-photo'], reportIds: ['kit-report'] }, light, 'local', Date.now());
      await db.doc('workOrders/kit-work').set(work);
      await db.doc('photos/kit-photo').set({ lightId: id, workId: 'kit-work', kind: 'work', by: 'local', at: Date.now(), label: '조치 전', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' });
      await db.doc('reports/kit-report').set({ lightId: id, workId: 'kit-work', code: light.code, dong: light.dong, issue: '꺼짐', desc: '공유할 신고 내용', status: '접수', createdAt: Date.now(), contact: '010-private' });
      await db.doc('assetLinks/' + id).set({ lightId: id, cabinetId: 'kit-cabinet', circuitId: 'kit-circuit', confirmationNote: '출동 전 현장 확인' });
      await db.doc('cabinets/kit-cabinet').set({ code: 'BK1', label: '출동용 분전함' });
      await db.doc('circuits/kit-circuit').set({ cabinetId: 'kit-cabinet', code: 'CK1', label: '출동용 회로' });
      S.tab = 'admin'; render(); openAdminSection('field-kit');
    }, id);
    await page.locator('[data-fk="load"]').click(); await page.locator('[data-field-kit-work="kit-work"]').waitFor();
    await page.locator('[data-fk="prepare"]').click(); await poll(page, () => DGFieldKit.state.packet?.complete === true);
    const packet = await page.evaluate(async () => DGOffline.get('fieldKit', 'current'));
    assert.deepEqual(packet.scope.workIds, ['kit-work']); assert.ok(packet.records.photos['kit-photo']); assert.equal(packet.records.reports['kit-report'].contact, undefined);
    assert.match(await page.locator('#asecBody').innerText(), /준비 완료/); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    results.push('explicit departure package contains selected work, facilities, recent inspections and originals while omitting reporter contact');
    await page.reload(); await poll(page, () => S.live && DGOffline.ready && DGIntegration.initialized && DGFieldKit.state.packet?.complete === true);
    await context.setOffline(true);
    await page.evaluate(() => { S.reports = []; S.insp = []; const list = listAllRecords; listAllRecords = async (collection, ...args) => { if (['inspections', 'reports', 'assetLinks', 'circuits', 'cabinets'].includes(collection)) throw Object.assign(new Error('offline'), { code: 'unavailable' }); return list(collection, ...args); }; const original = db.doc.bind(db); db.doc = path => { const ref = original(path); if (/^(workOrders|photos)\//.test(path)) ref.get = async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }); }; return ref; }; });
    await page.evaluate(id => openLight(id), id);
    assert.equal(await page.locator('#preparedLight').count(), 1);
    assert.match(await page.locator('#preparedLight').innerText(), /공유할 신고 내용/); assert.match(await page.locator('#preparedLight').innerText(), /출동용 분전함/); assert.match(await page.locator('#preparedLight').innerText(), /출동용 회로/);
    assert.match(await page.locator('#histBox').innerText(), /출동 준비 자료/); assert.match(await page.locator('#histBox').innerText(), /최근 3건/); assert.match(await page.locator('#histBox').innerText(), /전체 확인 완료/);
    results.push('after a fresh restart, prepared facility inspection/report/topology views remain readable with explicit snapshot time and latest-three scope');
    await page.evaluate(() => DGOperations.openWork('kit-work')); await page.locator('#woDetail').waitFor();
    assert.match(await page.locator('#sheetIn .sheet-head h3').innerText(), /출동 자료 작업/);
    const cachedPhoto = await page.evaluate(() => getPhoto('kit-photo')); assert.equal(cachedPhoto.workId, 'kit-work');
    assert.equal(await page.evaluate(id => DGFieldKit.currentLight(id)?.id, id), id);
    results.push('offline work detail and original-photo reads fall back to the prepared account-scoped snapshot');
    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } catch (error) { console.error(await page.locator('#sheetIn').innerText().catch(() => '')); throw error; }
  finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
