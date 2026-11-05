/* New QR reports: with staff signed in to Firebase, 관리 현황 shows "새 QR 신고 N건" from a server count (no content read),
   and opening 신고함 brings them in. Firebase is stood in for by a counting stub; the import itself is covered elsewhere. */
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

    checks.push('a count of waiting QR reports is shown and opening the inbox imports them');
    await page.evaluate(() => {
      window.__counted = 0; window.__imported = 0; window.__waiting = 3;
      const query = { where: () => query, count: () => ({ get: async () => { window.__counted++; return { data: () => ({ count: window.__waiting }) }; } }) };
      FB = { auth: { currentUser: { uid: 'admin-test' } }, fs: { collection: () => query } };
      importCitizenReports = async () => { window.__imported++; window.__waiting = 0; QRNEW.n = 0; render(); };
      QRNEW.at = 0; render();
    });
    await page.waitForFunction(() => QRNEW.n === 3);
    await page.locator('.todaystrip button', { hasText: '새 QR 신고' }).waitFor();
    assert.equal(await page.locator('.todaystrip button', { hasText: '새 QR 신고' }).locator('b').textContent(), '3');
    const counts = await page.evaluate(() => window.__counted);
    await page.evaluate(() => render()); assert.equal(await page.evaluate(() => window.__counted), counts, 'not re-counted on every redraw');
    await page.locator('.todaystrip button', { hasText: '새 QR 신고' }).click();
    await page.waitForFunction(() => window.__imported === 1);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.todaystrip button', { hasText: '새 QR 신고' }).count(), 0);
    await page.evaluate(() => { FB = null; });

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
