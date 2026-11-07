/* Local-only inventory metadata, conflict recovery and complete-demand forecast. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/firebase-config.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG=null;'); }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function poll(page, fn, arg, message) {
  const end = Date.now() + 30000;
  do { if (await page.evaluate(fn, arg)) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < end);
  throw new Error('Timed out: ' + message);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/css' }));
  const page = await context.newPage(), errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const ready = async () => { await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local'); await page.evaluate(() => DGIntegration.whenReady()); };
    await page.goto(origin); await ready();
    await page.evaluate(async () => {
      S.demoRole = 'admin';
      const light = S.lights.find(l => !l.removed), at = Date.now();
      await db.doc('inventory/led').set({ name: 'LED', unit: '개', quantity: 10, unitCost: 5000, revision: 1, updatedAt: at, updatedBy: 'local' });
      for (const id of ['one', 'two']) await db.doc('workOrders/' + id).set(DGOperationsCore.createOrder({ title: id, assignedTo: 'local', parts: [{ inventoryId: 'led', name: 'LED', qty: 6, unitCost: 5000 }] }, light, 'local', at));
      await DGOperations.load(true); DGOperations.state.orders = DGOperations.state.orders.slice(0, 1);
      S.tab = 'admin'; render(); openAdminSection('inventory');
    });
    await page.waitForFunction(() => DGManagement.state.inventoryForecast && !DGManagement.state.inventoryForecastLoading);
    const forecast = await page.evaluate(() => DGManagement.state.inventoryForecast.rows.find(row => row.id === 'led'));
    assert.equal(forecast.planned, 12); assert.equal(forecast.shortage, 2); assert.equal(forecast.available, -2);
    assert.equal(await page.evaluate(() => DGOperations.state.orders.length), 1);
    results.push('full saved demand 12 vs current stock 10 shows shortage 2 even while the work list contains only one order');

    await page.locator('[data-mgmt="inventory-open"][data-id="led"]').last().click();
    await page.locator('#dgEditItemName').fill('LED 모듈'); await page.locator('#dgEditItemCost').fill('6200'); await page.locator('#dgEditItemReason').fill('품목명과 기준 단가 정정');
    await page.locator('[data-mgmt="inventory-update"]').click();
    await poll(page, async () => (await db.doc('inventory/led').get()).data().name === 'LED 모듈', null, 'metadata update');
    await page.waitForFunction(() => document.querySelector('#sheet h3')?.textContent === 'LED 모듈');
    const data = await page.evaluate(async () => ({ item: (await db.doc('inventory/led').get()).data(), work: (await db.doc('workOrders/one').get()).data(), moves: (await db.collection('inventoryMoves').get()).docs.map(d => d.data()), draft: await DGOffline.get('inventoryDraft', 'led') }));
    assert.equal(data.item.quantity, 10); assert.equal(data.item.unit, '개'); assert.equal(data.item.unitCost, 6200);
    assert.equal(data.moves.length, 1); assert.equal(data.moves[0].delta, 0); assert.match(data.moves[0].reason, /품목명과 기준 단가 정정/);
    assert.equal(data.work.parts[0].unitCost, 5000); assert.equal(data.draft == null, true);
    results.push('metadata edit preserves item identity, unit, stock and historical work costs; creates one zero-delta history event');

    await page.locator('#dgEditItemName').fill('복구할 자재명'); await page.locator('#dgEditItemReason').fill('새로고침 후에도 유지할 정정');
    await poll(page, async () => (await DGOffline.get('inventoryDraft', 'led'))?.name === '복구할 자재명', null, 'saved edit draft');
    await page.reload(); await ready();
    await page.evaluate(async () => { S.demoRole = 'admin'; await DGOperations.load(true); S.tab = 'admin'; render(); openAdminSection('inventory'); });
    await page.locator('[data-mgmt="inventory-open"][data-id="led"]').last().click();
    assert.equal(await page.locator('#dgEditItemName').inputValue(), '복구할 자재명');
    assert.equal(await page.locator('#dgEditItemReason').inputValue(), '새로고침 후에도 유지할 정정');
    results.push('inventory edit draft survives a full reload');

    await page.evaluate(async () => { const old = (await db.doc('inventory/led').get()).data(); await db.doc('inventory/led').update({ name: '다른 직원의 수정', revision: old.revision + 1, updatedAt: Date.now() }); });
    await page.locator('[data-mgmt="inventory-update"]').click();
    await page.locator('[data-mgmt="inventory-edit-refresh"]').waitFor();
    assert.equal(await page.locator('#dgEditItemName').inputValue(), '복구할 자재명');
    assert.equal(await page.locator('#dgEditItemName').isDisabled(), true);
    await page.locator('[data-mgmt="inventory-edit-refresh"]').click();
    await page.waitForFunction(() => document.querySelector('#dgEditItemName') && !document.querySelector('#dgEditItemName').disabled);
    assert.equal(await page.locator('#dgEditItemName').inputValue(), '복구할 자재명');
    assert.match(await page.locator('#sheetIn').innerText(), /다른 직원의 수정/);
    await page.locator('[data-mgmt="inventory-update"]').click();
    await poll(page, async () => (await db.doc('inventory/led').get()).data().name === '복구할 자재명', null, 'recovered update');
    const recovered = await page.evaluate(async () => ({ item: (await db.doc('inventory/led').get()).data(), jobs: (await DGOffline.jobs()).filter(j => j.kind === 'work' && (j.payload?.kind === 'inventory-update' || j.summary?.startsWith('자재 기본정보 수정'))) }));
    assert.equal(recovered.item.quantity, 10); assert.equal(recovered.item.revision, 4); assert.equal(recovered.jobs.some(j => j.state === 'conflict'), false);
    results.push('concurrent edit is rejected without losing input; explicit comparison rebases and resaves against the current revision');

    await page.waitForFunction(() => document.querySelector('#sheet h3')?.textContent === '복구할 자재명');
    await page.locator('#dgEditItemName').fill('다시 되돌릴 이름'); await page.locator('#dgEditItemReason').fill('되돌리기 확인');
    await poll(page, async () => !!await DGOffline.get('inventoryDraft', 'led'), null, 'temporary draft');
    await page.locator('#dgEditItemName').fill('복구할 자재명'); await page.locator('#dgEditItemReason').fill('');
    await poll(page, async () => !await DGOffline.get('inventoryDraft', 'led'), null, 'clean reverted draft removal');
    await page.locator('#dgEditItemName').fill('버릴 초안'); await page.locator('#dgEditItemReason').fill('아직 저장하지 않은 변경');
    await poll(page, async () => !!await DGOffline.get('inventoryDraft', 'led'), null, 'discardable draft');
    await page.locator('[data-mgmt="inventory-edit-discard"]').click();
    await page.locator('#dgDialog:not([hidden]) [data-dgdlg="ok"]').click();
    await poll(page, async () => !await DGOffline.get('inventoryDraft', 'led'), null, 'editor draft discard');
    await page.waitForFunction(() => document.querySelector('#dgEditItemName')?.value === '복구할 자재명');
    results.push('reverting to saved values clears the unsaved draft; explicit editor discard leaves stock and history unchanged');

    await page.locator('#dgEditItemName').fill('대기함에서 복구할 이름'); await page.locator('#dgEditItemReason').fill('대기함 복구 확인');
    await poll(page, async () => (await DGOffline.get('inventoryDraft', 'led'))?.name === '대기함에서 복구할 이름', null, 'outbox draft');
    await page.evaluate(async () => { await DGOperations.refreshQueue(); openAdminSection('outbox'); });
    await page.locator('[data-dg="recover-draft"][data-kind="inventoryDraft"][data-id="led"]').click();
    await page.locator('#dgEditItemName').waitFor();
    assert.equal(await page.locator('#dgEditItemName').inputValue(), '대기함에서 복구할 이름');
    await page.evaluate(async () => { await DGOperations.refreshQueue(); openAdminSection('outbox'); });
    await page.locator('[data-dg="discard-draft"][data-kind="inventoryDraft"][data-id="led"]').click();
    await page.locator('#dgDialog:not([hidden]) [data-dgdlg="ok"]').click();
    await poll(page, async () => !await DGOffline.get('inventoryDraft', 'led'), null, 'outbox draft discard');
    const unchanged = await page.evaluate(async () => ({ item: (await db.doc('inventory/led').get()).data(), moves: (await db.collection('inventoryMoves').get()).docs.length }));
    assert.equal(unchanged.item.name, '복구할 자재명'); assert.equal(unchanged.item.quantity, 10); assert.equal(unchanged.moves, 2);
    results.push('outbox inventory draft resume and one-confirmation discard work without a metadata command or stock/history changes');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } catch (error) {
    console.error(await page.evaluate(async () => ({ toast: document.querySelector('#toast')?.textContent, html: document.querySelector('#sheetIn')?.innerText.slice(-1800), jobs: DGOffline.ready ? (await DGOffline.jobs()).map(j => ({ state: j.state, error: j.error })) : [] })).catch(() => ({})));
    throw error;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
