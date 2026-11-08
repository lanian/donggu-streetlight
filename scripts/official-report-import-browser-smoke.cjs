/* External report preparation only: synthetic local files, no live service or Firebase. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DONGGU_IMPORT_ROOT || path.join(__dirname, '..'));
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
  const results = [], errors = [], mutations = []; let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://localhost:' + server.address().port;
  try {
    browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
    async function scenario(name, run) {
      if (process.env.DONGGU_IMPORT_CASE && !name.includes(process.env.DONGGU_IMPORT_CASE)) return;
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
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
    async function readGate(page) {
      await page.evaluate(() => {
        window.__originalImportFileText = File.prototype.text;
        window.__importFileRead = { started: false, release: null };
        File.prototype.text = function () {
          const current = this;
          __importFileRead.started = true;
          return new Promise(resolve => { __importFileRead.release = async () => resolve(await __originalImportFileText.call(current)); });
        };
      });
    }
    async function releaseGate(page) {
      await page.evaluate(async () => { File.prototype.text = __originalImportFileText; await __importFileRead.release(); });
    }
    await scenario('preparation panel exposes file preview while real service access stays unavailable', async ({ page }) => {
      assert.equal(await page.locator('#oirPanel').count(), 1, 'The external report preparation panel must exist.');
      assert.equal(await page.locator('#oirFile').count(), 1);
      assert.equal(await page.locator('#oirApply').isDisabled(), true);
      assert.match(await page.locator('#oirNotice').textContent(), /준비|체험|협의/);
      assert.equal(await page.evaluate(() => FB), null);
    });
    await scenario('JSON preview strips private fields before display and creates only a local minimal inbox record', async ({ page }) => {
      const input = sample('JSON-PRIVATE', { contact: privateValues[0], name: privateValues[1], desc: privateValues[2], photo: privateValues[3], lat: 35.111111, lng: 126.999999, location: 'PRIVATE-EXACT-LOCATION' });
      await load(page, [input]);
      assert.equal(await selected(page), 1); assert.equal((await reports(page)).length, 0, 'Preview has no write side effect.');
      const serialized = await page.evaluate(() => JSON.stringify(DGOfficialReportImport.state));
      const visible = await page.locator('#oirPanel').textContent();
      for (const value of [...privateValues, 'PRIVATE-EXACT-LOCATION']) { assert.ok(!serialized.includes(value)); assert.ok(!visible.includes(value)); }
      await apply(page, 1);
      const [created] = await reports(page);
      assert.equal(created.receipt, 'JSON-PRIVATE'); assert.equal(created.lightId, 'official-fixture-0007'); assert.equal(created.code, '합성 표찰 0007');
      assert.equal(created.issue, '불이 꺼져 있어요'); assert.equal(created.status, '접수'); assert.equal(created.createdAt, Date.parse(input.received_at));
      assert.equal(created.contact, ''); assert.equal(created.location, ''); assert.equal(created.reporterId, 'local');
      for (const key of ['name', 'photo', 'lat', 'lng', 'ext', 'externalImport']) assert.equal(Object.hasOwn(created, key), false);
      for (const value of privateValues) assert.ok(!JSON.stringify(created).includes(value));
      assert.equal((await page.evaluate(() => DGOffline.jobs())).length, 0, 'No server retry job is queued.');
    });
    await scenario('UTF-8 BOM CSV with quoted multiline discarded fields preserves receipt and facility leading zeros', async ({ page }) => {
      const csv = '\ufeffexternal_report_id,lamp_id,issue,received_at,status,desc\r\n000012,0007,flicker,2026-11-08T02:00:00Z,received,"PRIVATE-FREE-TEXT-TEST, quoted\r\nsecond line"\r\n';
      await file(page, csv, 'csv', '000012'); await apply(page, 1);
      const [created] = await reports(page); assert.equal(created.receipt, '000012'); assert.equal(created.lightId, 'official-fixture-0007'); assert.equal(created.issue, '깜빡거려요');
      assert.ok(!JSON.stringify(created).includes(privateValues[2])); assert.equal(created.createdAt, Date.parse('2026-11-08T02:00:00Z'));
    });
    await scenario('closed source reports stay excluded and processing source status never completes local workflow', async ({ page }) => {
      await load(page, [sample('SOURCE-DONE', { status: 'completed' }), sample('SOURCE-CANCELLED', { status: 'cancelled' }), sample('SOURCE-PROCESSING', { status: 'processing' })]);
      assert.equal(await selected(page), 1);
      assert.equal(await page.locator('[data-oir-select="SOURCE-DONE"]').isDisabled(), true); assert.equal(await page.locator('[data-oir-select="SOURCE-CANCELLED"]').isDisabled(), true);
      await apply(page, 1); const [created] = await reports(page); assert.equal(created.receipt, 'SOURCE-PROCESSING'); assert.equal(created.status, '접수');
      assert.ok(!created.updatedAt && !created.workId);
    });
    await scenario('unmatched removed and ambiguous operating facilities are never guessed from local IDs or plate text', async ({ page }) => {
      await load(page, [sample('FACILITY-MISSING', { lamp_id: 'DOES-NOT-EXIST', code: '합성 표찰 0007' }), sample('FACILITY-REMOVED', { lamp_id: 'REMOVED' }), sample('FACILITY-AMBIGUOUS', { lamp_id: 'DUPE' }), sample('FACILITY-ZERO', { lamp_id: 0 })]);
      assert.equal(await selected(page), 1);
      for (const id of ['FACILITY-MISSING', 'FACILITY-REMOVED', 'FACILITY-AMBIGUOUS']) assert.equal(await page.locator('[data-oir-select="' + id + '"]').isDisabled(), true);
      await apply(page, 1); const [created] = await reports(page); assert.equal(created.receipt, 'FACILITY-ZERO'); assert.equal(created.lightId, 'official-fixture-zero');
    });
    await scenario('an existing receipt is skipped without resetting staff edits or completion status', async ({ page }) => {
      const existing = { issue: '기타', location: '기존 위치', dong: '지산동', code: '기존 표찰', lightId: 'official-fixture-0007', desc: '담당자가 기록한 기존 내용', via: '전화', receipt: 'EXISTING-RECEIPT', contact: '기존 연락처', status: '완료', createdAt: 1234567890, reporterId: 'local', updatedAt: 1234567999 };
      await page.evaluate(value => db.doc('reports/manual-existing').create(value), existing);
      await load(page, [sample('EXISTING-RECEIPT', { issue: 'broken' }), sample('NEW-RECEIPT')]);
      assert.equal(await selected(page), 1); assert.equal(await page.locator('[data-oir-select="EXISTING-RECEIPT"]').isDisabled(), true);
      await apply(page, 2);
      const actual = await page.evaluate(async () => (await db.doc('reports/manual-existing').get()).data()); assert.deepEqual(actual, existing);
    });
    await scenario('identical rows create one record while conflicting rows with the same source ID are all held', async ({ page }) => {
      await load(page, [sample('IDENTICAL'), sample('IDENTICAL'), sample('CONFLICT', { issue: 'off' }), sample('CONFLICT', { issue: 'broken' }), sample('UNIQUE')]);
      assert.equal(await selected(page), 2);
      const conflictBoxes = page.locator('[data-oir-select="CONFLICT"]'); assert.equal(await conflictBoxes.count(), 2);
      assert.deepEqual(await conflictBoxes.evaluateAll(nodes => nodes.map(node => node.disabled)), [true, true]);
      await apply(page, 2); assert.deepEqual((await reports(page)).map(row => row.receipt).sort(), ['IDENTICAL', 'UNIQUE']);
    });
    await scenario('reimporting a changed file remains idempotent and preserves locally updated records', async ({ page }) => {
      await load(page, [sample('REIMPORT')]); await apply(page, 1);
      const original = (await reports(page))[0];
      await page.evaluate(id => db.doc('reports/' + id).update({ status: '완료', desc: '체험 담당자 수정 내용', updatedAt: 9999999999 }), original.id);
      const before = (await reports(page))[0];
      await load(page, [sample('REIMPORT', { issue: 'broken', status: 'processing' })]);
      assert.equal(await selected(page), 0); assert.equal(await page.locator('#oirApply').isDisabled(), true);
      await page.evaluate(() => DGOfficialReportImport.apply()); assert.deepEqual((await reports(page))[0], before);
      assert.equal((await reports(page)).length, 1); assert.equal((await page.evaluate(() => DGOffline.jobs())).length, 0);
    });
    await scenario('selection and select-all control exactly which eligible reports are imported', async ({ page }) => {
      await load(page, [sample('SELECT-A'), sample('SELECT-B'), sample('SELECT-C')]); assert.equal(await selected(page), 3);
      await page.locator('#oirSelectNone').click(); assert.equal(await selected(page), 0); assert.equal(await page.locator('#oirApply').isDisabled(), true);
      await page.locator('#oirSelectAll').click(); assert.equal(await selected(page), 3);
      await page.locator('[data-oir-select="SELECT-A"]').uncheck(); await page.locator('[data-oir-select="SELECT-B"]').uncheck();
      await apply(page, 1); assert.equal((await reports(page))[0].receipt, 'SELECT-C');
    });
    await scenario('malformed and oversized files cannot reuse an earlier valid preview or echo private source text', async ({ page }) => {
      await load(page, [sample('EARLIER-VALID')]);
      await page.locator('#oirFile').setInputFiles({ name: 'synthetic-invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"reports":[{"contact":"PRIVATE-CONTACT-010-TEST"}') });
      await poll(page, () => !DGOfficialReportImport.state.busy && !!DGOfficialReportImport.state.error, null, 'malformed file error');
      assert.equal(await page.locator('#oirApply').isDisabled(), true); assert.equal(await selected(page), 0);
      assert.ok(!(await page.locator('#oirError').textContent()).includes(privateValues[0]));
      await load(page, [sample('VALID-BEFORE-OVERSIZE')]);
      await page.locator('#oirFile').setInputFiles({ name: 'synthetic-too-large.json', mimeType: 'application/json', buffer: Buffer.from(' '.repeat(2 * 1024 * 1024 + 1)) });
      await poll(page, () => !DGOfficialReportImport.state.busy && !!DGOfficialReportImport.state.error, null, 'oversized file error');
      assert.equal(await page.locator('#oirApply').isDisabled(), true); assert.equal((await reports(page)).length, 0);
    });
    await scenario('clear drops the preview and source selections without altering inbox records or retaining raw data', async ({ page }) => {
      await load(page, [sample('CLEAR-ME', { contact: privateValues[0], desc: privateValues[2] })]); await page.locator('#oirClear').click();
      assert.equal(await selected(page), 0); assert.equal(await page.locator('#oirApply').isDisabled(), true);
      const state = await page.evaluate(() => ({ rows: DGOfficialReportImport.state.rows, preview: DGOfficialReportImport.state.preview, selected: [...DGOfficialReportImport.state.selected], serialized: JSON.stringify(DGOfficialReportImport.state) }));
      assert.deepEqual(state.rows, []); assert.equal(state.preview, null); assert.deepEqual(state.selected, []); assert.ok(!state.serialized.includes('CLEAR-ME'));
      assert.equal(await page.locator('#oirFile').inputValue(), ''); assert.equal((await reports(page)).length, 0);
      await readGate(page); await page.locator('#oirFile').setInputFiles({ name: 'synthetic-clear-delayed.json', mimeType: 'application/json', buffer: Buffer.from(jsonFile([sample('CLEAR-DELAYED')])) });
      await poll(page, () => __importFileRead.started, null, 'clear file read held');
      await page.locator('#oirClear').click(); await releaseGate(page); await page.waitForTimeout(60);
      assert.equal(await selected(page), 0); assert.equal(await page.locator('#oirApply').isDisabled(), true); assert.equal((await reports(page)).length, 0);
    });
    await scenario('late file reads cannot publish into another screen or another account', async ({ page }) => {
      await readGate(page);
      await page.locator('#oirFile').setInputFiles({ name: 'synthetic-delayed.json', mimeType: 'application/json', buffer: Buffer.from(jsonFile([sample('LATE-NAVIGATION')])) });
      await poll(page, () => __importFileRead.started, null, 'file read held');
      await page.evaluate(() => openAdminSection('dashboard')); await releaseGate(page);
      await page.waitForTimeout(60); assert.equal(await page.locator('#oirPanel').count(), 0); assert.equal((await reports(page)).length, 0);
      await page.evaluate(() => openAdminSection('officialreports')); assert.equal(await selected(page), 0);
      await readGate(page); await page.locator('#oirFile').setInputFiles({ name: 'synthetic-account-delay.json', mimeType: 'application/json', buffer: Buffer.from(jsonFile([sample('LATE-ACCOUNT')])) });
      await poll(page, () => __importFileRead.started, null, 'account file read held');
      await page.evaluate(() => { S.me = 'different-synthetic-user'; }); await releaseGate(page); await page.waitForTimeout(60);
      await page.evaluate(() => { S.me = 'local'; openAdminSection('officialreports'); });
      assert.equal(await selected(page), 0); assert.equal((await reports(page)).length, 0);
    });
    await scenario('lost permissions and a hosted backend block forced import before any backend read or write', async ({ page }) => {
      await load(page, [sample('BLOCKED')]);
      await page.evaluate(async () => { S.demoRole = 'inspector'; S.canWrite = false; await DGOfficialReportImport.apply(); });
      assert.equal((await reports(page)).length, 0);
      await page.evaluate(() => { S.demoRole = 'admin'; S.canWrite = true; openAdminSection('officialreports'); }); await load(page, [sample('BLOCKED-HOSTED')]);
      await page.evaluate(async () => {
        window.__hostedImportProbe = { reads: 0, writes: 0 }; window.__originalImportDb = db; window.__originalImportFb = FB;
        const hosted = { mode: 'firebase', readAll: async () => { __hostedImportProbe.reads++; return []; }, commitMany: async () => { __hostedImportProbe.writes++; } };
        db = hosted; FB = { fs: hosted, auth: { currentUser: { uid: 'synthetic-hosted' } } };
        await DGOfficialReportImport.apply();
        await DGOfficialReportImport.loadText('{"schemaVersion":1,"reports":[]}', 'json');
        db = __originalImportDb; FB = __originalImportFb;
      });
      assert.deepEqual(await page.evaluate(() => __hostedImportProbe), { reads: 0, writes: 0 });
      assert.equal((await reports(page)).length, 0); assert.equal((await page.evaluate(() => DGOffline.jobs())).length, 0);
    });
    await scenario('preparation templates download locally and the sample can be reviewed without live access', async ({ page }) => {
      for (const [id, format] of [['oirTemplateCsv', 'csv'], ['oirTemplateJson', 'json']]) {
        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#' + id).click()]);
        assert.match(download.suggestedFilename(), new RegExp('\\.' + format + '$'));
        const body = fs.readFileSync(await download.path(), 'utf8');
        const parsed = await page.evaluate(({ body, format }) => DGOfficialReportImportCore.parse(body, format), { body, format });
        assert.ok(parsed.rows.length > 0); assert.ok(parsed.rows.every(row => row.externalId && row.lampId));
      }
      await page.locator('#oirSample').click();
      await poll(page, () => !DGOfficialReportImport.state.busy && DGOfficialReportImport.state.preview?.rows.length > 0, null, 'synthetic sample prepared');
      assert.ok(await selected(page) > 0); assert.equal((await reports(page)).length, 0);
      await page.evaluate(() => openAdminSection('roadlighting')); await page.locator('#rlExternalReports').click(); assert.equal(await page.locator('#oirPanel').isVisible(), true);
    });
    await scenario('phone and desktop light-dark layouts keep file review and primary actions inside the panel', async ({ page }) => {
      await load(page, [sample('LAYOUT-' + 'A'.repeat(90)), sample('LAYOUT-UNKNOWN', { lamp_id: 'NOT-PRESENT' }), sample('LAYOUT-CLOSED', { status: 'completed' })]);
      const artifactDir = process.env.DONGGU_ARTIFACT_DIR; if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
      for (const colorScheme of ['light', 'dark']) for (const width of [390, 1280]) {
        await page.emulateMedia({ colorScheme }); await page.evaluate(value => { document.documentElement.dataset.theme = value; }, colorScheme);
        await page.setViewportSize({ width, height: 1000 }); await page.locator('#sheet').evaluate(el => { el.scrollTop = 0; });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const escaped = await page.locator('#oirPanel').evaluate(panel => { const p = panel.getBoundingClientRect(); return [...panel.querySelectorAll('#oirFile,#oirTemplateCsv,#oirTemplateJson,#oirSample,#oirClear,#oirApply,.oir-table')].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && (b.left < p.left - 1 || b.right > p.right + 1); }).map(el => el.id || el.className); });
        assert.deepEqual(escaped, [], 'File controls and preview must remain within the panel at ' + width);
        assert.equal(await page.locator('#oirPreview').evaluate(table => { const container = table.parentElement; return getComputedStyle(container).overflowX === 'auto' && container.clientWidth <= container.parentElement.clientWidth; }), true, 'The wide preview stays inside its explicit horizontal scroller.');
        if (artifactDir) await page.locator('#sheet').screenshot({ path: path.join(artifactDir, 'official-import-' + width + '-' + colorScheme + '-entry.png') });
        await page.locator('#oirApply').scrollIntoViewIfNeeded(); assert.equal(await page.locator('#oirApply').isEnabled(), true);
        if (artifactDir) await page.locator('#sheet').screenshot({ path: path.join(artifactDir, 'official-import-' + width + '-' + colorScheme + '-preview.png') });
      }
    });
    assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
    console.log(JSON.stringify({ results, browserErrors: errors, mutations }, null, 2));
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
