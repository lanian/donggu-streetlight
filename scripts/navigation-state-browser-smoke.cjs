/* NAV-03/04: screens come back with their view state; forms keep unsaved input (device draft when durable, a question
   before leaving when not). Real History, DOM and local storage; camera/GPS/Firebase are not involved. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(pixel => { window.PIXEL = pixel; }, PIXEL);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const results = [], errors = [];
  const sheetOpen = page => page.evaluate(() => document.querySelector('#sheet').classList.contains('open'));
  const ready = page => page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
  const poll = async (page, fn, label) => { for (let i = 0; i < 100; i++) { if (await page.evaluate(fn)) return; await page.waitForTimeout(100); } throw new Error('timed out waiting for ' + label); };
  async function scenario(name, run) {
    const page = await context.newPage();
    const dialogs = []; page.dialogs = dialogs; page.answer = true;
    page.on('pageerror', e => errors.push(name + ': ' + e.message)); page.on('dialog', dialog => { dialogs.push(dialog.message()); page.answer ? dialog.accept() : dialog.dismiss(); });
    try {
      await page.goto(origin); await ready(page);
      await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); });
      await run(page); results.push(name);
    } finally { await page.close(); }
  }
  try {
    await scenario('registration form keeps typed fields and the photo preview across a scanner round trip', async page => {
      await page.evaluate(() => openAdminSection('reg')); await page.locator('#nAddr').waitFor();
      await page.locator('#nNum').fill('642'); await page.locator('#nAddr').fill('탐색 검증 위치'); await page.locator('#nNote').fill('초안 보존 확인');
      await page.locator('#nNoPlate').check();
      await page.evaluate(() => { window.__nPhoto = PIXEL; const p = document.querySelector('#nPrev'); p.src = PIXEL; p.hidden = false; });
      await page.locator('[data-scan="admin"]').click(); await page.locator('#camPanel').waitFor();
      await page.goBack(); await page.waitForFunction(() => S.asec === 'reg' && document.querySelector('#nAddr'));
      assert.equal(await page.locator('#nNum').inputValue(), '642'); assert.equal(await page.locator('#nAddr').inputValue(), '탐색 검증 위치');
      assert.equal(await page.locator('#nNote').inputValue(), '초안 보존 확인'); assert.equal(await page.locator('#nNoPlate').isChecked(), true);
      assert.equal(await page.evaluate(() => !document.querySelector('#nPrev').hidden && document.querySelector('#nPrev').src.startsWith('data:image/png') && window.__nPhoto === PIXEL), true, 'photo preview and attachment state come back without re-selecting a file');
      assert.equal(await page.locator('#nPhoto').inputValue(), '', 'no file is forced back into the file input');
    });
    await scenario('durable mode: a registration draft survives leaving and a reload, and can be emptied', async page => {
      assert.equal(await page.evaluate(() => DGOffline.durable), true);
      await page.evaluate(() => openAdminSection('reg')); await page.locator('#nAddr').waitFor();
      await page.locator('#nAddr').fill('새로고침 전 입력'); await page.locator('#nNote').fill('기기 보관');
      await poll(page, () => FD.state['asec:reg'] && FD.state['asec:reg'].persisted, 'the draft to be kept on the device');
      await page.locator('#sheet .sheet-head .x[data-close]').click(); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      assert.deepEqual(page.dialogs, [], 'a kept draft leaves without asking');
      await page.reload(); await ready(page); await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); openAdminSection('reg'); });
      await page.waitForFunction(() => document.querySelector('#nAddr')?.value === '새로고침 전 입력');
      assert.equal(await page.locator('#nNote').inputValue(), '기기 보관');
      assert.match(await page.locator('#asecBody .notice').textContent(), /작성 중이던 등록 내용을 불러왔어요/);
      await page.locator('[data-fdclear="asec:reg"]').click();
      await page.waitForFunction(() => document.querySelector('#nAddr')?.value === '' && !document.querySelector('[data-fdclear]'));
      assert.equal(await page.evaluate(async () => !(await DGOffline.get('formDraft', 'asec:reg@' + DG_TAB))), true, 'emptying removes the device draft');
    });
    await scenario('shared-device mode: leaving unsaved input asks, cancel keeps the screen, confirm leaves', async page => {
      await page.evaluate(async () => { await DGOffline.configure({ namespace: DGOffline.namespace, durable: false, networkRequired: false }); });
      assert.equal(await page.evaluate(() => DGOffline.durable), false);
      await page.evaluate(() => openAdminSection('inbox')); await page.locator('#ibNum').waitFor();
      await page.locator('#ibDesc').fill('공유 기기 입력'); await page.waitForTimeout(700);
      page.answer = false; await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      assert.equal(page.dialogs.length, 1); assert.match(page.dialogs[0], /보관하지 않아요/);
      assert.equal(await sheetOpen(page), true, 'cancel keeps the form'); assert.equal(await page.locator('#ibDesc').inputValue(), '공유 기기 입력');
      await page.goBack(); await page.waitForTimeout(300);
      assert.equal(page.dialogs.length, 2); assert.equal(await sheetOpen(page), true, 'phone Back refused by the guard restores the level');
      assert.equal(await page.evaluate(() => history.state && history.state.nav), 1);
      page.answer = true; await page.locator('#sheet .sheet-head .x[data-close]').click();
      await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      assert.equal(page.dialogs.length, 3);
    });
    await scenario('a draft that could not be stored is never shown as saved: leaving offers stay or discard', async page => {
      await page.evaluate(() => { window.__realPut = DGOffline.put; DGOffline.put = async () => { throw new Error('QuotaExceeded'); }; });
      await page.evaluate(() => openAdminSection('reg')); await page.locator('#nAddr').waitFor();
      await page.locator('#nAddr').fill('용량 부족 입력'); await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => FD.state['asec:reg'].persisted), false); assert.match(await page.evaluate(() => FD.state['asec:reg'].error), /Quota/);
      page.answer = false; await page.locator('#sheet .sheet-head .x[data-close]').click(); await page.waitForTimeout(200);
      assert.match(page.dialogs.at(-1), /보관하지 못했어요/); assert.equal(await sheetOpen(page), true);
      page.answer = true; await page.locator('#sheet .sheet-head .x[data-close]').click();
      await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      await page.evaluate(() => { DGOffline.put = window.__realPut; });
    });
    await scenario('works list keeps filters, page and the row that was opened; the map keeps its view', async page => {
      const lightId = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat) && l.kind === '보안등' && l.num).id);
      await page.evaluate(id => DGOperations.newWork(id), lightId);
      await page.locator('#woTitle').fill('상태 유지 작업'); await page.locator('#woAssignee').selectOption('local'); await page.locator('[data-dg="create-work"]').click();
      await poll(page, async () => (await db.collection('workOrders').get()).docs.length === 1, 'the new work order');
      await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      await page.evaluate(() => openAdminSection('works')); await page.locator('#woMine').waitFor();
      await page.locator('#woMine').check(); await page.locator('#woDeadline').selectOption('all');
      await poll(page, () => DGOperations.state.mine === true && DGOperations.state.workQueryKey === JSON.stringify(DGOperations.workFilters()), 'filtered list');
      await page.locator('[data-dg="open-work"]').first().waitFor();
      const workId = await page.locator('[data-dg="open-work"]').first().getAttribute('data-id');
      await page.locator('[data-dg="open-work"][data-id="' + workId + '"]').click(); await page.locator('#woDetail').waitFor();
      await page.goBack(); await page.waitForFunction(() => S.asec === 'works' && document.querySelector('[data-dg="open-work"]'));
      await page.waitForTimeout(150);
      assert.equal(await page.locator('#woMine').isChecked(), true, '내 담당 filter survives');
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.id), workId, 'focus returns to the row that was opened');
      await page.evaluate(() => closeSheet('all')); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      // map: pan/zoom, open a facility from its popup, come back to the same view
      await page.evaluate(() => openMap('filtered')); await page.waitForFunction(() => gmap && gmapLayer);
      await page.evaluate(() => { gmap.setView([35.1500, 126.9300], 16); });
      await page.evaluate(() => { const m = gmapLayer.getLayers().find(l => l.getPopup); m.openPopup(); });
      await page.locator('[data-map-open]').first().click(); await page.locator('#iMemo').waitFor();
      await page.goBack(); await page.waitForFunction(() => gmap && document.querySelector('#gmap'));
      await page.waitForTimeout(300);
      const view = await page.evaluate(() => ({ lat: +gmap.getCenter().lat.toFixed(4), lng: +gmap.getCenter().lng.toFixed(4), zoom: gmap.getZoom() }));
      assert.deepEqual(view, { lat: 35.15, lng: 126.93, zoom: 16 }, 'the map comes back where it was left');
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
