/* Real map, patrol and scanner transitions keep one visible destination sheet. */
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
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/css' }));
  const results = [], errors = [];
  async function scenario(name, run) {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(name + ': ' + e.message)); page.on('dialog', dialog => dialog.accept());
    try {
      await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
      await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); });
      await run(page); results.push(name);
    } finally { await page.close(); }
  }
  // parent: the screen one phone-Back press must return to (navigation stack, 2026-10 NAV-02); omitted when the
  // destination replaced its origin (scanner → inbox/register) and Back therefore closes the sheet.
  async function stableSheet(page, selector, parent) {
    await page.locator(selector).waitFor({ state: 'attached' });
    // history.back is asynchronous: the destination must survive its event turn.
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#sheet').evaluate(el => el.classList.contains('open')), true);
    assert.equal(await page.locator(selector).isVisible(), true);
    if (parent) {
      await page.goBack(); await page.locator(parent).waitFor({ state: 'visible' });
      assert.equal(await page.locator(selector).count(), 0, 'the child screen must be gone after Back');
    }
    await page.goBack(); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
  }
  try {
    await scenario('map popup opens facility and phone Back closes the destination', async page => {
      await page.evaluate(() => { const light = S.lights.find(l => Number.isFinite(l.lat)); openMap('custom', { title: '전이 확인', pts: [light] }); gmapLayer.getLayers()[0].openPopup(); });
      await page.locator('[data-map-open]').click(); await page.locator('#iMemo').waitFor({ state: 'attached' });
      assert.equal(await page.evaluate(() => gmap === null && ME.watch === null), true, 'opening the facility releases the map it came from');
      await stableSheet(page, '#iMemo', '#gmap');
      assert.equal(await page.evaluate(() => gmap === null && ME.watch === null), true);
    });
    await scenario('patrol dark point opens a populated registration form', async page => {
      const spot = await page.evaluate(() => { const l = S.lights.find(l => Number.isFinite(l.lat)); openPatrol('전체'); const spot = { lat: l.lat, lng: l.lng, acc: 8, at: Date.now(), near: l.code, nearD: 5 }; pt.spots = [spot]; ptFinish(); return spot; });
      await page.locator('[data-ptspotform]').click();
      assert.equal(Number(await page.locator('#nLat').inputValue()), spot.lat); assert.equal(Number(await page.locator('#nLng').inputValue()), spot.lng);
      await stableSheet(page, '#nLat', '#ptSumm');
    });
    for (const action of ['inbox', 'register', 'quick']) await scenario('scanner result opens ' + action + ' with camera cleanup', async page => {
      await page.evaluate(async action => {
        const light = S.lights.find(l => l.kind === '보안등' && l.num && Number.isFinite(l.lat));
        await openScanner(action === 'inbox' ? 'inbox' : 'admin'); stopCam(false);
        scan.pos = { lat: light.lat, lng: light.lng, acc: 8 };
        scan.found = { code: { kind: '보안등', dong: light.dong, num: action === 'inbox' ? light.num : action === 'quick' ? 987653 : 987654 }, kind: '보안등', how: 'plate', raw: '', plate: null };
        showScanResult(scan.found);
      }, action);
      await page.locator('[data-apply="' + action + '"]').click();
      const selector = action === 'inbox' ? '#ibNum' : action === 'register' ? '#nNum' : '#asecBody';
      if (action === 'quick') await page.waitForFunction(() => S.asec === 'pend');
      else assert.notEqual(await page.locator(selector).inputValue(), '');
      await stableSheet(page, selector);
      assert.equal(await page.evaluate(() => scan.stream == null), true);
    });
    await scenario('outbox resumes a paused patrol and phone Back shows its result', async page => {
      await page.evaluate(async () => {
        const light = S.lights.find(l => Number.isFinite(l.lat));
        await DGOffline.put('patrol', 'current', { sessionId: 'sheet-resume-patrol', start: Date.now(), end: null, dong: '전체', total: 1, track: [], passed: [], marks: [], spots: [{ lat: light.lat, lng: light.lng, acc: 8, at: Date.now() }], dist: 0, pos: null, last: null, heading: null, paused: true });
        openAdminSection('outbox');
      });
      await page.locator('[data-dg="recover-draft"][data-kind="patrol"]').click();
      await page.waitForFunction(() => pt.on && pt.paused && pt.sessionId === 'sheet-resume-patrol'); await page.waitForTimeout(200);
      assert.equal(await page.locator('#ptFull').isVisible(), true); assert.equal(await page.locator('#sheet').evaluate(el => el.classList.contains('open')), false);
      await page.goBack(); await page.locator('#ptSumm').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => !pt.on && pt.spots.length === 1), true);
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
