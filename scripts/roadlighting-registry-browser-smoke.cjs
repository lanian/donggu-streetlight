/* Safe provider-scoped registry updates in the real app. No production backend or external requests. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.endsWith('/firebase-config.js')) return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('window.FIREBASE_CONFIG=null;');
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function seed(page) {
  return page.evaluate(async () => {
    S.demoRole = 'admin'; S.tab = 'admin';
    const target = BASE.find(row => DGRoadlightingRegistry.isRoadlighting(row) && row.code && row.dong && row.code.replace(/\s/g, '').startsWith(row.dong) && !row.removed && !row.noPlate);
    const missing = BASE.find(row => DGRoadlightingRegistry.isRoadlighting(row) && row.id !== target.id);
    const other = BASE.find(row => !DGRoadlightingRegistry.isRoadlighting(row));
    Object.assign(target, { addr: '연계 테스트 보존 주소', mgmt: '연계 테스트 관리기관', posApprox: true, lampType: '대장 원래 광원' });
    const native = { lamp_id: target.lampId, label_no: target.label || target.code, latitude: target.lat + .00001, longitude: target.lng, facility_class: target.kind, lampName: '운영에서 변경한 광원' };
    await db.doc('lights/' + target.id).set({ lampType: '현장에서 수정한 광원', status: '고장', note: '보존할 현장 메모' }, { merge: true });
    await db.doc('inspections/v67-registry-linked-inspection').set({ lightId: target.id, code: target.code, date: Date.now(), result: '고장', memo: '대장 적용 후에도 보존할 점검' });
    window.__registryFixture = { target, missing, other, native };
    window.__registryOriginalDB = db;
    return { id: target.id, missing: missing.id, other: other.id, others: BASE.filter(row => !DGRoadlightingRegistry.isRoadlighting(row)).length, native };
  });
}
async function upload(page, rows, name = 'getPoint.json') {
  await page.evaluate(() => openAdminSection('registryupdate'));
  await page.locator('#dgRegistryFile').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ DATA: rows })) });
  await page.waitForFunction(() => !!DGManagement.state.registry || !!DGManagement.state.registryError);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.DONGGU_CHROMIUM ? { executablePath: process.env.DONGGU_CHROMIUM } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const results = [], errors = [];
  async function scenario(name, run) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().resourceType() === 'script' ? 'text/javascript' : 'text/css' }));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(name + ': ' + error.message));
    try {
      await page.goto(origin); await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGIntegration.initialized && typeof DGRoadlightingRegistry !== 'undefined');
      assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null);
      await run(page); results.push(name);
    } finally { await context.close(); }
  }
  try {
    await scenario('native provider preview and local apply preserve other providers, unprovided fields, field edits and linked history', async page => {
      const f = await seed(page);
      const before = await page.evaluate(async ({ missing, other }) => {
        const get = async id => { const snap = await db.doc('lights/' + id).get(); return snap.exists ? snap.data() : null; };
        return { missing: await get(missing), other: await get(other) };
      }, f);
      const added = { lamp_id: 'v67-new-registry-001', label_no: '동명동 연계 새등', latitude: 35.15, longitude: 126.93, facility_class: '보안등' };
      await upload(page, [f.native, added]);
      const diff = await page.evaluate(() => DGManagement.state.registry);
      assert.equal(diff.scope, 'roadlighting-gjd'); assert.equal(diff.retainedOtherCount, f.others);
      assert.equal(diff.missing.some(row => row.id === f.other), false);
      assert.equal(diff.changed.some(row => row.changes.addr || row.changes.posApprox), false);
      assert.equal(await page.locator('#dgRemoveMissing').isDisabled(), true);
      assert.equal(await page.locator('#dgKeepOverrides').isChecked(), true);
      await page.locator('[data-mgmt="registry-apply"]').click(); await page.locator('#dgDialog:not([hidden]) [data-dgdlg="ok"]').click();
      await page.waitForFunction(() => DGManagement.state.registry === null);
      const after = await page.evaluate(async ({ id, missing, other }) => {
        const get = async value => { const snap = await db.doc('lights/' + value).get(); return snap.exists ? snap.data() : null; };
        return { target: await get(id), visible: byId(id), missing: await get(missing), other: await get(other), newLight: await get('pv67-new-registry-001'), linked: (await db.doc('inspections/v67-registry-linked-inspection').get()).data() };
      }, f);
      assert.equal(after.target.lampType, '현장에서 수정한 광원'); assert.equal(after.target.status, '고장'); assert.equal(after.target.note, '보존할 현장 메모');
      assert.equal(after.target.lat, Number(f.native.latitude.toFixed(7))); assert.equal(after.target.registryValues.addr, '연계 테스트 보존 주소');
      assert.equal(after.target.registryValues.posApprox, true); assert.equal(after.visible.posApprox, true);
      assert.equal(after.visible.addr, '연계 테스트 보존 주소'); assert.equal(after.visible.mgmt, '연계 테스트 관리기관');
      assert.deepEqual(after.missing, before.missing); assert.deepEqual(after.other, before.other);
      assert.equal(after.newLight.lampId, added.lamp_id); assert.equal(after.newLight.kind, '보안등'); assert.equal(after.linked.lightId, f.id);
      await upload(page, [f.native, added]);
      const same = await page.evaluate(() => DGManagement.state.registry);
      assert.equal(same.added.length, 0); assert.equal(same.changed.length, 0); assert.equal(same.unchanged, 2);
    });
    await scenario('a rejected incomplete file leaves no applicable preview and an explicit retry succeeds', async page => {
      const f = await seed(page); await page.evaluate(() => openAdminSection('registryupdate'));
      await page.locator('#dgRegistryFile').setInputFiles({ name: 'partial.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ DATA: [f.native], hasMore: true })) });
      await page.waitForFunction(() => !!DGManagement.state.registryError);
      assert.equal(await page.locator('[data-mgmt="registry-apply"]').count(), 0);
      await upload(page, [f.native]); assert.equal(await page.locator('[data-mgmt="registry-apply"]').isEnabled(), true);
    });
    for (const change of ['navigation', 'account', 'database', 'role']) {
      await scenario('a delayed native file cannot publish after ' + change + ' changes', async page => {
        await seed(page); await page.evaluate(() => openAdminSection('registryupdate'));
        await page.evaluate(() => {
          window.__filePromise = DGManagement.registryFile({ name: 'delayed.json', size: 100, text: () => new Promise(resolve => { window.__releaseFile = resolve; }) });
        });
        await page.evaluate(change => {
          if (change === 'navigation') openAdminSection('report');
          if (change === 'account') S.me = 'different-account';
          if (change === 'database') db = Object.create(db);
          if (change === 'role') S.demoRole = 'inspector';
          __releaseFile(JSON.stringify({ DATA: [__registryFixture.native] }));
        }, change);
        await page.evaluate(() => __filePromise);
        assert.equal(await page.evaluate(() => DGManagement.state.registry), null);
      });
    }
    for (const change of ['database', 'role']) {
      await scenario('confirmation does not enqueue a comparison after ' + change + ' changes', async page => {
        const f = await seed(page); await upload(page, [f.native]);
        await page.evaluate(() => { const submit = DGOffline.submit; window.__registrySubmits = 0; DGOffline.submit = function (...args) { __registrySubmits++; return submit.apply(this, args); }; });
        await page.locator('[data-mgmt="registry-apply"]').click(); await page.locator('#dgDialog:not([hidden])').waitFor();
        await page.evaluate(change => { if (change === 'database') db = Object.create(db); else S.demoRole = 'inspector'; }, change);
        await page.locator('#dgDialog:not([hidden]) [data-dgdlg="ok"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-mgmt="registry-apply"]')?.disabled);
        assert.equal(await page.evaluate(() => __registrySubmits), 0);
      });
    }
    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
