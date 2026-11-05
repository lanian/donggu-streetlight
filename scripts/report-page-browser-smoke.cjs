/* Citizen report page: the plate box checks a typed number against the public registry (spacing, dash shape, leading
   zeros and a missing "동" do not matter) and links the chosen light; a report filed from outside the district goes
   through without the position. The Firestore write is intercepted — nothing reaches a real project. */
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', geolocation: { latitude: 37.5665, longitude: 126.978, accuracy: 10 }, permissions: ['geolocation'] });
  await context.addInitScript(() => { try { localStorage.setItem('dg-device', 'phone'); } catch (e) {} });
  const filed = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    if (url.startsWith('https://firestore.googleapis.com/')) { filed.push({ url, body: JSON.parse(route.request().postData() || '{}') }); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
    return route.fulfill({ status: 200, body: '', contentType: url.includes('.js') ? 'text/javascript' : 'text/plain' });
  });
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  try {
    await page.goto(origin + '/report/');
    await page.waitForFunction(() => /동구 밖/.test(document.querySelector('#gpsState').textContent), null, { timeout: 15000 });

    checks.push('plate lookup tolerates how people type it');
    const reg = JSON.parse(fs.readFileSync(path.join(root, 'data/lights.json'), 'utf8')), at = k => reg.cols.indexOf(k);
    const padded = reg.rows.find(r => !r[at('removed')] && /^[가-힣]+동 0\d+$/.test(r[at('code')] || ''));
    const dashed = reg.rows.find(r => !r[at('removed')] && /^\d+-\d+$/.test(r[at('code')] || ''));
    const [dong, num] = padded[at('code')].split(' ');
    await page.locator('#codeIn').fill(dong.replace(/동$/, '') + ' ' + String(+num));
    await page.locator('#codeHint .pick button').first().waitFor();
    const options = await page.locator('#codeHint .pick button b').allTextContents();
    assert.ok(options.includes(padded[at('code')]), options.join(', '));
    await page.locator('#codeHint .pick button', { hasText: padded[at('code')] }).first().click();
    assert.equal(await page.locator('#codeText').textContent(), padded[at('code')]);
    assert.equal(await page.locator('#codeConfirmed').isVisible(), true);
    assert.equal(await page.evaluate(() => st.lightId), padded[at('id')]);

    await page.locator('#codeEdit').click();
    const [a, b] = dashed[at('code')].split('-');
    await page.locator('#codeIn').fill(a + ' - ' + b);
    await page.locator('#codeHint .pick button').first().waitFor();
    assert.equal(await page.locator('#codeHint .pick button b').first().textContent(), dashed[at('code')]);
    await page.locator('#codeIn').fill('없는번호 99999');
    await page.waitForFunction(() => /찾지 못했어요/.test(document.querySelector('#codeHint').textContent));

    checks.push('filed from outside the district: no position, still received');
    await page.locator('#codeIn').fill(dashed[at('code')]); await page.locator('#codeHint .pick button').first().click();
    await page.locator('#issues button').first().click();
    await page.locator('#send').click(); await page.locator('#done:not([hidden])').waitFor();
    assert.equal(filed.length, 1);
    const f = filed[0].body.fields;
    assert.equal('lat' in f, false); assert.equal(f.lightId.stringValue, dashed[at('id')]); assert.equal(f.code.stringValue, dashed[at('code')]);
    assert.match(await page.locator('#receipt').textContent(), /^R\d{6}-[0-9A-F]{8}$/);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
