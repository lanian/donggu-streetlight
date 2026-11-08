/* Ledger connector preparation only: injected synthetic pages, no live service or Firebase. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DONGGU_LEDGER_ROOT || path.join(__dirname, '..'));
const cols = ['id', 'kind', 'code', 'dong', 'lampType', 'lat', 'lng', 'lampId', 'removed'];
const registry = { cols, count: 6, rows: [
  ['official-fixture-0007', '가로등', '합성 표찰 0007', '지산동', 'LED일반형', 35.14, 126.93, '0007', false],
  ['official-fixture-7', '가로등', '합성 표찰 7', '지산동', 'LED일반형', 35.1401, 126.9301, '7', false],
  ['official-fixture-dup-a', '가로등', '합성 중복 A', '지산동', 'LED일반형', 35.1402, 126.9302, 'DUPE', false],
  ['official-fixture-dup-b', '가로등', '합성 중복 B', '지산동', 'LED일반형', 35.1403, 126.9303, 'DUPE', false],
  ['official-fixture-removed', '가로등', '합성 철거', '지산동', 'LED일반형', 35.1404, 126.9304, 'REMOVED', true],
  ['official-fixture-zero', '가로등', '합성 표찰 0', '지산동', 'LED일반형', 35.1405, 126.9305, '0', false]
] };
const sample = (external_report_id = 'SYNTHETIC-001', extra = {}) => ({ external_report_id, lamp_id: '0007', issue: 'off', received_at: '2026-11-08T11:00:00+09:00', status: 'received', ...extra });
const jsonFile = rows => JSON.stringify({ schemaVersion: 1, reports: rows });
const privateValues = ['PRIVATE-CONTACT-010-TEST', 'PRIVATE-NAME-TEST', 'PRIVATE-FREE-TEXT-TEST', 'PRIVATE-PHOTO-TEST'];
const server = http.createServer((req, res) => {
  if (req.url.split('?')[0].endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG=null;'); }
  let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { return res.writeHead(400).end(); }
  const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function poll(page, fn, arg, label) {
  const until = Date.now() + 20000;
  do { if (await page.evaluate(fn, arg)) return; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < until);
  throw new Error('Timed out: ' + label);
}
(async () => {
  const results = [], errors = [], mutations = [], operatingRequests = []; let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://localhost:' + server.address().port;
  try {
    browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
    async function scenario(name, run) {
      if (process.env.DONGGU_LEDGER_CASE && !name.includes(process.env.DONGGU_LEDGER_CASE)) return;
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.hostname === 'gjd.roadlighting.kr') operatingRequests.push({ method: request.method(), path: url.pathname });
        if (request.method() !== 'GET') { mutations.push({ method: request.method(), path: url.pathname }); return route.abort(); }
        if (url.origin !== origin) return route.fulfill({ status: 200, body: '', contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/plain' });
        if (url.pathname === '/data/lights.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(registry) });
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(name + ': ' + error.message));
      page.on('dialog', dialog => { errors.push(name + ': native dialog ' + dialog.type()); return dialog.dismiss(); });
      await context.addInitScript(() => {
        localStorage.setItem('dg-device', 'phone');
        new MutationObserver(() => { const ok = document.querySelector('#dgDialog:not([hidden]) [data-dgdlg="ok"]'); if (ok) ok.click(); }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
      });
      try {
        await page.goto(origin);
        await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGOffline.ready && DGIntegration.initialized);
        assert.equal(await page.evaluate(() => DGIntegration.whenReady()), true);
        assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null); assert.equal(await page.evaluate(() => S.me), 'local');
        await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); openAdminSection('officialreports'); });
        await run({ page, context });
        results.push(name); console.log('PASS: ' + name);
      } finally { await context.close(); }
    }
    const reports = page => page.evaluate(() => db.readAll('reports'));
    const selected = page => page.locator('[data-oir-select]:checked').count();
    async function file(page, contents, format = 'json', expectedId) {
      await page.locator('#oirFile').setInputFiles({ name: 'synthetic-reports.' + format, mimeType: format === 'json' ? 'application/json' : 'text/csv', buffer: Buffer.from(contents) });
      await poll(page, expected => {
        const s = DGOfficialReportImport.state;
        return !s.busy && s.preview && (!expected || s.rows.some(row => row.externalId === expected));
      }, expectedId, 'file preview prepared');
    }
    const load = (page, rows) => file(page, jsonFile(rows), 'json', rows[0]?.external_report_id);
    async function apply(page, count) {
      await page.locator('#oirApply').click();
      await poll(page, async count => !DGOfficialReportImport.state.busy && (await db.readAll('reports')).length === count, count, 'local report import');
    }
    const days = async page => {
      await page.locator('#oirLedgerFrom').fill('2026-11-09');
      await page.locator('#oirLedgerTo').fill('2026-11-09');
    };
    async function demo(page) {
      await days(page); await page.locator('#oirLedgerDemo').click();
      await poll(page, () => !DGOfficialReportImport.state.busy && DGOfficialReportImport.state.preview?.rows.length === 2, null, 'complete synthetic ledger preview');
    }
    async function prepareGate(page) {
      await page.evaluate(() => {
        window.__ledgerOriginalFixture ||= DGOfficialLedgerConnector.createFixture;
        window.__ledgerGate = { calls: 0, started: false, release: null, signal: null };
        DGOfficialLedgerConnector.createFixture = options => {
          const fixture = __ledgerOriginalFixture(options);
          return { ...fixture, readPage: async input => {
            __ledgerGate.calls++; const response = await fixture.readPage(input);
            if (__ledgerGate.calls === 2) {
              __ledgerGate.started = true; __ledgerGate.signal = input.signal;
              return new Promise(resolve => { __ledgerGate.release = () => resolve(response); });
            }
            return response;
          } };
        };
      });
      await days(page); await page.locator('#oirLedgerDemo').click();
      await poll(page, () => __ledgerGate.started, null, 'second synthetic ledger page held');
    }
    await scenario('ledger connection remains explicitly unconfigured without a real service request', async ({ page }) => {
      assert.equal(await page.locator('#oirLedgerPanel').count(), 1, 'The ledger connector preparation panel must exist.');
      assert.equal(await page.locator('#oirLedgerQuery').isDisabled(), true);
      assert.match(await page.locator('#oirLedgerConnection').textContent(), /미등록|명세|미연결/);
      assert.equal(await page.locator('#oirLedgerDemo').isEnabled(), true);
      assert.match(await page.locator('#oirLedgerPanel').textContent(), /합성/);
      assert.equal((await reports(page)).length, 0);
    });
    await scenario('forced live lookup refuses before fixture creation backend reads or network access', async ({ page }) => {
      const probe = await page.evaluate(async () => {
        const original = db.readAll, fixture = DGOfficialLedgerConnector.createFixture;
        const calls = { reads: 0, fixture: 0 };
        try {
          db.readAll = async (...args) => { calls.reads++; return original.apply(db, args); };
          DGOfficialLedgerConnector.createFixture = () => { calls.fixture++; throw new Error('Unexpected fixture use for a live request'); };
          await DGOfficialReportImport.loadLedger('live');
          return calls;
        } finally { db.readAll = original; DGOfficialLedgerConnector.createFixture = fixture; }
      });
      assert.deepEqual(probe, { reads: 0, fixture: 0 });
      assert.equal(await page.locator('#oirLedgerQuery').isDisabled(), true);
      assert.match((await page.locator('#oirError').textContent()) + (await page.locator('#oirLedgerConnection').textContent()), /미등록|미연결|명세|연결정보|준비/);
      assert.equal((await reports(page)).length, 0);
      const afterClear = await page.evaluate(async () => {
        DGOfficialReportImport.clear();
        const pending = DGOfficialReportImport.loadLedger('live');
        DGOfficialReportImport.clear();
        await pending;
        return { error: DGOfficialReportImport.state.error, visibleError: !document.querySelector('#oirError').hidden };
      });
      assert.deepEqual(afterClear, { error: '', visibleError: false }, 'Clearing must prevent a late unconfigured-live error from restoring old UI feedback.');
    });
    await scenario('all synthetic pages are normalized before preview and only local minimal reports are created', async ({ page }) => {
      await page.evaluate(() => {
        const original = DGOfficialLedgerConnector.createFixture;
        DGOfficialLedgerConnector.createFixture = options => {
          const fixture = original(options);
          return { ...fixture, readPage: async input => {
            const raw = JSON.parse(JSON.stringify(await fixture.readPage(input)));
            const items = fixture.profile.itemsPath.reduce((value, key) => value[key], raw);
            items.forEach(row => { row.contact = 'PRIVATE-LEDGER-CONTACT'; row.description = 'PRIVATE-LEDGER-DESCRIPTION'; row.photo = 'PRIVATE-LEDGER-PHOTO'; });
            return raw;
          } };
        };
      });
      await demo(page);
      assert.equal(await selected(page), 2); assert.equal((await reports(page)).length, 0);
      const serialized = await page.evaluate(() => JSON.stringify(DGOfficialReportImport.state));
      for (const marker of ['PRIVATE-LEDGER-CONTACT', 'PRIVATE-LEDGER-DESCRIPTION', 'PRIVATE-LEDGER-PHOTO']) {
        assert.ok(!serialized.includes(marker)); assert.ok(!(await page.locator('#oirPanel').textContent()).includes(marker));
      }
      assert.equal(await page.locator('#oirLedgerQuery').isDisabled(), true);
      await apply(page, 2);
      const rows = await reports(page);
      assert.equal(rows.length, 2); assert.ok(rows.every(row => row.lightId === 'official-fixture-0007' && row.status === '접수' && row.reporterId === 'local'));
      assert.equal(new Set(rows.map(row => row.receipt)).size, 2);
      assert.ok(rows.every(row => !row.contact && !row.location && !row.ext && !row.photo && !row.lat && !row.lng));
      assert.ok(!JSON.stringify(rows).includes('PRIVATE-LEDGER-'));
      assert.equal((await page.evaluate(() => DGOffline.jobs())).length, 0);
    });
    await scenario('requerying the ledger does not duplicate or overwrite staff completion and notes', async ({ page }) => {
      await demo(page); await apply(page, 2);
      const original = (await reports(page))[0];
      await page.evaluate(id => db.doc('reports/' + id).update({ status: '완료', desc: '담당자 수정은 유지', updatedAt: 12345678999 }), original.id);
      const before = await reports(page); await demo(page);
      assert.equal(await selected(page), 0); assert.equal(await page.locator('#oirApply').isDisabled(), true);
      await page.evaluate(() => DGOfficialReportImport.apply());
      assert.deepEqual(await reports(page), before);
    });
    await scenario('an invalid query range is rejected before reading any synthetic page', async ({ page }) => {
      await page.evaluate(() => {
        const original = DGOfficialLedgerConnector.createFixture; window.__ledgerInvalidReads = 0;
        DGOfficialLedgerConnector.createFixture = options => {
          const fixture = original(options); return { ...fixture, readPage: async input => { __ledgerInvalidReads++; return fixture.readPage(input); } };
        };
      });
      await page.locator('#oirLedgerFrom').fill('2026-11-10'); await page.locator('#oirLedgerTo').fill('2026-11-09');
      await page.evaluate(() => DGOfficialReportImport.loadLedger('fixture'));
      assert.equal(await page.evaluate(() => __ledgerInvalidReads), 0);
      assert.equal(await selected(page), 0); assert.equal(await page.locator('#oirApply').isDisabled(), true);
      assert.match(await page.locator('#oirError').textContent(), /기간|날짜|시작|범위/);
    });
    await scenario('a denied later page exposes no partial import and never echoes a provider error', async ({ page }) => {
      await page.evaluate(() => {
        const original = DGOfficialLedgerConnector.createFixture;
        DGOfficialLedgerConnector.createFixture = options => {
          const fixture = original(options); let calls = 0;
          return { ...fixture, readPage: async input => { calls++; if (calls === 2) throw Object.assign(new Error('PRIVATE-LEDGER-RAW-SECRET'), { status: 403 }); return fixture.readPage(input); } };
        };
      });
      await days(page); await page.locator('#oirLedgerDemo').click();
      await poll(page, () => !DGOfficialReportImport.state.busy && !!DGOfficialReportImport.state.error, null, 'denied later ledger page');
      const state = await page.evaluate(() => ({ rows: DGOfficialReportImport.state.rows, preview: DGOfficialReportImport.state.preview, serialized: JSON.stringify(DGOfficialReportImport.state) }));
      assert.deepEqual(state.rows, []); assert.equal(state.preview, null); assert.ok(!state.serialized.includes('PRIVATE-LEDGER-RAW-SECRET'));
      assert.equal(await selected(page), 0); assert.equal((await reports(page)).length, 0); assert.equal(await page.locator('#oirApply').isDisabled(), true);
    });
    await scenario('clearing an in-flight query aborts it and ignores a later second page', async ({ page }) => {
      await prepareGate(page);
      assert.equal(await page.locator('#oirLedgerFrom').isDisabled(), true); assert.equal(await page.locator('#oirLedgerTo').isDisabled(), true);
      assert.equal(await page.locator('#oirLedgerDemo').isDisabled(), true); assert.equal(await page.locator('#oirClear').isEnabled(), true);
      await page.locator('#oirClear').click();
      await page.evaluate(() => __ledgerGate.release()); await page.waitForTimeout(60);
      assert.equal(await page.evaluate(() => DGOfficialReportImport.state.busy), false);
      assert.equal(await selected(page), 0); assert.equal(await page.locator('#oirApply').isDisabled(), true);
      assert.equal((await reports(page)).length, 0);
      assert.equal(await page.evaluate(() => __ledgerGate.signal.aborted), true);
    });
    await scenario('a page timeout preserves no partial ledger and aborts the pending reader', async ({ page }) => {
      await prepareGate(page);
      await poll(page, () => !DGOfficialReportImport.state.busy && !!DGOfficialReportImport.state.error, null, 'ledger page deadline');
      assert.equal(await selected(page), 0); assert.equal(await page.locator('#oirApply').isDisabled(), true); assert.equal((await reports(page)).length, 0);
      assert.equal(await page.evaluate(() => __ledgerGate.signal.aborted), true);
      await page.evaluate(() => __ledgerGate.release()); await page.waitForTimeout(40);
      assert.equal(await selected(page), 0);
    });
    await scenario('late page responses cannot publish after navigation or loss of permissions', async ({ page }) => {
      await prepareGate(page); await page.evaluate(() => openAdminSection('dashboard')); await page.evaluate(() => __ledgerGate.release());
      await page.waitForTimeout(60); assert.equal(await page.locator('#oirPanel').count(), 0); assert.equal((await reports(page)).length, 0);
      await page.evaluate(() => openAdminSection('officialreports')); assert.equal(await selected(page), 0);
      await prepareGate(page); await page.evaluate(() => { S.demoRole = 'inspector'; S.canWrite = false; }); await page.evaluate(() => __ledgerGate.release());
      await page.waitForTimeout(60);
      await page.evaluate(() => { S.demoRole = 'admin'; S.canWrite = true; openAdminSection('officialreports'); });
      assert.equal(await selected(page), 0); assert.equal((await reports(page)).length, 0);
    });
    await scenario('a simulated hosted backend rejects forced fixture and live reads before any backend operation', async ({ page }) => {
      const result = await page.evaluate(async () => {
        const original = { database: db, firebase: FB, render, fixture: DGOfficialLedgerConnector.createFixture };
        const calls = { reads: 0, writes: 0, pages: 0 };
        try {
          const hosted = { mode: 'firebase', readAll: async () => { calls.reads++; return []; }, commitMany: async () => { calls.writes++; } };
          render = () => { const panel = document.querySelector('#oirPanel'); if (panel) panel.outerHTML = DGOfficialReportImport.view(); };
          DGOfficialLedgerConnector.createFixture = () => { calls.pages++; throw new Error('Hosted fixture read is not allowed'); };
          db = hosted; FB = { fs: hosted, auth: { currentUser: { uid: 'synthetic-ledger-hosted' } } }; render();
          const disabled = { live: document.querySelector('#oirLedgerQuery').disabled, fixture: document.querySelector('#oirLedgerDemo').disabled };
          await DGOfficialReportImport.loadLedger('fixture'); await DGOfficialReportImport.loadLedger('live'); await DGOfficialReportImport.apply();
          return { calls, disabled };
        } finally { db = original.database; FB = original.firebase; render = original.render; DGOfficialLedgerConnector.createFixture = original.fixture; }
      });
      assert.deepEqual(result.calls, { reads: 0, writes: 0, pages: 0 }); assert.deepEqual(result.disabled, { live: true, fixture: true });
      assert.equal((await reports(page)).length, 0); assert.equal((await page.evaluate(() => DGOffline.jobs())).length, 0);
    });
    await scenario('changing query dates invalidates ledger results but leaves an independent file preview intact', async ({ page }) => {
      await demo(page); assert.equal(await selected(page), 2);
      await page.locator('#oirLedgerTo').fill('2026-11-10');
      assert.equal(await selected(page), 0); assert.equal(await page.locator('#oirApply').isDisabled(), true);
      await load(page, [sample('FILE-FLOW-KEPT', { received_at: '2026-11-09T11:00:00+09:00' })]);
      assert.equal(await selected(page), 1);
      await page.locator('#oirLedgerTo').fill('2026-11-11');
      assert.equal(await selected(page), 1); assert.equal(await page.locator('[data-oir-select="FILE-FLOW-KEPT"]').isChecked(), true);
      await apply(page, 1); assert.equal((await reports(page))[0].receipt, 'FILE-FLOW-KEPT');
    });
    await scenario('phone and desktop light-dark layouts keep ledger controls and review actions inside the panel', async ({ page }) => {
      await demo(page);
      const artifactDir = process.env.DONGGU_ARTIFACT_DIR; if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
      for (const colorScheme of ['light', 'dark']) for (const width of [390, 1280]) {
        await page.emulateMedia({ colorScheme }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, colorScheme);
        await page.setViewportSize({ width, height: 1000 }); await page.locator('#sheet').evaluate(el => { el.scrollTop = 0; });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const escaped = await page.locator('#oirPanel').evaluate(panel => { const p = panel.getBoundingClientRect(); return [...panel.querySelectorAll('#oirLedgerFrom,#oirLedgerTo,#oirLedgerQuery,#oirLedgerDemo,#oirClear,#oirApply,.oir-table')].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && (b.left < p.left - 1 || b.right > p.right + 1); }).map(el => el.id || el.className); });
        assert.deepEqual(escaped, [], 'Ledger controls remain within the panel at ' + width);
        assert.equal(await page.locator('#oirLedgerQuery').isDisabled(), true); assert.equal(await page.locator('#oirLedgerDemo').isEnabled(), true);
        if (artifactDir) await page.locator('#sheet').screenshot({ path: path.join(artifactDir, 'ledger-' + width + '-' + colorScheme + '-entry.png') });
        await page.locator('#oirApply').scrollIntoViewIfNeeded(); assert.equal(await page.locator('#oirApply').isEnabled(), true);
        if (artifactDir) await page.locator('#sheet').screenshot({ path: path.join(artifactDir, 'ledger-' + width + '-' + colorScheme + '-preview.png') });
      }
    });
    assert.deepEqual(errors, []); assert.deepEqual(mutations, []); assert.deepEqual(operatingRequests, []);
    console.log(JSON.stringify({ results, browserErrors: errors, mutations, operatingRequests }, null, 2));
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
