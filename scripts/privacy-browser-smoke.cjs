/* Reporter privacy: an inspector's report CSV has no contact or reporter position; a backup leaves reporter details out
   unless asked; a restore never brings back details already destroyed; marking a report 완료 asks before it erases the
   contact; the manual purge also clears the photo, position and an imported report's position text. */
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
    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); window.__saved = []; dl.save = async ({ filename, data }) => { window.__saved.push({ filename, text: typeof data === 'string' ? data : await data.text() }); }; });
    const add = r => page.evaluate(async r => (await db.collection('reports').add(r)).id, r);
    const base = { issue: '꺼짐', dong: '', code: '산수동 1', lightId: null, desc: '앞', via: 'QR 신고 페이지', receipt: 'R261104-0000ABCD', status: '접수', reporterId: null };
    const fresh = await add({ ...base, location: '', contact: '010-1111-2222', photo: 'data:image/jpeg;base64,AAAA', lat: 35.146, lng: 126.923, acc: 8, ext: 'qr-1', createdAt: Date.now() });
    const old = await add({ ...base, location: '35.1, 126.9 (±5m)', contact: '010-3333-4444', lat: 35.1, lng: 126.9, ext: 'qr-2', createdAt: Date.now() - 400 * 86400000 });
    await page.waitForFunction(() => S.reports.length >= 2);

    // 1. CSV: inspectors get no contact or reporter position; administrators do
    checks.push('report CSV columns by role');
    await page.evaluate(() => { S.demoRole = 'inspector'; }); await page.evaluate(() => exportReportsCSV());
    let csv = await page.evaluate(() => window.__saved.pop().text);
    assert.doesNotMatch(csv, /010-1111-2222|연락처|35\.146/);
    await page.evaluate(() => { S.demoRole = 'admin'; }); await page.evaluate(() => exportReportsCSV());
    csv = await page.evaluate(() => window.__saved.pop().text);
    assert.match(csv, /연락처/); assert.match(csv, /010-1111-2222/); assert.match(csv, /35\.146, 126\.923/);

    // 2. backup: reporter details out by default, in only when ticked
    checks.push('backup leaves reporter details out by default');
    await page.evaluate(() => backupExport()); await page.waitForFunction(() => window.__saved.length && !BK.busy);
    let backup = JSON.parse(await page.evaluate(() => window.__saved.pop().text));
    assert.equal(backup.personalData, false);
    const r1 = backup.collections.reports.find(r => r.ext === 'qr-1');
    assert.equal(r1.contact, undefined); assert.equal(r1.photo, undefined); assert.equal(r1.lat, undefined); assert.equal(r1.desc, '앞');
    await page.evaluate(() => { BK.pii = true; }); await page.evaluate(() => backupExport()); await page.waitForFunction(() => window.__saved.length && !BK.busy);
    backup = JSON.parse(await page.evaluate(() => window.__saved.pop().text));
    assert.equal(backup.personalData, true); assert.equal(backup.collections.reports.find(r => r.ext === 'qr-1').contact, '010-1111-2222');
    await page.evaluate(() => { BK.pii = false; });

    // 3. completing asks first when it would erase the contact
    checks.push('완료 asks before erasing the contact');
    await page.evaluate(id => { const b = document.createElement('button'); b.dataset.rstat = id; b.dataset.to = '완료'; document.body.appendChild(b); b.click(); }, fresh);
    await page.locator('#dgDialog:not([hidden])').waitFor(); assert.match(await page.locator('#dgDialog .dgdlg-msg').textContent(), /연락처를 지워요/);
    await page.locator('#dgDialog [data-dgdlg="cancel"]').click();
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(id => S.reports.find(r => r.id === id).status, fresh), '접수');
    assert.equal(await page.evaluate(id => S.reports.find(r => r.id === id).contact, fresh), '010-1111-2222');

    // 4. manual purge clears contact, photo, position and an imported report's position text, keeps the content
    checks.push('manual purge clears every reporter detail');
    const short = await add({ ...base, contact: 'short-period', createdAt: Date.now() - 60 * 86400000, privacyExpiresAt: Date.now() - 30 * 86400000 });
    await page.evaluate(async () => db.doc('citizen_reports/expired-original').set({ at: Date.now() - 120 * 86400000, privacyExpiresAt: Date.now() - 30 * 86400000, contact: 'original-contact', photo: 'data:image/jpeg;base64,AAAA', lat: 35.14, lng: 126.92, imported: false, issue: 'keep original issue' }));
    await page.evaluate(() => DGOperations.state.settings.privacyDays = 90);
    await page.evaluate(() => { const b = document.createElement('button'); b.dataset.mgmt = 'privacy-purge'; document.body.appendChild(b); b.click(); });
    await page.locator('#dgDialog:not([hidden])').waitFor(); assert.match(await page.locator('#dgDialog .dgdlg-msg').textContent(), /연락처·사진·신고 위치/);
    await page.locator('#dgDialog [data-dgdlg="ok"]').click();
    await page.waitForFunction(id => { const r = S.reports.find(x => x.id === id); return r && r.privacyPurgedAt; }, old, { timeout: 15000 });
    const purged = await page.evaluate(id => S.reports.find(r => r.id === id), old);
    assert.equal(purged.contact, ''); assert.equal(purged.lat, null); assert.equal(purged.location, ''); assert.equal(purged.desc, '앞');
    assert.equal(await page.evaluate(id => S.reports.find(r => r.id === id).contact, fresh), '010-1111-2222', 'a report still inside its period is untouched');
    assert.equal(await page.evaluate(async id => (await db.doc('reports/' + id).get()).data().contact, short), '');
    const original = await page.evaluate(async () => (await db.doc('citizen_reports/expired-original').get()).data());
    assert.equal(original.contact, ''); assert.equal(original.lat, null); assert.equal(original.imported, false); assert.equal(original.issue, 'keep original issue');

    // 5. a purged report restored from an older full backup does not get its details back
    checks.push('restore keeps destroyed details destroyed');
    const restoredRow = await page.evaluate(id => withoutReporter({ ...S.reports.find(r => r.id === id), contact: '010-3333-4444', lat: 35.1 }), old);
    assert.equal(restoredRow.contact, undefined); assert.equal(restoredRow.lat, undefined);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
