/* Security basics in the browser: libraries load from the app itself (vendor/), a Content Security Policy blocks scripts from
   any other host, and text from a citizen report (plate, issue, description) is shown as text — never run — when an
   administrator opens its location on the map. */
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
  try {
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); });

    // 1. libraries come from the app itself, and a Content Security Policy is in force
    checks.push('bundled libraries and CSP');
    assert.deepEqual(await page.evaluate(() => [!!window.jsQR, !!window.L, typeof qrcode]), [true, true, 'function']);
    assert.match(await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content), /object-src 'none'/);
    const blocked = await page.evaluate(() => new Promise(resolve => {
      document.addEventListener('securitypolicyviolation', e => resolve(e.blockedURI), { once: true });
      const s = document.createElement('script'); s.src = 'https://evil.example.com/x.js'; document.head.appendChild(s);
      setTimeout(() => resolve(null), 3000);
    }));
    assert.equal(blocked, 'https://evil.example.com/x.js');

    // 2. a citizen report whose plate text is markup shows as text on the report-location map, never runs
    checks.push('report text stays text on the map');
    const payload = '<img src=x onerror="window.__xss=1">';
    await page.evaluate(async code => {
      await db.collection('reports').add({ issue: '<b>꺼짐</b>', location: '', dong: '', code, lightId: null, desc: '<script>window.__xss=2</script>', via: 'QR 신고 페이지', receipt: '', contact: '', status: '접수', createdAt: Date.now(), reporterId: null, lat: 35.146, lng: 126.923 });
    }, payload);
    await page.waitForFunction(() => S.reports.some(r => r.lat === 35.146));
    const id = await page.evaluate(() => S.reports.find(r => r.lat === 35.146).id);
    await page.evaluate(id => { const b = document.createElement('button'); b.dataset.rmap = id; document.body.appendChild(b); b.click(); }, id);
    await page.locator('#sheet .sheet-head h3').waitFor();
    assert.match(await page.locator('#sheet .sheet-head h3').textContent(), /신고 위치 · <img src=x onerror/);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#sheet .sheet-head h3 img').count(), 0);

    assert.deepEqual(errors.filter(e => !/Content Security Policy|evil\.example/.test(e)), []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
