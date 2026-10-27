/* Local-only end-to-end operational workflow. Uses an isolated browser profile. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
// Async predicates require Node-side polling of the value returned by page.evaluate.
async function poll(page, predicate, arg, label = 'asynchronous browser state') {
  const deadline = Date.now() + 30000;
  do {
    if (await page.evaluate(predicate, arg)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
const photo = { name: 'proof.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') };
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [], results = [];
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/css' }));
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  const ready = async () => {
    await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local');
    assert.equal(await page.evaluate(() => DGIntegration.whenReady()), true);
  };
  try {
    await page.goto(origin); await ready();
    assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null);
    const lightId = await page.evaluate(() => S.lights.find(l => !l.removed).id);
    await page.evaluate(id => openLight(id), lightId);
    await page.locator('#iMemo').fill('새로고침으로 복구할 현장 메모');
    await poll(page, async id => (await DGOffline.get('draft', id))?.memo === '새로고침으로 복구할 현장 메모', lightId, 'the inspection draft autosave');
    await page.reload(); await ready(); await page.evaluate(() => DGIntegration.whenReady());
    assert.equal(await page.evaluate(id => DRAFTS[id]?.memo, lightId), '새로고침으로 복구할 현장 메모', 'startup restored the persisted draft before opening a facility');
    await page.evaluate(id => openLight(id), lightId);
    assert.equal(await page.locator('#iMemo').inputValue(), '새로고침으로 복구할 현장 메모');
    await context.setOffline(true);
    await page.locator('#allOk').click(); await page.locator('#saveInsp').click();
    await poll(page, async id => (await db.collection('inspections').where('lightId', '==', id).get()).docs.some(d => d.data().memo === '새로고침으로 복구할 현장 메모'), lightId, 'the saved inspection record');
    await poll(page, async id => !(await DGOffline.get('draft', id)), lightId, 'the delivered inspection draft to clear');
    assert.equal(await page.evaluate(async () => (await DGOffline.jobs()).filter(j => j.kind === 'inspection' && j.state === 'synced').length), 1);
    await context.setOffline(false);
    results.push('inspection draft survived reload; local save works offline and clears only delivered draft');

    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); openAdminSection('inventory'); });
    await page.locator('[data-mgmt="inventory-new"]').click();
    await page.locator('#dgItemName').fill('검증용 LED 모듈'); await page.locator('#dgItemQty').fill('20'); await page.locator('#dgItemCost').fill('5000');
    await page.locator('[data-mgmt="inventory-create"]').click();
    await poll(page, async () => (await db.collection('inventory').get()).docs.length === 1, undefined, 'the new inventory item');
    const itemId = await page.evaluate(async () => (await db.collection('inventory').get()).docs[0].id);
    // saving returns one level, to the inventory list it was opened from (NAV-02); close the rest before the next flow
    await page.waitForFunction(() => S.asec === 'inventory' && !document.querySelector('#dgItemName'));
    await page.evaluate(() => closeSheet('all')); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    await page.evaluate(async id => { const l = byId(id); await db.doc('reports/smoke-report').set({ lightId: id, code: l.code, dong: l.dong, issue: '깜빡임', desc: '보수 연결 확인', contact: 'local-test-only', status: '접수', createdAt: Date.now(), reporterId: 'local' }); await DGOperations.load(true); }, lightId);
    await page.evaluate(id => DGOperations.newWork(id), lightId);
    await page.locator('#woTitle').fill('검증용 등기구 보수'); await page.locator('#woAssignee').selectOption('local');
    await page.locator('#woDescription').fill('등기구 교체와 야간 점등 확인');
    await page.locator('[data-work-report="smoke-report"]').check();
    await page.locator('#woBefore').setInputFiles(photo); await page.waitForFunction(() => DGOperations.state.draft.photos.length === 1);
    await page.locator('[data-dg="create-work"]').click();
    await poll(page, async () => (await db.collection('workOrders').get()).docs.length === 1, undefined, 'the new work order');
    const workId = await page.evaluate(async () => (await db.collection('workOrders').get()).docs[0].id);
    await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    await page.evaluate(async id => { await DGOperations.load(true); await DGOperations.openWork(id); }, workId);
    await page.locator('[data-dg="transition-work"][data-status="in_progress"]').click();
    await page.locator('#woCompletionNote').waitFor();
    await page.locator('#woCompletionNote').fill('LED 모듈 교체 후 점등 정상 확인');
    await page.locator('#woAfter').setInputFiles(photo); await page.waitForFunction(() => DGOperations.state.completion.photos.length === 1);
    await page.locator('#woStockPart').selectOption(itemId); await page.locator('#woPartQty').fill('2');
    await page.locator('[data-dg="add-part"]').click();
    await page.locator('#woLux').fill('14.5'); await page.locator('#woLuxNote').fill('보도 중심 · 휴대 조도계');
    await page.locator('[data-dg="add-lux"]').click();
    await page.locator('[data-dg="transition-work"][data-status="completed"]').click();
    await page.locator('#woVerification').waitFor();
    await page.locator('#woVerification').fill('전후 사진 및 현장 측정 확인'); await page.locator('#woFacilityStatus').selectOption('정상'); await page.locator('#woCloseReports').check();
    await page.locator('[data-dg="transition-work"][data-status="verified"]').click();
    await poll(page, async id => (await db.doc('workOrders/' + id).get()).data().status === 'verified', workId, 'the verified work order');
    const snapshot = await page.evaluate(async ({ workId, itemId }) => ({ work: (await db.doc('workOrders/' + workId).get()).data(), item: (await db.doc('inventory/' + itemId).get()).data(), report: (await db.doc('reports/smoke-report').get()).data(), events: (await db.collection('workEvents').where('workId', '==', workId).get()).docs.map(d => d.data()) }), { workId, itemId });
    assert.equal(snapshot.work.afterPhotos.length, 1); assert.equal(snapshot.work.beforePhotos.length, 1); assert.equal(snapshot.work.costTotal, 10000); assert.equal(snapshot.work.measurements[0].lux, 14.5);
    assert.equal(snapshot.item.quantity, 18); assert.equal(snapshot.report.status, '완료'); assert.equal(snapshot.report.contact, ''); assert.equal(snapshot.events.length, 4);
    const retryResult = await page.evaluate(async id => { const jobs = await DGOffline.jobs(), job = jobs.find(j => j.kind === 'work' && j.summary.includes('완료 ·')); await DGOffline.retry(job.id); return (await db.doc('inventory/' + id).get()).data().quantity; }, itemId);
    assert.equal(retryResult, 18);
    results.push('work assigned → started → evidence/parts/lux → verified atomically; stock 20→18, linked report closed, retry no double charge');

    await page.evaluate(async id => { await DGOperations.load(true); await DGOperations.openWork(id); const ref = db.doc('workOrders/' + id), old = (await ref.get()).data(); await ref.update({ revision: old.revision + 1, description: '다른 직원이 갱신한 내용' }); }, workId);
    await page.locator('[data-dg="transition-work"][data-status="assigned"]').click();
    await poll(page, async () => (await DGOffline.jobs()).some(j => j.state === 'conflict'), undefined, 'a visible outbox conflict');
    assert.equal(await page.evaluate(async id => (await db.doc('workOrders/' + id).get()).data().status, workId), 'verified');
    results.push('review screen preserves its revision; concurrent work edit causes visible outbox conflict');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } catch (error) {
    const diagnostics = await page.evaluate(async () => ({ toast: document.querySelector('#toast')?.textContent, initialized: DGIntegration.initialized, draftIds: Object.keys(DRAFTS), activeMemo: draft?.memo, storedDrafts: DGOffline.ready ? (await DGOffline.list('draft')).map(d => ({ id: d.id, memo: d.value.memo })) : [], jobs: DGOffline.ready ? (await DGOffline.jobs()).map(j => ({ kind: j.kind, state: j.state, error: j.error })) : [], body: document.querySelector('#sheetIn')?.innerText.slice(-1200) })).catch(() => ({}));
    console.error(JSON.stringify(diagnostics, null, 2)); throw error;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
