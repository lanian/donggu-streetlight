/* Status integrity: status changes without an inspection are an administrator's tool; the review backlog is counted
   regardless of the review screen's filters and says "40+" while only the newest 40 are loaded; a redo request on an
   older inspection leaves a newer status alone and never lowers 고장; rejected or merged field registrations no longer
   count as lights in service. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  // Browser checks always run the device (체험) mode: the deployed firebase-config.js points at the real project.
  if (req.url.split('?')[0].endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG = null;'); }
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { try { localStorage.setItem('dg-device', 'desktop'); } catch (e) {} });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  const settle = async () => { await page.evaluate(() => { if (window.DGDialog && DGDialog.isOpen()) DGDialog.cancel(); if (NAV.stack.length) closeSheet('all'); }); await page.waitForFunction(() => !NAV.stack.length && !document.querySelector('#sheet').classList.contains('open')); };
  try {
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); });
    const light = await page.evaluate(() => S.lights.find(l => l.kind === '가로등' && Number.isFinite(l.lat)).id);

    // 1. quick status buttons: administrators only
    checks.push('status without inspection is admin-only');
    await page.evaluate(id => openLight(id), light); await page.locator('#sheet .sheet-head').waitFor();
    assert.ok(await page.locator('#sheet [data-lstat]').count() > 0);
    await settle();
    await page.evaluate(() => { S.demoRole = 'inspector'; render(); });
    await page.evaluate(id => openLight(id), light); await page.locator('#sheet .sheet-head').waitFor();
    assert.equal(await page.locator('#sheet [data-lstat]').count(), 0);
    await settle(); await page.evaluate(() => { S.demoRole = 'admin'; render(); });

    // 2. review backlog ignores the screen's filters and is honest about the 40-item window
    checks.push('review backlog');
    await page.evaluate(async id => {
      const base = Date.now() - 20 * 86400000;
      for (let i = 0; i < 60; i++) await db.doc('inspections/rv-' + i).set({ lightId: id, code: 'x', result: i % 2 ? '정상' : '고장', date: base + i * 1000, inspector: 'local', checks: {} });
    }, light);
    await page.waitForFunction(() => S.insp.length >= 40);
    assert.equal(await page.evaluate(() => ADMIN_SECTIONS.hist.n()), '40+');
    await page.evaluate(() => { IR.result = '고장'; IR.period = 7; });
    assert.equal(await page.evaluate(() => ADMIN_SECTIONS.hist.n()), '40+', 'filters do not change the backlog');
    await page.evaluate(() => { S.tab = 'admin'; render(); });
    await page.locator('.todaystrip [data-asec="hist"]').click();
    await page.waitForFunction(() => IR.more && !IR.loading);
    assert.equal(await page.evaluate(() => ADMIN_SECTIONS.hist.n()), 60);
    assert.deepEqual(await page.evaluate(() => [IR.period, IR.only, IR.result]), [0, true, '전체']);
    await settle();

    // 3. redo on an older inspection does not touch a newer status; on the latest it records the request without lowering 고장
    checks.push('redo respects newer status and faults');
    await page.evaluate(async id => { const now = Date.now(); await patchLight(id, { status: '정상', statusAt: now, lastInspected: now, updatedAt: now }); }, light);
    await page.evaluate(() => { window.__p = window.dgPrompt; window.dgPrompt = async () => '사진 흐림'; });
    await page.evaluate(() => inspReview('rv-0', true));
    await page.waitForFunction(() => /더 최근 점검/.test(document.querySelector('#toast').textContent));
    assert.equal(await page.evaluate(id => byId(id).status, light), '정상');
    await page.evaluate(async id => { const now = Date.now() + 10; await db.doc('inspections/rv-new').set({ lightId: id, code: 'x', result: '고장', date: now, inspector: 'local', checks: {} }); await patchLight(id, { status: '고장', statusAt: now, lastInspected: now, updatedAt: now }); }, light);
    await page.waitForFunction(() => S.insp.some(i => i.id === 'rv-new'));
    await page.evaluate(() => { IR.more = null; });
    await page.evaluate(() => inspReview('rv-new', true));
    await page.waitForFunction(id => byId(id).redoNote === '사진 흐림', light);
    assert.equal(await page.evaluate(id => byId(id).status, light), '고장', '고장 stays 고장');
    assert.equal(await page.evaluate(id => DGOperationsCore.inspectionState(byId(id), 90, Date.now()).key, light), 'redo');
    await page.evaluate(() => { window.dgPrompt = window.__p; });

    // 4. a rejected field registration is no longer a light in service, but stays in 미등록 관리
    checks.push('rejected registrations leave the active list');
    const before = await page.evaluate(() => S.lights.length);
    await page.evaluate(async () => { await db.doc('lights/np-rejected').set({ code: '반려 시험 1', kind: '가로등', dong: '산수동', status: '정상', reg: '반려', foundAt: Date.now(), foundBy: 'local', lat: 35.15, lng: 126.93 }); });
    await page.waitForFunction(() => (S.allLights || []).some(l => l.id === 'np-rejected'));
    assert.equal(await page.evaluate(() => S.lights.some(l => l.id === 'np-rejected')), false);
    assert.equal(await page.evaluate(() => S.lights.length), before);
    assert.equal(await page.evaluate(() => pendingList().some(l => l.id === 'np-rejected')), true);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
