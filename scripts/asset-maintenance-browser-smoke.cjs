/* Local-only physical topology, group recovery and component history UI. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const files = ['app/asset-maintenance-core.js', 'app/asset-maintenance-commands.js', 'app/asset-maintenance.js'];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/firebase-config.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG=null;'); }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  let content = fs.readFileSync(file);
  if (file === path.join(root, 'index.html')) { let html = content.toString(); const missing = files.filter(name => !html.includes('src="' + name + '"')); html = html.replace('<script src="app/staff-app.js"></script>', missing.map(name => '<script src="' + name + '"></script>').join('') + '<script src="app/staff-app.js"></script>'); content = html; }
  res.end(content);
});
const poll = async (page, fn, arg) => { for (let i = 0; i < 150; i++) { if (await page.evaluate(fn, arg)) return; await page.waitForTimeout(50); } throw new Error('Expected asset state not reached'); };
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.DONGGU_CHROMIUM || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/css' }));
  const page = await context.newPage(), errors = [], checks = []; page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => new MutationObserver(() => { const ok = document.querySelector('#dgDialog:not([hidden]) [data-dgdlg="ok"]'); if (ok) ok.click(); }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] }));
  try {
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local');
    await page.evaluate(async () => {
      await DGIntegration.whenReady(); S.demoRole = 'admin';
      window.assetTestAttach = () => DGAssetMaintenance.attach({ esc, fmtDT, can, state: () => S, firebase: () => FB && FB.fs, database: () => db, byId, readAll: (...args) => listAllRecords(...args), render, toast,
        navigate: (html, route) => { if (route) navRoute(route.key, route.reopen, route); openSheet(html); }, navGen, navAlive, closeSheet, openLight });
      assetTestAttach(); await DGAssetMaintenance.open();
      window.assetLights = S.lights.filter(l => !l.removed).slice(0, 2).map(l => l.id);
    });
    await page.locator('[data-am="new-cabinet"]').click();
    await page.locator('#amCode').fill('CAB-UI'); await page.locator('#amLabel').fill('동명 실제 분전함'); await page.locator('#amDong').fill('동명동');
    await page.locator('[data-am="save"]').click();
    await poll(page, async () => (await db.readAll('cabinets')).length === 1);
    const cabinetId = await page.evaluate(async () => (await db.readAll('cabinets'))[0].id);
    await page.evaluate(() => DGAssetMaintenance.open()); await page.locator('[data-am="new-circuit"]').click();
    await page.locator('#amCabinet').selectOption(cabinetId); await page.locator('#amCode').fill('C-UI'); await page.locator('#amLabel').fill('북측 실제 회로');
    // Hold the confirmed save before its draft cleanup/cache reload. A user may open
    // the next editor as soon as the circuit is committed, before this follow-up finishes.
    await page.evaluate(() => {
      const get = DGOffline.get, remove = DGOffline.removeIfCurrent;
      window.circuitRace = { draftId: DGAssetMaintenance.state.draft.storageId, held: false, cleaned: false, release: null, get, remove };
      DGOffline.get = async (...args) => {
        const value = await get(...args);
        if (args[0] === 'assetDraft' && args[1] === circuitRace.draftId && value?.pending && !circuitRace.held) {
          circuitRace.held = true; return new Promise(resolve => { circuitRace.release = () => resolve(value); });
        }
        return value;
      };
      DGOffline.removeIfCurrent = async (...args) => {
        const value = await remove(...args);
        if (args[0] === 'assetDraft' && args[1] === circuitRace.draftId) circuitRace.cleaned = true;
        return value;
      };
    });
    await page.locator('[data-am="save"]').click(); await poll(page, async () => (await db.readAll('circuits')).length === 1);
    await poll(page, () => circuitRace.held);
    const circuitId = await page.evaluate(async () => (await db.readAll('circuits'))[0].id);
    for (const lightId of await page.evaluate(() => assetLights)) {
      await page.evaluate(id => DGAssetMaintenance.edit('link', id, { lightId: id }), lightId);
      await page.locator('#amCabinet').selectOption(cabinetId);
      assert.equal(await page.locator('#amCircuit option').evaluateAll((options, id) => options.some(option => option.value === id), circuitId), true, 'A committed circuit must be selectable before the earlier save finishes draft cleanup');
      await page.locator('#amCircuit').selectOption(circuitId);
      await page.locator('#amConfirmation').fill('현장 연결 대장으로 확인');
      if (await page.evaluate(() => !!circuitRace.release)) {
        const token = await page.locator('#amForm').getAttribute('data-token');
        await page.evaluate(async () => { await DGAssetMaintenance.persistActive(); const release = circuitRace.release; circuitRace.release = null; release(); });
        await poll(page, () => circuitRace.cleaned && !DGAssetMaintenance.state.loading);
        assert.equal(await page.locator('#amForm').getAttribute('data-token'), token, 'Late save refresh cannot replace the new link editor');
        assert.equal(await page.locator('#amCabinet').inputValue(), cabinetId);
        assert.equal(await page.locator('#amCircuit').inputValue(), circuitId);
        assert.equal(await page.locator('#amConfirmation').inputValue(), '현장 연결 대장으로 확인');
        assert.equal(await page.locator('#amConfirmation').evaluate(el => el === document.activeElement), true);
        await page.evaluate(() => { DGOffline.get = circuitRace.get; DGOffline.removeIfCurrent = circuitRace.remove; });
        checks.push('a committed circuit is available during delayed save cleanup and late refresh preserves the active link draft and focus');
      }
      await page.locator('[data-am="save"]').click();
      await poll(page, async id => (await db.doc('assetLinks/' + id).get()).exists, lightId);
    }
    assert.equal(await page.evaluate(() => DGAssetMaintenance.circuitOf(assetLights[0])), circuitId);
    checks.push('confirmed cabinet/circuit and explicit facility links never use switch type as identity');

    await page.evaluate(() => DGAssetMaintenance.open()); await page.locator('[data-am="new-replacement"]').click();
    await page.locator('#amLight').fill(await page.evaluate(() => assetLights[0])); await page.locator('#amComponent').selectOption('lamp'); await page.locator('#amModel').fill('LED-NEW'); await page.locator('#amNote').fill('새 램프 교체');
    await page.locator('[data-am="save"]').click(); await poll(page, async () => (await db.readAll('assetReplacements')).length === 1);
    const replacement = await page.evaluate(async () => (await db.readAll('assetReplacements'))[0]); assert.equal(replacement.model, 'LED-NEW');
    assert.equal(await page.evaluate(async () => (await db.readAll('inventoryMoves')).length), 0);
    checks.push('component replacement retains independent immutable history without stock movement');

    await page.evaluate(() => DGAssetMaintenance.open()); await page.locator('[data-am="new-incident"]').click();
    await page.locator('#amTitle').fill('두 시설 동시 소등'); await page.locator('#amCabinet').selectOption(cabinetId); await page.locator('#amCircuit').selectOption(circuitId);
    for (const id of await page.evaluate(() => assetLights)) await page.locator('[data-am-pick="' + id + '"]').check();
    await page.locator('[data-am="save"]').click(); await poll(page, async () => (await db.readAll('outageIncidents')).length === 1);
    const incidentId = await page.evaluate(async () => (await db.readAll('outageIncidents'))[0].id);
    await page.evaluate(id => DGAssetMaintenance.edit('incident', id), incidentId);
    await page.locator('#amStatus').selectOption('resolved'); await page.locator('#amResolution').fill('두 시설 현장 복구 확인');
    await page.locator('[data-am="save"]').click(); assert.equal(await page.evaluate(async id => (await db.doc('outageIncidents/' + id).get()).data().status, incidentId), 'open');
    for (const id of await page.evaluate(() => assetLights)) await page.locator('[data-am-confirm="' + id + '"]').check();
    await page.locator('[data-am="save"]').click(); await poll(page, async id => (await db.doc('outageIncidents/' + id).get()).data().status === 'resolved', incidentId);
    checks.push('group outage closes only after explicit restoration of every facility');

    await page.evaluate(() => DGAssetMaintenance.edit('cabinet', null)); await page.locator('#amCode').fill('DRAFT'); await page.locator('#amLabel').fill('복구할 분전함 초안');
    await poll(page, async () => (await DGOffline.list('assetDraft')).some(d => d.value.data.label === '복구할 분전함 초안'));
    const draftId = await page.evaluate(async () => (await DGOffline.list('assetDraft')).find(d => d.value.data.label === '복구할 분전함 초안').id);
    await page.reload(); await page.waitForFunction(() => S.live && DGOffline.ready); await page.evaluate(async id => { await DGIntegration.whenReady(); S.demoRole = 'admin'; if (!DGAssetMaintenance.state.attached) throw new Error('Root should attach assets after module integration'); await DGAssetMaintenance.resumeDraft(id); }, draftId);
    assert.equal(await page.locator('#amLabel').inputValue(), '복구할 분전함 초안');
    await page.locator('[data-am="discard-draft"]').click(); await poll(page, async id => !(await DGOffline.get('assetDraft', id)), draftId);
    checks.push('unsaved topology draft survives reload and explicit discard removes only that draft');
    await page.evaluate(() => DGAssetMaintenance.open());
    await page.screenshot({ path: path.join(process.env.TEMP || process.env.TMP || root, 'streetlight-v61-assets.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, browserErrors: errors }, null, 2));
  } catch (error) { console.error(await page.locator('#sheetIn').innerText().catch(() => '')); throw error; }
  finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
