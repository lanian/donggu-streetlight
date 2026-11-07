/* Patrol and field fixes: tapping the middle of an icon still presses its button; ending a patrol (끝 or Back) asks first
   and the result screen can go back to patrolling; 취소 takes back the last thing done (a mark or a dark spot); a new
   patrol never silently replaces an unsaved one; a patrol continued after its first part went to the outbox saves only
   what came after; the nearby list refreshes without rebuilding the search box. */
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { try { localStorage.setItem('dg-device', 'phone'); } catch (e) {} });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  const settle = async () => { await page.evaluate(() => { if (window.DGDialog && DGDialog.isOpen()) DGDialog.cancel(); if (NAV.stack.length) closeSheet('all'); }); await page.waitForFunction(() => !NAV.stack.length && !document.querySelector('#sheet').classList.contains('open')); };
  try {
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(() => { S.demoRole = 'inspector'; S.tab = 'inspect'; render(); });

    // 1. the middle of an icon belongs to its button
    checks.push('icon middle presses the button');
    const miss = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.querySelector('svg circle,svg path') && b.offsetParent).map(b => {
      const r = b.querySelector('svg').getBoundingClientRect(), el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el && el.closest('button') === b && el.tagName.toLowerCase() === 'button' ? null : (b.id || b.textContent.trim().slice(0, 12));
    }).filter(Boolean));
    assert.deepEqual(miss, []);

    // helpers: a patrol with a fixed position and no GPS watch
    const light = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat) && l.kind === '가로등'));
    const startPatrol = () => page.evaluate(l => { openPatrol('전체'); if (pt.watch != null) { navigator.geolocation.clearWatch(pt.watch); pt.watch = null; } pt.pos = { lat: l.lat, lng: l.lng, acc: 5, at: Date.now() }; pt.acc = 5; pt.fixReady = true; pt.track.push([l.lat, l.lng], [l.lat + 0.0005, l.lng]); }, light);
    const markLight = result => page.evaluate(([id, result]) => { pt.sel = id; ptMark(result); }, [light.id, result]);

    // 2. 취소 takes back the last action, in order
    checks.push('undo follows the order of actions');
    await startPatrol();
    await markLight('고장'); await page.evaluate(() => ptSpot());
    assert.deepEqual(await page.evaluate(() => [pt.marks.length, pt.spots.length]), [1, 1]);
    await page.evaluate(() => ptUndoLast());
    assert.deepEqual(await page.evaluate(() => [pt.marks.length, pt.spots.length]), [1, 0], 'the dark spot went first');
    await markLight('점검필요'); await page.evaluate(() => ptUndoLast());
    assert.equal(await page.evaluate(() => pt.marks[0].result), '고장', 're-marking then undo restores the earlier mark');

    // 3. 끝 asks; 계속 순찰 keeps going; then the result screen offers 순찰 계속
    checks.push('ending asks first and can be continued');
    await page.locator('#ptEnd').click(); await page.locator('#dgDialog:not([hidden])').waitFor();
    await page.locator('#dgDialog [data-dgdlg="cancel"]').click();
    assert.equal(await page.evaluate(() => pt.on), true);
    await page.locator('#ptEnd').click(); await page.locator('#dgDialog:not([hidden])').waitFor();
    await page.locator('#dgDialog [data-dgdlg="ok"]').click();
    await page.locator('#sheet #ptContinue').waitFor();
    await page.locator('#sheet #ptContinue').click();
    await page.waitForFunction(() => pt.on && !document.querySelector('#ptFull').hidden);
    assert.equal(await page.evaluate(() => pt.marks.length), 1, 'the marks are still there');
    if (await page.evaluate(() => pt.watch != null)) await page.evaluate(() => { navigator.geolocation.clearWatch(pt.watch); pt.watch = null; });

    // 4. Back while patrolling asks instead of ending
    checks.push('Back asks before ending');
    await page.evaluate(() => history.back()); await page.locator('#dgDialog:not([hidden])').waitFor();
    await page.locator('#dgDialog [data-dgdlg="cancel"]').click();
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => pt.on), true);

    // 5. ended but unsaved → starting a new patrol asks, and "결과 보고 저장" brings the result back
    checks.push('a new patrol never silently replaces an unsaved one');
    await page.evaluate(() => { ptFinish(); }); await page.locator('#sheet #ptSave').waitFor();
    await page.locator('#sheet [data-close]').first().click(); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    await page.evaluate(() => { S.tab = 'inspect'; render(); });
    await page.locator('#ptBtn').click(); await page.locator('#dgDialog:not([hidden])').waitFor();
    assert.match(await page.locator('#dgDialog').textContent(), /저장하지 않은 순찰/);
    await page.locator('#dgDialog [data-dgdlg-choice="0"]').click();
    await page.locator('#sheet #ptSave').waitFor();
    assert.equal(await page.evaluate(() => pt.marks.length), 1);

    // 6. a continued patrol whose first part is already queued saves only what came after
    checks.push('continuing after a queued part sends only the new part');
    const first = await page.evaluate(() => { const job = preparePatrolJob(); return { session: job.sessionId, marks: job.rec.marks.length, id: job.id }; });
    await page.evaluate(() => closeSheet('all'));
    await page.evaluate(() => ptContinue()); await page.waitForFunction(() => pt.on);
    if (await page.evaluate(() => pt.watch != null)) await page.evaluate(() => { navigator.geolocation.clearWatch(pt.watch); pt.watch = null; });
    const other = await page.evaluate(id => S.lights.find(l => Number.isFinite(l.lat) && l.id !== id).id, light.id);
    await page.evaluate(id => { pt.sel = id; ptMark('고장'); pt.end = Date.now(); }, other);
    const second = await page.evaluate(() => { const job = preparePatrolJob(); return { session: job.sessionId, marks: job.rec.marks.map(m => m.id), inspections: job.inspections.length, id: job.id }; });
    assert.notEqual(second.session, first.session); assert.notEqual(second.id, first.id);
    assert.deepEqual(second.marks, [other], 'only the mark made after the queued part');
    assert.equal(second.inspections, 1);
    await page.evaluate(() => { ptReset(); }); await settle();

    // 7. moving with 내 주변 순 on refreshes the list without replacing the search box
    checks.push('nearby refresh keeps the search box');
    await page.evaluate(() => { S.tab = 'inspect'; S.near = true; S.pos = { lat: 35.146, lng: 126.923, at: Date.now() }; render(); });
    await page.locator('#q').focus(); await page.locator('#q').type('산수');
    const before = await page.evaluate(() => document.querySelector('#q'));
    await page.evaluate(() => { S.pos = { lat: 35.147, lng: 126.924, at: Date.now() }; renderList(); });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'q');
    assert.equal(await page.locator('#q').inputValue(), '산수');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
