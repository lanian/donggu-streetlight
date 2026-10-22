/* Optional browser smoke: isolated profiles and a local server only.
   DONGGU_PLAYWRIGHT_MODULE=/path/to/playwright DONGGU_CHROMIUM=/path/to/chromium node scripts/field-browser-smoke.cjs */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
// waitForFunction treats an async predicate's Promise as truthy; poll its resolved value in Node.
async function poll(page, predicate, arg, label = 'asynchronous browser state') {
  const deadline = Date.now() + 30000;
  do {
    if (await page.evaluate(predicate, arg)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}
let revision = 'initial';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname) + (url.pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  if (file === path.join(root, 'sw.js')) { res.setHeader('Cache-Control', 'no-store'); return res.end(fs.readFileSync(file, 'utf8') + '\n// smoke revision: ' + revision); }
  res.end(fs.readFileSync(file));
});
const photo = { name: 'local-proof.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') };
const collect = async (browser, origin, serviceWorkers) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    // Remote scripts/fonts are empty so the actual vendored fallbacks execute. No backend requests leave the test.
    return route.fulfill({ status: 200, contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: '' });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.waitForFunction(() => typeof S !== 'undefined' && S.live);
  assert.equal(await page.evaluate(() => window.FIREBASE_CONFIG), null);
  return { context, page, errors };
};
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  try {
    const { context, page, errors } = await collect(browser, origin, 'block');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('[data-light]').first().click();
    const id = await page.evaluate(() => draft.lightId);
    await page.locator('#iMemo').fill('현장 사진·키보드 테스트');
    await page.locator('#iPhoto').setInputFiles(photo); await page.locator('#peOk').waitFor();
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('#ovl').hidden);
    assert.equal(await page.evaluate(() => draft.lightId), id);
    assert.equal(await page.locator('#iMemo').inputValue(), '현장 사진·키보드 테스트');
    assert.equal(await page.evaluate(() => document.querySelector('#sheet').contains(document.activeElement)), true);
    await page.locator('#iPhoto').setInputFiles([]); await page.locator('#iPhoto').setInputFiles(photo); await page.locator('#peOk').waitFor();
    await page.locator('#peOk').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'peX');
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'peOk');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#ovl').hidden);
    assert.equal(await page.evaluate(() => draft.lightId), id);
    await page.locator('#iPhoto').setInputFiles([]); await page.locator('#iPhoto').setInputFiles(photo); await page.locator('#peOk').waitFor();
    await page.locator('#peOk').click(); await page.waitForFunction(() => draft.photos.length === 1);
    assert.equal(await page.evaluate(() => draft.lightId), id);
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    assert.equal(await page.evaluate(id => DRAFTS[id].photos.length, id), 1);
    assert.equal(await page.evaluate(() => document.querySelector('.wrap').inert), false);
    assert.deepEqual(errors, []); await context.close();

    const pwa = await collect(browser, origin, 'allow');
    await pwa.page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const ready = await pwa.page.evaluate(() => DongguPWA.check());
    assert.equal(ready.shell, true); assert.equal(ready.registry, true); assert.equal(ready.ocr, false);
    await pwa.context.setOffline(true);
    const cold = await pwa.context.newPage(); cold.on('pageerror', e => pwa.errors.push(e.message));
    await cold.goto(origin); await cold.waitForFunction(() => typeof S !== 'undefined' && S.live);
    assert.equal(await cold.evaluate(() => S.lights.length > 5000 && typeof jsQR === 'function'), true);
    await cold.close(); await pwa.context.setOffline(false);
    await pwa.page.locator('[data-light]').first().click(); await pwa.page.locator('#iMemo').fill('새 버전 적용 중 보존할 초안');
    const draftId = await pwa.page.evaluate(() => draft.lightId);
    await pwa.page.keyboard.press('Escape'); await pwa.page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    revision = 'updated'; await pwa.page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await poll(pwa.page, async () => !!(await navigator.serviceWorker.getRegistration())?.waiting, undefined, 'an installed service-worker update');
    assert.equal(await pwa.page.evaluate(() => DongguPWA.applyUpdate()), false);
    assert.equal(await pwa.page.evaluate(id => DRAFTS[id].memo, draftId), '새 버전 적용 중 보존할 초안');
    assert.deepEqual(pwa.errors, []); await pwa.context.close();
    console.log(JSON.stringify({ photoBack: 'keeps owning inspection', photoSave: 'one photo retained', keyboard: 'Tab/Shift+Tab/Escape and focus restore passed', offlineColdStart: 'registry + QR available, OCR incomplete correctly displayed', update: 'unsaved draft blocked activation', browserErrors: [] }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
