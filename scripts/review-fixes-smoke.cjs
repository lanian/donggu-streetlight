/* Actual browser regressions for report completeness and point-only field records. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname) + (url.pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function poll(page, predicate, arg) {
  const until = Date.now() + 30000;
  do { if (await page.evaluate(predicate, arg)) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < until);
  throw new Error('Timed out waiting for the field workflow');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.DONGGU_CHROMIUM ? { executablePath: process.env.DONGGU_CHROMIUM } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const results = [], errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/css', body: '' }));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGIntegration.initialized);
    await page.evaluate(photo => {
      const light = S.lights[0], now = Date.now(), date = new Date(now);
      REP.period = 'custom'; REP.from = date.getFullYear() + '-01-01'; REP.to = date.getFullYear() + '-12-31'; REP.dong = '전체'; REP.photos = true; REP.inlinePh = false;
      REP.data = { key: reportQueryKey(), at: now, patrols: [], insp: Array.from({ length: 120 }, (_, n) => {
        const id = 'report-photo-' + n; GAL[id] = { id, lightId: light.id, data: photo, label: '현장', at: now - n * 1000, by: S.me };
        return { id: 'report-inspection-' + n, lightId: light.id, code: light.code, dong: light.dong, date: now - n * 1000, result: '고장', inspector: S.me, checks: {}, thumbs: [{ id, label: '현장', t: photo }] };
      }) };
      REP.err = ''; REP_PH.scope = 'all'; REP_PH.size = 'm'; S.tab = 'admin'; render(); openAdminSection('report');
    }, image);
    await page.waitForFunction(() => !REP_PH.loading);
    assert.match(await page.locator('#repPhotoAppendix').textContent(), /선택 전체 120장/);
    assert.equal(await page.locator('#repPhotoAppendix img').count(), 48);
    await page.locator('[data-repph-page="1"]').click(); await page.waitForFunction(() => !REP_PH.loading);
    assert.equal(await page.locator('#repPhotoAppendix img').count(), 48);
    await page.locator('[data-repph="size"][data-v="l"]').click(); await page.waitForFunction(() => !REP_PH.loading);
    assert.equal(await page.locator('#repPhotoAppendix img').count(), 24);
    await page.evaluate(() => { window.print = () => { const root = document.querySelector('#reportPrintRoot'); window.__printed = { photos: root.querySelectorAll('#repPhotoAppendix img').length, text: root.textContent, visible: document.body.classList.contains('dg-report-printing') }; }; });
    await page.locator('#repPrint').click(); await page.waitForFunction(() => window.__printed);
    const printed = await page.evaluate(() => window.__printed);
    assert.equal(printed.photos, 120); assert.equal(printed.visible, true); assert.match(printed.text, /선택 전체 120장/);
    assert.doesNotMatch(printed.text, /100 \/ 120/);
    await page.emulateMedia({ media: 'print' }); assert.equal(await page.locator('#reportPrintRoot').isVisible(), true);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint'))); await page.emulateMedia({ media: 'screen' });
    assert.equal(await page.locator('#reportPrintRoot').count(), 0);
    results.push('120 photos and all fault rows survive preview pagination and large-size complete printing');

    await page.evaluate(() => {
      ptReset(); const now = Date.now();
      Object.assign(pt, { on: false, start: now - 60000, end: now, dong: '전체', dist: 0, passed: new Map(), marks: [], spots: [{ lat: 35.14, lng: 126.93, at: now - 1000, acc: 5, near: '', nearD: null }], track: [] });
      openSheet('<div class="sheet-head"><h3>순찰 결과</h3></div><div id="ptSumm"></div>'); ptSummary();
    });
    assert.equal(await page.locator('#ptSave').isEnabled(), true);
    await page.locator('#ptSave').click();
    await poll(page, async () => (await listAllRecords('patrols')).some(patrol => patrol.spots?.length === 1 && patrol.marks?.length === 0 && patrol.passed?.length === 0));
    results.push('a patrol containing only an unregistered dark location saves its evidence');

    await page.evaluate(() => { window.__originalReadPage = DGData.readPage; window.__auditReads = 0; DGData.readPage = async (db, col, options) => { if (col === 'workEvents') { window.__auditReads++; throw new Error('permission-denied-test'); } return window.__originalReadPage(db, col, options); }; openAdminSection('audit'); });
    await page.getByText(/permission-denied-test/).waitFor();
    await page.evaluate(() => { for (let n = 0; n < 8; n++) refreshAdminSection(); });
    assert.equal(await page.evaluate(() => window.__auditReads), 1);
    await page.locator('[data-mgmt="audit-refresh"]').click(); await page.waitForFunction(() => window.__auditReads === 2);
    await page.evaluate(() => { DGData.readPage = window.__originalReadPage; openAdminSection('health'); });
    await page.getByText(/공유 운영 서버가 연결되지/).waitFor();
    results.push('audit permission errors wait for an explicit retry and unconfigured shared health is never presented as healthy');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
