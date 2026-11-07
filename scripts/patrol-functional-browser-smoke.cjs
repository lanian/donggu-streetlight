/* Local browser regression for patrol observation safety, targets, coordinate queue and report validation. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.endsWith('/firebase-config.js')) return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('window.FIREBASE_CONFIG=null;');
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.DONGGU_CHROMIUM || undefined, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('dg-device', 'phone'));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin);
    await page.waitForFunction(() => S.live && S.me === 'local' && DGOffline.ready && DGIntegration.initialized);
    const ids = await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'inspect'; render(); return S.lights.filter(ptEligible).slice(0, 3).map(l => l.id); });
    const start = async () => { await page.evaluate(async () => { if(pt.hist){const event=new Promise(resolve=>window.addEventListener('popstate',resolve,{once:true}));ptReset();await event;}else ptReset(); }); return page.evaluate(() => { openPatrol('전체'); if (pt.watch != null) navigator.geolocation.clearWatch(pt.watch); pt.watch = null; pt.watchRun = (pt.watchRun || 0) + 1; }); };
    const settleSheets = () => page.evaluate(async () => { if(NAV.stack.length){const event=new Promise(resolve=>window.addEventListener('popstate',resolve,{once:true}));closeSheet('all');await event;} });

    await start();
    const safety = await page.evaluate(async id => {
      await patchLight(id, { status: '고장', redoNote: '전선 노출 재점검', lastInspected: 1000, lastResult: '고장', updatedAt: 1000 });
      pt.sel = id; ptMark('정상'); const job = preparePatrolJob(); await commitPatrolJob(job);
      const l = await lightState(id); return { status: l.status, redo: l.redoNote, inspected: l.lastInspected };
    }, ids[0]);
    assert.deepEqual(safety, { status: '고장', redo: '전선 노출 재점검', inspected: 1000 });

    await start();
    const gps = await page.evaluate(id => {
      const l = byId(id), fix = (lat, acc) => ({ timestamp: Date.now(), coords: { latitude: lat, longitude: l.lng, accuracy: acc } });
      ptPos(fix(l.lat, 5)); ptPos(fix(l.lat + .01, 120)); ptSpot(); const bad = pt.spots.length;
      ptPos(fix(l.lat, 5)); pt.sel = id; ptMark('고장'); ptSpot(); return { bad, good: pt.spots.length };
    }, ids[0]);
    assert.deepEqual(gps, { bad: 0, good: 1 });
    await page.evaluate(async () => { await DGIntegration.persistPatrol(); const saved = await DGOffline.get('patrol', 'current'); if (saved.undo.length !== 2) throw Error('Undo log missing'); ptReset(); await DGIntegration.restorePatrol(); if (pt.watch != null) navigator.geolocation.clearWatch(pt.watch); pt.watch = null; ptUndoLast(); });
    assert.deepEqual(await page.evaluate(() => [pt.marks.length, pt.spots.length]), [1, 0]);
    await page.evaluate(async () => { ptReset(); await DGOffline.remove('patrol', 'current'); closeSheet('all'); });

    const coverage = await page.evaluate(() => { const ls = S.lights.filter(ptEligible); PT_COVER.data = [{ start: Date.now(), passed: ls.map(l => l.id) }]; ptIndex(); return ptCoverage('전체'); });
    assert.equal(coverage.pct, 100);
    await start();
    const oldProgress = await page.evaluate(() => { pt.total = S.lights.length; pt.passed = new Map(S.lights.filter(ptEligible).map(l => [l.id, {}])); ptDraw(true); return document.querySelector('#ptPct').textContent; });
    assert.match(oldProgress, /^100%/, 'legacy draft denominator is reconciled with current eligible facilities');
    await page.evaluate(async () => { if(pt.hist){const event=new Promise(resolve=>window.addEventListener('popstate',resolve,{once:true}));ptReset();await event;}else ptReset(); });
    await page.evaluate(() => openCoordinateQueue());
    await page.locator('#coordinateDong').waitFor();
    assert.match(await page.locator('#sheet').innerText(), /추정 좌표 정비|분전함/);
    const first = await page.locator('#sheet [data-light]').first().getAttribute('data-light');
    await page.locator('#sheet [data-light]').first().click();
    await page.waitForFunction(id => draft?.lightId === id, first);
    assert.equal(await page.evaluate(() => !!document.querySelector('#posBox')), true);
    await settleSheets();

    await page.evaluate(async targets => {
      DGOperations.state.plan = { createdAt: Date.now() + 100, stops: targets.map(id => ({ ...byId(id), visited: false })) };
      await ptLaunchPlan(); if (pt.watch != null) navigator.geolocation.clearWatch(pt.watch); pt.watch = null; pt.watchRun = (pt.watchRun || 0) + 1;
      pt.passed.set(targets[0], { at: Date.now() }); pt.sel = targets[1]; ptMark('정상'); await DGIntegration.persistPatrol(); ptFinish();
    }, ids);
    await page.locator('#sheet [data-ptcarry]').waitFor();
    assert.equal(await page.evaluate(() => ptMissingTargets().length), 2, 'GPS-only target remains unconfirmed');
    const targetRecord = await page.evaluate(() => preparePatrolJob().rec);
    assert.equal(targetRecord.targets.length, 3); assert.equal(targetRecord.unconfirmedTargets.length, 2);
    await page.locator('#sheet [data-ptcarry]').click();
    await page.waitForFunction(async () => (await DGOffline.get('patrolTargets', 'next'))?.targets.length === 2);
    await page.evaluate(async () => { ptReset(); await DGOffline.remove('patrol', 'current'); });
    await settleSheets();
    await page.evaluate(async () => { await ptLaunchCarryover(); if (pt.watch != null) navigator.geolocation.clearWatch(pt.watch); pt.watch = null; });
    assert.equal(await page.evaluate(() => pt.targets.length), 2);
    assert.equal(await page.evaluate(async () => await DGOffline.get('patrolTargets', 'next')), null);
    await page.evaluate(async () => { ptReset(); await DGOffline.remove('patrol', 'current'); closeSheet('all'); REP.period = 'custom'; REP.from = '2026-11-07'; REP.to = '2026-11-01'; REP.data = null; REP.err = ''; openAdminSection('report'); });
    await page.locator('#repFrom').waitFor();
    assert.equal(await page.locator('#csv7').isDisabled(), true);
    assert.match(await page.locator('#sheet').innerText(), /시작일이 종료일보다 늦/);
    await page.locator('#repTo').fill('2026-11-07'); await page.locator('#repTo').press('Tab');
    await page.waitForFunction(() => REP.data?.key === reportQueryKey() && !REP.err);
    assert.equal(await page.locator('#csv7').isDisabled(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: patrol safety, GPS coherence, restored undo, eligible progress, coordinate queue, plan targets/carryover and report correction; browser errors 0');
  } finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
