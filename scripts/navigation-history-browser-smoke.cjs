/* NAV-06: Forward re-enters screens from memory without re-submitting, tabs are part of History, rapid Back/Forward stay
   consistent, and permission changes or deleted items drop their screens safely.
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
    await scenario('Back then Forward reopens the screen from memory without re-running any write', async page => {
      const lightId = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat)).id);
      await page.evaluate(() => openAdminSection('due')); await page.locator('#asecBody').waitFor();
      await page.evaluate(id => openLight(id), lightId); await page.locator('#iMemo').waitFor();
      const writes = await page.evaluate(() => { window.__writes = 0; const real = db.doc.bind(db); db.doc = p => { const d = real(p); const set = d.set.bind(d), update = d.update.bind(d); d.set = (...a) => { __writes++; return set(...a); }; d.update = (...a) => { __writes++; return update(...a); }; return d; }; return __writes; });
      await back(page, () => S.asec === 'due' && !document.querySelector('#iMemo'));
      assert.deepEqual(await depth(page), ['asec:due']);
      await page.goForward(); await page.waitForFunction(() => document.querySelector('#iMemo') && NAV.stack.length === 2);
      assert.deepEqual(await depth(page), ['asec:due', 'light:' + lightId]);
      assert.equal(await page.evaluate(() => history.state.nav), 2);
      assert.equal(await page.evaluate(() => __writes), writes, 'forward is a read-only reopen');
      await back(page, () => S.asec === 'due'); await back(page, () => !document.querySelector('#sheet').classList.contains('open'));
      await page.goForward(); await page.waitForFunction(() => S.asec === 'due' && document.querySelector('#asecBody'));
      assert.deepEqual(await depth(page), ['asec:due'], 'forward from the root reopens the first level');
    });
    await scenario('rapid Back and Forward presses leave History depth and stack in step, with no duplicate renders', async page => {
      const [a, b] = await page.evaluate(() => S.lights.filter(l => Number.isFinite(l.lat)).slice(0, 2).map(l => l.id));
      await page.evaluate(() => openAdminSection('due')); await page.locator('#asecBody').waitFor();
      await page.evaluate(id => openLight(id), a); await page.locator('#iMemo').waitFor();
      await page.evaluate(id => openLightEdit(id), a); await page.locator('#leLat').waitFor();
      await page.evaluate(() => { history.back(); history.back(); history.forward(); });
      await page.waitForFunction(() => !NAV.syncing && NAV.stack.length === (history.state && history.state.nav));
      await page.waitForTimeout(400);
      const state = await page.evaluate(() => ({ depth: NAV.stack.length, nav: history.state.nav, keys: NAV.stack.map(e => e.key), hasEdit: !!document.querySelector('#leLat'), hasMemo: !!document.querySelector('#iMemo') }));
      assert.equal(state.depth, state.nav, 'stack depth equals the History depth after the burst');
      assert.equal(state.keys[state.depth - 1] === 'light:' + a ? state.hasMemo : state.keys[state.depth - 1] === 'ledit:' + a ? state.hasEdit : true, true, 'the rendered screen is the one on top');
      await page.evaluate(() => closeSheet('all')); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      assert.equal(await page.evaluate(() => history.state.nav), 0);
    });
    await scenario('tab switches are History entries: Back restores the previous tab, repeated clicks do not pile up', async page => {
      await page.evaluate(() => { S.tab = 'inspect'; render(); history.replaceState({ nav: 0, tab: 'inspect' }, ''); });
      const before = await page.evaluate(() => history.length);
      await page.locator('nav.tabs [data-tab="admin"]').click(); await page.waitForFunction(() => S.tab === 'admin');
      await page.locator('nav.tabs [data-tab="admin"]').click(); await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => history.length), before + 1, 'one entry for the switch, none for the repeat');
      assert.deepEqual(await page.evaluate(() => history.state), { nav: 0, tab: 'admin' });
      await page.goBack(); await page.waitForFunction(() => S.tab === 'inspect');
      assert.equal(await page.evaluate(() => document.querySelector('nav.tabs [aria-selected="true"]').dataset.tab), 'inspect');
      await page.goForward(); await page.waitForFunction(() => S.tab === 'admin');
      await page.evaluate(() => openAdminSection('due')); await page.locator('#asecBody').waitFor();
      await back(page, () => !document.querySelector('#sheet').classList.contains('open'));
      assert.equal(await page.evaluate(() => S.tab), 'admin', 'closing a sheet keeps the tab it was opened from');
    });
    await scenario('a permission change closes screens the person may no longer see, and they cannot be reopened', async page => {
      await page.evaluate(() => openAdminSection('inventory')); await page.locator('#asecBody').waitFor();
      await page.evaluate(() => { S.demoRole = 'inspector'; render(); });
      await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      assert.match(await page.locator('#toast').textContent(), /권한이 바뀌어/);
      await page.evaluate(() => openAdminSection('inventory')); await page.waitForTimeout(150);
      assert.equal(await sheetOpen(page), false); assert.match(await page.locator('#toast').textContent(), /권한이 없어요/);
      assert.equal(await page.evaluate(() => history.state.nav), 0);
    });
    await scenario('a screen whose item disappeared is skipped on Back and lands on its parent', async page => {
      const lightId = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat)).id);
      await page.evaluate(() => openAdminSection('due')); await page.locator('#asecBody').waitFor();
      await page.evaluate(id => openLight(id), lightId); await page.locator('#iMemo').waitFor();
      await page.evaluate(id => openLightEdit(id), lightId); await page.locator('#leLat').waitFor();
      await page.evaluate(id => { S.lights = S.lights.filter(l => l.id !== id); LIDX = null; }, lightId); // the facility is gone from the registry index
      await page.goBack(); await page.waitForFunction(() => S.asec === 'due' && document.querySelector('#asecBody') && NAV.stack.length === 1);
      await page.waitForTimeout(200);
      assert.deepEqual(await depth(page), ['asec:due']); assert.equal(await page.evaluate(() => history.state.nav), 1);
      assert.equal(await page.locator('#iMemo').count(), 0);
    });
    await scenario('first tab entry is initialized: Back returns to inspect without manual history reset', async page => {
      await page.reload(); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local');
      assert.equal(await page.evaluate(() => S.tab), 'inspect');
      assert.equal(await page.evaluate(() => history.state.tab), 'inspect');
      await page.locator('nav.tabs [data-tab="admin"]').click();
      await page.waitForFunction(() => S.tab === 'admin');
      await page.goBack(); await page.waitForFunction(() => S.tab === 'inspect');
      assert.equal(await page.locator('nav.tabs [aria-selected="true"]').getAttribute('data-tab'), 'inspect');
    });
    await scenario('latest edited form fingerprint must be stored before Back is allowed', async page => {
      const dialogs = []; page.removeAllListeners('dialog');
      page.on('dialog', dialog => { dialogs.push(dialog.message); return dialog.dismiss(); });
      await page.evaluate(async () => {
        await DGOffline.configure({ namespace: 'boundary-draft-e2e', durable: true, networkRequired: false, adapter: DGOffline.memoryStore() });
        openAdminSection('reg');
      });
      await page.locator('#nNote').fill('이미 기기에 저장된 메모');
      await page.waitForFunction(() => fdIsPersisted('asec:reg'));
      await page.locator('#nNote').fill('저장 직후 수정한 마지막 문장');
      assert.equal(await page.evaluate(() => fdIsPersisted('asec:reg')), false);
      assert.equal(await page.evaluate(() => FD.state['asec:reg'].persisted), false);
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => history.state.nav === 1 && document.querySelector('#sheet').classList.contains('open'));
      assert.equal(await page.locator('#nNote').inputValue(), '저장 직후 수정한 마지막 문장');
      assert.ok(dialogs.some(message => message.includes('보관하지 못했어요')));
      await page.waitForFunction(() => fdIsPersisted('asec:reg'));
      assert.equal(await page.evaluate(async () => {
        const saved = await DGOffline.get('formDraft', fdId('asec:reg'));
        return !!saved && fdFingerprint(saved) === fdFingerprint(fdSnapshot('asec:reg'));
      }), true);
    });
    await scenario('permission revocation closes even a dirty form without asking to discard', async page => {
      const dialogs = []; page.removeAllListeners('dialog');
      page.on('dialog', dialog => { dialogs.push(dialog.message); return dialog.dismiss(); });
      await page.evaluate(async () => {
        await DGOffline.configure({ namespace: 'boundary-permission-e2e', durable: true, networkRequired: false, adapter: DGOffline.memoryStore() });
        openAdminSection('reg');
      });
      await page.locator('#nNote').fill('권한 변경 직전 미저장 내용');
      assert.equal(await page.evaluate(() => fdIsPersisted('asec:reg')), false);
      await page.evaluate(() => { S.canWrite = false; render(); });
      await page.waitForFunction(() => NAV.stack.length === 0 && !document.querySelector('#sheet').classList.contains('open'));
      assert.equal(await page.locator('#nNote').count(), 0);
      assert.equal(dialogs.length, 0, 'revoked access cannot be vetoed by the discard confirmation');
      assert.equal(await page.evaluate(() => history.state.nav), 0);
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
