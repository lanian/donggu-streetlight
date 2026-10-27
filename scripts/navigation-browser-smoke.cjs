/* Navigation stack: Back returns one screen at a time, late responses never reopen a closed screen, overlays close alone.
   Real History, DOM and local storage; camera/GPS/Firebase are not involved. */
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
const PIXEL_NODE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(pixel => { window.PIXEL = pixel; }, PIXEL_NODE);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const results = [], errors = [];
  const sheetOpen = page => page.evaluate(() => document.querySelector('#sheet').classList.contains('open'));
  const depth = page => page.evaluate(() => NAV.stack.map(e => e.key));
  const back = async (page, expect) => { await page.goBack(); await page.waitForFunction(expect); await page.waitForTimeout(80); };
  const poll = async (page, fn, label) => { for (let i = 0; i < 100; i++) { if (await page.evaluate(fn)) return; await page.waitForTimeout(100); } throw new Error('timed out waiting for ' + label); };
  async function scenario(name, run) {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(name + ': ' + e.message)); page.on('dialog', dialog => dialog.accept());
    try {
      await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
      await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); });
      await run(page); results.push(name);
    } finally { await page.close(); }
  }
  async function createWork(page) {
    const lightId = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat) && l.kind === '보안등' && l.num).id);
    await page.evaluate(id => DGOperations.newWork(id), lightId);
    await page.locator('#woTitle').fill('탐색 검증 작업'); await page.locator('#woAssignee').selectOption('local');
    await page.locator('[data-dg="create-work"]').click();
    await poll(page, async () => (await db.collection('workOrders').get()).docs.length === 1, 'the new work order');
    const workId = await page.evaluate(async () => (await db.collection('workOrders').get()).docs[0].id);
    await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    return { lightId, workId };
  }
  try {
    await scenario('works list → work detail → facility inspection → photo: Back returns one level at a time', async page => {
      const { lightId, workId } = await createWork(page);
      await page.evaluate(() => openAdminSection('works')); await page.locator('[data-dg="open-work"]').first().waitFor();
      const listScroll = await page.evaluate(() => { document.querySelector('#sheet').scrollTop = 40; return document.querySelector('#sheet').scrollTop; });
      await page.locator('[data-dg="open-work"][data-id="' + workId + '"]').click(); await page.locator('#woDetail').waitFor();
      await page.locator('#woDetail [data-light="' + lightId + '"]').click(); await page.locator('#iMemo').waitFor();
      await page.evaluate(id => { GAL['nav-photo'] = { id: 'nav-photo', lightId: id, code: byId(id).code, label: '전경', data: PIXEL, at: Date.now(), by: 'local' }; openPhotoViewer('nav-photo'); }, lightId);
      await page.locator('#ovl .full').waitFor();
      assert.deepEqual(await depth(page), ['asec:works', 'work:' + workId, 'light:' + lightId]);
      assert.equal(await page.locator('#sheet .sheet-head .x[data-close]').getAttribute('aria-label'), '뒤로');
      await back(page, () => document.querySelector('#ovl').hidden && document.querySelector('#iMemo'));
      assert.equal(await sheetOpen(page), true, 'one Back closes only the photo overlay');
      await back(page, () => document.querySelector('#woDetail'));
      assert.equal(await page.locator('#woDetail').getAttribute('data-draft-id') !== null, true, 'the work detail is rebuilt, not the facility sheet');
      await back(page, () => document.querySelector('[data-dg="open-work"]') && S.asec === 'works');
      assert.equal(await page.evaluate(() => document.querySelector('#sheet').scrollTop), listScroll, 'the works list keeps its scroll position');
      assert.equal(await page.locator('#sheet .sheet-head .x[data-close]').getAttribute('aria-label'), '닫기');
      await back(page, () => !document.querySelector('#sheet').classList.contains('open'));
      assert.equal(await page.evaluate(() => !history.state || history.state.nav === 0), true, 'the root entry carries no open screen');
    });
    await scenario('Escape and the back chevron leave one level; a sibling screen of the same kind replaces instead of stacking', async page => {
      const [a, b] = await page.evaluate(() => S.lights.filter(l => Number.isFinite(l.lat)).slice(0, 2).map(l => l.id));
      await page.evaluate(() => openAdminSection('due')); await page.locator('#asecBody').waitFor();
      await page.evaluate(id => openLight(id), a); await page.locator('#iMemo').waitFor();
      await page.evaluate(id => openLight(id), b); await page.waitForFunction(id => draft && draft.lightId === id, b);
      assert.deepEqual(await depth(page), ['asec:due', 'light:' + b], 'another facility replaces the facility level');
      await page.keyboard.press('Escape'); await page.waitForFunction(() => S.asec === 'due' && !document.querySelector('#iMemo'));
      assert.equal(await sheetOpen(page), true);
      await page.locator('#sheet .sheet-head .x[data-close]').click(); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    });
    await scenario('a dossier that answers after Back neither reopens nor toasts; the photo viewer likewise', async page => {
      const lightId = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat)).id);
      await page.evaluate(id => openLight(id), lightId); await page.locator('#iMemo').waitFor();
      await page.evaluate(() => { window.__gate = {}; __gate.promise = new Promise((resolve, reject) => { __gate.resolve = resolve; __gate.reject = reject; }); const real = listAllRecords; window.__realList = real; listAllRecords = async (...args) => { await __gate.promise; return real(...args); }; });
      await page.evaluate(id => { openLightDossier(id).catch(() => {}); }, lightId);
      await page.goBack(); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      await page.evaluate(() => { document.querySelector('#toast').textContent = ''; __gate.reject(new Error('늦은 이력 오류')); });
      await page.waitForTimeout(300);
      assert.equal(await sheetOpen(page), false, 'the late dossier must not reopen a closed sheet');
      assert.equal(await page.evaluate(() => document.querySelector('#toast').textContent), '', 'a cancelled load must not toast its error');
      await page.evaluate(() => { listAllRecords = __realList; });
      // photo viewer: open, leave the sheet, then let the photo arrive
      await page.evaluate(id => openLight(id), lightId); await page.locator('#iMemo').waitFor();
      await page.evaluate(id => { window.__photoGate = {}; __photoGate.promise = new Promise(r => { __photoGate.resolve = r; }); const real = getPhoto; getPhoto = async pid => { await __photoGate.promise; return { id: pid, lightId: id, data: PIXEL, label: '전경', at: Date.now() }; }; openPhotoViewer('late-photo'); }, lightId);
      await page.goBack(); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      await page.evaluate(() => __photoGate.resolve()); await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.querySelector('#ovl').hidden), true, 'the late photo must not open over the list');
    });
    await scenario('inbox → report-to-work link → work detail: Back retraces each screen', async page => {
      const { lightId, workId } = await createWork(page);
      await page.evaluate(async id => { const l = byId(id); await db.doc('reports/nav-report').set({ lightId: id, code: l.code, dong: l.dong, issue: '꺼짐', desc: '탐색 검증', status: '접수', createdAt: Date.now(), reporterId: 'local' }); await DGOperations.load(true); }, lightId);
      await page.evaluate(() => openAdminSection('inbox')); await page.locator('[data-fw="report-work"][data-id="nav-report"]').waitFor();
      await page.locator('[data-fw="report-work"][data-id="nav-report"]').click(); await page.locator('#dgReportWork').waitFor();
      await page.locator('#dgExistingWork').selectOption(workId); await page.locator('[data-fw="link-existing-work"]').click();
      await page.locator('#woDetail').waitFor();
      assert.deepEqual(await depth(page), ['asec:inbox', 'rwork:nav-report', 'work:' + workId]);
      await back(page, () => document.querySelector('#dgReportWork') || document.querySelector('#asecBody'));
      // the report is now linked, so its link screen may refuse to reopen and drop to the inbox; either way no stale work detail remains
      assert.equal(await page.locator('#woDetail').count(), 0);
      await page.evaluate(() => closeSheet('all')); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    });
    await scenario('photo confirm panel and photo viewer are overlays: Back closes only them', async page => {
      const lightId = await page.evaluate(() => { const l = S.lights.find(x => Number.isFinite(x.lat)); l.photoT = PIXEL; l.reps = { 전경: { id: 'rep-nav', at: Date.now() } }; GAL['rep-nav'] = { id: 'rep-nav', lightId: l.id, data: PIXEL, label: '전경', at: Date.now() }; return l.id; });
      await page.evaluate(() => openAdminSection('due')); await page.locator('#asecBody').waitFor();
      await page.evaluate(id => repConfirm(id, 'list', []), lightId); await page.locator('#cmpSheet .strip img').waitFor();
      await page.locator('#cmpSheet .strip img').click(); await page.locator('#ovl .full').waitFor();
      await back(page, () => document.querySelector('#ovl').hidden);
      assert.equal(await page.evaluate(() => document.querySelector('#cmpSheet').hidden), false, 'the viewer closes, the confirm panel below stays');
      await back(page, () => document.querySelector('#cmpSheet').hidden);
      assert.equal(await sheetOpen(page), true, 'the section under the overlays is untouched');
      assert.deepEqual(await depth(page), ['asec:due']);
    });
    await scenario('rapid Back presses and a stale History entry after reload leave stack and screen consistent', async page => {
      const lightId = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat)).id);
      await page.evaluate(() => openAdminSection('due')); await page.locator('#asecBody').waitFor();
      await page.evaluate(id => openLight(id), lightId); await page.locator('#iMemo').waitFor();
      await page.evaluate(id => openLightEdit(id), lightId); await page.locator('#leLat').waitFor();
      await page.evaluate(() => { history.back(); history.back(); });
      await page.waitForFunction(() => S.asec === 'due' && document.querySelector('#asecBody') && NAV.stack.length === 1);
      await page.waitForTimeout(200);
      assert.deepEqual(await depth(page), ['asec:due']);
      assert.equal(await page.evaluate(() => history.state.nav), 1);
      await page.reload(); await page.waitForFunction(() => S.live && DGOffline.ready && DGIntegration.initialized);
      assert.equal(await page.evaluate(() => !history.state || history.state.nav === 0), true, 'a reload starts at depth 0 whatever the entry carried');
      assert.equal(await sheetOpen(page), false);
    });
    await scenario('brightness review → candidate map → exclusion editor: Back returns to the map, then to the list', async page => {
      await page.waitForFunction(() => DGLighting.state.loaded && DGLightingAreas.state.loaded);
      await page.locator('[data-asec="light"]').click(); await page.locator('[data-rvmode="pairs"]').click(); await page.locator('#rvRun').click();
      await page.waitForFunction(() => S.review?.historyState === 'synced'); await page.locator('.rv-candidate [data-rvmap]').first().waitFor();
      await page.locator('.rv-candidate [data-rvmap]').first().click(); await page.locator('#rvMapSummary').waitFor();
      const mid = await page.evaluate(() => rvList(rvFresh())[0].mid);
      await page.evaluate(point => DGLightingAreas.openEditor({ ...point, radius: 25, label: '탐색 검증 구역' }), mid); await page.locator('#laForm').waitFor();
      assert.deepEqual(await depth(page), ['asec:light', 'rvmap', 'laedit']);
      await back(page, () => document.querySelector('#rvMapSummary') && !document.querySelector('#laForm'));
      assert.equal(await page.evaluate(() => !!gmap), true, 'the candidate map is rebuilt under the editor');
      await back(page, () => !document.querySelector('#rvMapSummary') && document.querySelector('.rv-selected'));
      assert.equal(await page.evaluate(() => gmap), null);
      assert.equal(await sheetOpen(page), true);
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
