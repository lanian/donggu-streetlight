/* Version info: the footer names the release and the registry date, opens a 버전 정보 sheet with the app, offline copy,
   registry and storage facts plus recent changes, and copies a support summary. Lights marked 철거 are hidden from the
   list, search, map and counts, but stay reachable by id (history), in their own admin list, and through a search hint. */
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
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  const settle = async () => { await page.evaluate(() => { if (window.DGDialog && DGDialog.isOpen()) DGDialog.cancel(); if (NAV.stack.length) closeSheet('all'); }); await page.waitForFunction(() => !NAV.stack.length && !document.querySelector('#sheet').classList.contains('open')); };
    try {
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized && S.regMeta);
    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'inspect'; render(); });
    const sw = /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'))[1], short = /^v\d+/.exec(sw)[0];

    // 1. footer: release, date and registry date, on both home screens
    checks.push('footer names the release and registry date');
    const foot = await page.locator('.ver-foot [data-verinfo]').textContent();
    assert.match(foot, new RegExp('버전 ' + short + ' · \\d{4}-\\d{2}-\\d{2}')); assert.match(foot, /대장 2026-09-10 기준/);
    await page.evaluate(() => { S.tab = 'admin'; render(); });
    assert.equal(await page.locator('.ver-foot [data-verinfo]').count(), 1, 'admin home has the footer too');
    await page.evaluate(() => { S.tab = 'inspect'; render(); });

    // 2. the sheet: app version, offline copy (no worker here), registry counts, recent changes
    checks.push('version sheet facts');
    await page.locator('.ver-foot [data-verinfo]').click(); await page.locator('#verBody .ver-row').first().waitFor();
    assert.equal(await page.evaluate(() => NAV.stack.at(-1).key), 'verinfo');
    const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#verBody .ver-row')].map(r => [r.querySelector('.k').textContent, r.querySelector('.v').textContent])));
    assert.match(rows['앱 버전'], new RegExp(short + ' \\(' + sw + '\\)'));
    assert.match(rows['오프라인 저장'], /저장되지 않았|지원하지 않/);
    const counts = await page.evaluate(() => ({ all: S.allLights.length, live: S.lights.length, removed: S.allLights.filter(l => l.removed).length }));
    assert.ok(counts.removed > 0); assert.equal(counts.all - counts.live, counts.removed);
    assert.match(rows['가로등 대장'], new RegExp('2026-09-10 기준 · 사용 ' + counts.live.toLocaleString('en-US') + '개 · 철거 숨김 ' + counts.removed + '개'));
    assert.match(rows['저장 방식'], /이 기기에 보관/);
    assert.match(await page.locator('#verBody .ver-notes li.cur').textContent(), new RegExp(short));
    // 새 버전 확인 without a registered worker explains instead of claiming "latest"
    await page.locator('#verBody [data-vercheck]').click();
    await page.waitForFunction(() => /준비가 아직/.test(document.querySelector('#verBody').textContent));
    // a waiting update turns the row into an apply button
    await page.evaluate(() => { window.__r = DongguPWA.updateReady; DongguPWA.updateReady = () => true; verRefresh(); });
    assert.equal(await page.locator('#verBody [data-updapply]').count(), 1);
    await page.evaluate(() => { DongguPWA.updateReady = window.__r; verRefresh(); });

    // 3. support copy
    checks.push('support summary copied');
    await page.locator('#verBody [data-vercopy]').click();
    await page.waitForFunction(() => /복사했어요/.test(document.querySelector('#toast').textContent));
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, new RegExp('앱: ' + short)); assert.match(copied, /대장: 2026-09-10 기준/); assert.match(copied, /브라우저: /);
    await settle();

    // 4. 철거 lights: hidden from list, search, map; reachable by id; search hint; own admin list
    checks.push('removed lights are hidden but reachable');
    const gone = await page.evaluate(() => S.allLights.find(l => l.removed && l.kind === '가로등'));
    assert.equal(await page.evaluate(() => S.lights.some(l => l.removed)), false);
    assert.equal(await page.evaluate(id => byId(id) && byId(id).removed, gone.id), 1);
    await page.locator('#q').fill(gone.code); await page.waitForFunction(() => document.querySelector('.rm-hint'));
    assert.equal(await page.evaluate(id => !!document.querySelector('#listArea [data-light="' + id + '"]'), gone.id), false, 'not in the search results');
    assert.match(await page.locator('.rm-hint').textContent(), /철거된 등 \d+개/);
    await page.locator('.rm-hint [data-openremoved]').click();
    await page.waitForFunction(() => S.asec === 'removed' && document.querySelector('#rmList'));
    assert.equal(await page.locator('#rmQ').inputValue(), gone.code, 'the search carries over');
    assert.equal(await page.locator('#rmList [data-light="' + gone.id + '"]').count(), 1);
    await page.locator('#rmQ').fill(''); await page.waitForFunction(n => document.querySelectorAll('#rmList [data-light]').length === Math.min(60, n), counts.removed);
    assert.match(await page.locator('#rmCount').textContent(), new RegExp('전체 ' + counts.removed + '개'));
    // opening it shows the 철거 note (history stays reachable)
    await page.locator('#rmList [data-light="' + gone.id + '"]').first().click().catch(async () => { await page.evaluate(id => openLight(id), gone.id); });
    await page.waitForFunction(() => /철거된 등으로 기록/.test(document.querySelector('#sheet').textContent));
    await settle();
    // map and stats use the live list
    assert.equal(await page.evaluate(() => lightGrid().items.some(it => it.l.removed)), false);
    assert.equal(await page.evaluate(() => S.lights.filter(isDue).some(l => l.removed)), false);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, counts, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
