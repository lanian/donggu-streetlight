/* The installed app with its real service worker: first visit stores the shell, then with the network gone the app
   reopens from the cache with the registry and an inspection draft still there. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '..');
let down = false; // "network gone": the server drops every connection, so only the service worker's cache can answer
const server = http.createServer((req, res) => {
  // Browser checks always run the device (체험) mode: the deployed firebase-config.js points at the real project.
  if (req.url.split('?')[0].endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG = null;'); }
  if (down) { req.socket.destroy(); return; }
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  await context.addInitScript(() => { try { localStorage.setItem('dg-device', 'phone'); } catch (e) {} });
  // only other hosts are stubbed: the app's own requests must reach the service worker untouched
  await context.route(url => url.origin !== origin, route => route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { if (d.type() === 'beforeunload') return d.accept(); errors.push('native dialog: ' + d.message()); d.dismiss(); });
  const settle = async () => { await page.evaluate(() => { if (window.DGDialog && DGDialog.isOpen()) DGDialog.cancel(); if (NAV.stack.length) closeSheet('all'); }); await page.waitForFunction(() => !NAV.stack.length && !document.querySelector('#sheet').classList.contains('open')); };
  try {
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local');
    await page.waitForFunction(() => navigator.serviceWorker.controller || new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', () => r(true), { once: true })), null, { timeout: 30000 }).catch(async () => { await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 }); });
    checks.push('service worker stores the shell');
    const status = await page.evaluate(() => DongguPWA.check());
    assert.equal(status.shell, true, 'missing: ' + (status.missing || []).join(', ')); assert.equal(status.registry, true);
    assert.equal(status.version, /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'))[1]);
    const light = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat)).id);
    await page.evaluate(id => openLight(id), light); await page.locator('#iMemo').waitFor(); await page.locator('#iMemo').fill('오프라인 메모');
    for (let i = 0; i < 60 && !(await page.evaluate(async () => (await DGOffline.list('draft')).length)); i++) await page.waitForTimeout(250);
    assert.equal(await page.evaluate(async () => (await DGOffline.list('draft')).length), 1, 'the draft is kept on the device');

    checks.push('reopens offline from the cache');
    down = true;
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => typeof S !== "undefined" && S.live && S.lights.length > 8000, null, { timeout: 30000 }).catch(async e => { console.error('STATE', await page.evaluate(() => JSON.stringify({ hasS: !!window.S, live: window.S && S.live, n: window.S && S.lights.length, regErr: window.S && S.regErr, me: window.S && S.me, ready: document.readyState, body: document.body.innerText.slice(0, 200) })), errors); throw e; });
    await page.waitForFunction(() => DGOffline.ready && DGIntegration.initialized, null, { timeout: 30000 });
    const drafts = await page.evaluate(async () => (await DGOffline.list('draft')).map(d => d.value && d.value.memo));
    assert.deepEqual(drafts, ['오프라인 메모'], 'the inspection draft survived the offline reopen');
    down = false;

    assert.deepEqual(errors.filter(e => !/Failed to fetch|NetworkError|ERR_|network/i.test(e)), []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
