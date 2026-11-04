/* App update pre-check: before a new version reloads the app, the person sees in plain words what stays on this device
   and what must be finished first (with a button to go there). Nothing that would be lost is dropped silently, and
   records already kept on the device no longer block the update with a vague message. */
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
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { try { localStorage.setItem('dg-device', 'phone'); } catch (e) {} });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  const settle = async () => { await page.evaluate(() => { if (window.DGDialog && DGDialog.isOpen()) DGDialog.cancel(); if (NAV.stack.length) closeSheet('all'); }); await page.waitForFunction(() => !NAV.stack.length && !document.querySelector('#sheet').classList.contains('open')); };
  const check = () => page.evaluate(() => { window.__upd = updateCheck(); return true; });
  try {
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'inspect'; render(); });
    assert.equal(await page.evaluate(() => DGOffline.durable), true);

    // 1. nothing in progress: the update goes ahead without a question
    checks.push('clean device updates at once');
    assert.equal(await page.evaluate(() => updateCheck()), true);

    // 2. a banner on the home screen says a new version exists and starts the check
    checks.push('home banner');
    await page.evaluate(() => { window.__realReady = DongguPWA.updateReady; DongguPWA.updateReady = () => true; window.__applied = 0; window.__realApply = DongguPWA.applyUpdate; DongguPWA.applyUpdate = async () => { window.__applied++; return false; }; render(); });
    assert.match(await page.locator('.upd-banner').textContent(), /새 버전이 있어요/);
    await page.locator('.upd-banner [data-updapply]').click(); assert.equal(await page.evaluate(() => window.__applied), 1);
    await page.evaluate(() => { DongguPWA.updateReady = window.__realReady; DongguPWA.applyUpdate = window.__realApply; render(); });
    assert.equal(await page.locator('.upd-banner').count(), 0);

    // 3. an inspection being written is stored on the device first, then listed as kept — the person may go ahead
    checks.push('kept drafts are named and do not block');
    const light = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat)));
    await page.evaluate(id => openLight(id), light.id); await page.locator('#iMemo').waitFor();
    await page.locator('#iMemo').fill('업데이트 전 메모');
    await check(); await page.locator('#dgDialog:not([hidden])').waitFor();
    const text = await page.locator('#dgDialog .dgdlg-msg').textContent();
    assert.match(text, /작성 중이던 기록 1건/); assert.match(text, /저장 대기함에서 이어/);
    assert.equal(await page.locator('#dgDialog [data-dgdlg="ok"]').textContent(), '적용하고 다시 열기');
    assert.equal(await page.evaluate(async () => (await DGOffline.list('draft')).length), 1, 'the draft was stored before asking');
    await page.locator('#dgDialog [data-dgdlg="cancel"]').click();
    assert.equal(await page.evaluate(() => window.__upd), false, '나중에 keeps the old version');
    await settle(); await page.evaluate(async () => { await DGOffline.remove('draft', (await DGOffline.list('draft'))[0].id); draft = null; for (const k of Object.keys(DRAFTS)) delete DRAFTS[k]; });

    // 4. a running patrol would be lost: the check opens a screen that names it, explains, and blocks
    checks.push('running patrol blocks with an explanation');
    await page.evaluate(() => { openPatrol('전체'); if (pt.watch != null) { navigator.geolocation.clearWatch(pt.watch); pt.watch = null; } });
    await page.evaluate(() => updateCheck()).then(v => assert.equal(v, false));
    assert.match(await page.locator('#sheet .upd-item.lose').first().textContent(), /야간 순찰이 진행 중/);
    assert.equal(await page.locator('#sheet .upd-h.bad').count(), 1);
    assert.match(await page.locator('#sheet .upd-item.lose [data-updgo]').first().textContent(), /순찰 화면으로/);
    // ending the patrol leaves the patrol History entry, which also closes this screen
    await page.evaluate(() => ptReset()); await page.waitForFunction(() => !pt.on);
    await settle();

    // 5. shared-device mode: unsent work and an unsaved form would be lost and are listed with where to go
    checks.push('shared device lists what would be lost');
    await page.evaluate(async () => { await DGOffline.configure({ namespace: DGOffline.namespace, durable: false, networkRequired: false }); });
    await page.evaluate(() => { S.tab = 'admin'; render(); openAdminSection('inbox'); }); await page.locator('#ibDesc').waitFor();
    await page.locator('#ibDesc').fill('가로등 꺼짐 신고');
    await page.evaluate(() => { window.__upd = updateCheck(); }); await page.waitForFunction(() => document.querySelector('#sheet .upd-item.lose'));
    const lose = await page.evaluate(() => [...document.querySelectorAll('#sheet .upd-item.lose b')].map(b => b.textContent));
    assert.ok(lose.some(t => /신고/.test(t)), 'the report being typed is named: ' + lose.join(' | '));
    assert.match(await page.locator('#sheet .upd-item.lose .muted').first().textContent(), /공유 기기|보관/);
    // "그 화면으로" goes back to the form, input intact
    await page.locator('#sheet .upd-item.lose [data-updgo="close"]').first().click();
    await page.waitForFunction(() => S.asec === 'inbox' && document.querySelector('#ibDesc'));
    assert.equal(await page.locator('#ibDesc').inputValue(), '가로등 꺼짐 신고');
    // once the cause is gone, 다시 확인 finds nothing to lose and hands over to the update
    await settle();
    await page.evaluate(() => { window.__applied = 0; window.__realApply = DongguPWA.applyUpdate; DongguPWA.applyUpdate = async () => { window.__applied++; return true; }; navRoute('update', () => updateSheet()); updateSheet({ lose: [{ t: '시험 항목', how: '마친 뒤 다시 확인' }], keep: [] }); });
    await page.locator('#updRecheck').click(); await page.waitForFunction(() => window.__applied === 1);
    await page.evaluate(() => { DongguPWA.applyUpdate = window.__realApply; });

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
