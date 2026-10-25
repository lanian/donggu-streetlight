/* Local-only report linking, task filtering and facility history UI regression. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '..');
async function poll(page, predicate, arg, label = 'workflow state') {
  const deadline = Date.now() + 20000;
  do { if (await page.evaluate(predicate, arg)) return; await new Promise(r => setTimeout(r, 30)); } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  let body = fs.readFileSync(file);
  // Isolated feature worktrees may not yet contain the release script manifest.
  if (file === path.join(root, 'index.html') && !body.includes('src="app/workflows.js"')) body = Buffer.from(body.toString().replace('<script src="app/legacy-bridge.js">', '<script src="app/workflows.js"></script>\n<script src="app/legacy-bridge.js">'));
  res.end(body);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/css' }));
  const page = await context.newPage(), errors = [], results = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  async function work(title, id, due, priority = '긴급') {
    await page.evaluate(id => DGOperations.newWork(id), id);
    await page.locator('#woTitle').fill(title); await page.locator('#woAssignee').selectOption('local'); await page.locator('#woPriority').selectOption(priority); await page.locator('#woDue').fill(due);
    const workId = await page.evaluate(() => DGOperations.state.draft.id);
    await page.locator('[data-dg="create-work"]').click();
    await poll(page, async id => (await db.doc('workOrders/' + id).get()).exists, workId, 'new work saved');
    await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open')); return workId;
  }
  async function delayLinkedWorkRead(id) {
    await page.evaluate(id => {
      const doc = db.doc, open = DGOperations.openWork, race = window.workLinkRace = { started: false, entered: false, returned: false };
      const delay = new Promise(resolve => { race.release = resolve; });
      db.doc = function (path) { const ref = doc.call(this, path); if (path === 'workOrders/' + id) { const get = ref.get; ref.get = async function (...args) { if (race.started && !race.entered) { race.entered = true; await delay; } return get.apply(this, args); }; } return ref; };
      DGOperations.openWork = async function (...args) { race.started = true; try { return await open.apply(this, args); } finally { race.returned = true; } };
      race.restore = () => { db.doc = doc; DGOperations.openWork = open; };
    }, id);
  }
  try {
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); });
    const location = await page.evaluate(() => { const a = S.lights.find(l => !l.removed && l.dong && Number.isFinite(l.lat)); return { id: a.id, code: a.code, dong: a.dong, today: DGOperationsCore.kstDateKey(), yesterday: DGOperationsCore.kstDateKey(Date.now() - 86400000) }; });
    const first = await work('긴급 오늘 작업 하나', location.id, location.today);
    const second = await work('긴급 오늘 작업 둘', location.id, location.today);
    await work('지난 기한 보통 작업', location.id, location.yesterday, '보통');
    results.push('work forms saved KST deadlines and assignees through the UI');

    await page.evaluate(async () => { const at = Date.now(); await db.doc('reports/field-ui-report').set({ lightId: null, code: '', dong: '', issue: '꺼짐', location: '시설 확인 전 위치', desc: '연결 전 원문 유지', receipt: 'LOCAL-R1', contact: 'local-test-contact', status: '접수', createdAt: at, reporterId: 'local' }); });
    await page.evaluate(() => DGWorkflows.openReportLink('field-ui-report'));
    await page.locator('#dgReportFacility').fill(location.code + ' [' + location.id + ']'); await page.locator('#dgReportReason').fill('현장에서 표찰과 주변 사진을 확인함');
    await page.locator('#dgReportLink button[type="submit"]').click();
    await poll(page, async id => (await db.doc('reports/field-ui-report').get()).data().lightId === id, location.id, 'report linked to facility');
    const linked = await page.evaluate(async () => ({ report: (await db.doc('reports/field-ui-report').get()).data(), events: await DGData.readAll(db, 'reportEvents') }));
    assert.equal(linked.report.desc, '연결 전 원문 유지'); assert.equal(linked.report.receipt, 'LOCAL-R1'); assert.equal(linked.report.contact, 'local-test-contact'); assert.equal(linked.events.length, 1); assert.equal(linked.events[0].fromLightId, '');
    results.push('unlinked report gained a facility with reason/history while preserving its original content');

    await page.evaluate(async id => { const at = Date.now(); await db.doc('reports/field-ui-duplicate').set({ lightId: id, issue: '꺼짐', desc: '같은 시설의 추가 신고', status: '접수', createdAt: at }); }, location.id);
    await page.evaluate(() => DGWorkflows.openReportWork('field-ui-report'));
    assert.equal(await page.locator('[data-fw-report="field-ui-report"]').isChecked(), true);
    assert.equal(await page.locator('[data-fw-report="field-ui-duplicate"]').isChecked(), false);
    await delayLinkedWorkRead(first);
    await page.locator('[data-fw-report="field-ui-duplicate"]').check(); await page.locator('#dgExistingWork').selectOption(first); await page.locator('[data-fw="link-existing-work"]').click();
    await poll(page, () => window.workLinkRace.entered, undefined, 'linked work detail read deliberately delayed');
    await poll(page, async id => (await db.doc('reports/field-ui-report').get()).data().workId === id, first, 'existing work got both reports');
    const joined = await page.evaluate(async id => ({ order: (await db.doc('workOrders/' + id).get()).data(), reports: await DGData.readAll(db, 'reports'), events: await DGData.readAll(db, 'workEvents', { where: [['workId', '==', id]] }) }), first);
    assert.deepEqual(joined.order.reportIds.sort(), ['field-ui-duplicate', 'field-ui-report']); assert.equal(joined.order.status, 'assigned'); assert.equal(joined.events.some(e => e.type === 'reports-linked'), true); assert.equal(joined.reports.length, 2);
    results.push('duplicate candidates require human selection and link to an existing work without deleting reports');

    await page.evaluate(() => DGWorkflows.openReportWork('field-ui-duplicate'));
    await page.evaluate(() => { workLinkRace.newForm = document.querySelector('#dgReportWork'); workLinkRace.release(); });
    await poll(page, () => workLinkRace.returned, undefined, 'older linked work response returned');
    assert.equal(await page.evaluate(() => workLinkRace.newForm.isConnected && document.querySelector('#dgReportWork') === workLinkRace.newForm), true);
    assert.equal(await page.locator('#dgReportWork').getAttribute('data-report-id'), 'field-ui-duplicate');
    await page.evaluate(() => workLinkRace.restore());
    results.push('delayed linked-work detail cannot replace a newer report connection view');
    await page.locator('[data-fw="new-from-report"]').click();
    assert.equal(await page.locator('[data-work-report="field-ui-duplicate"]').isChecked(), true);
    const selectedDraft = await page.evaluate(() => DGOperations.state.draft);
    assert.equal(selectedDraft.reportIds.includes('field-ui-duplicate'), true);
    await page.evaluate(async () => { await DGOperations.clearWorkDraft(DGOperations.state.draft, 'workDraft'); closeSheet(); });
    results.push('report selection is preserved when opening a new work draft');

    await page.evaluate(() => openAdminSection('works'));
    await page.locator('#woDeadline').selectOption('today'); await page.locator('#woUrgent').check(); await page.locator('#woMine').check(); await page.locator('#woDong').selectOption(location.dong);
    await poll(page, () => DGOperations.state.loaded && !DGOperations.state.error && DGOperations.state.workQueryKey === JSON.stringify(DGOperations.workFilters()), undefined, 'filtered work list');
    assert.deepEqual(await page.evaluate(() => DGOperations.selectedOrders().map(w => w.title).sort()), ['긴급 오늘 작업 둘', '긴급 오늘 작업 하나']);
    const downloadPromise = page.waitForEvent('download'); await page.locator('[data-dg="work-csv"]').click();
    const download = await downloadPromise, csv = fs.readFileSync(await download.path(), 'utf8');
    assert.equal(csv.includes('긴급 오늘 작업 하나'), true); assert.equal(csv.includes('긴급 오늘 작업 둘'), true); assert.equal(csv.includes('지난 기한 보통 작업'), false);
    await page.locator('[data-dg="work-map"]').click(); await page.locator('#mapCount').waitFor(); assert.equal((await page.locator('#mapCount').textContent()).trim(), '1개');
    await page.evaluate(() => openAdminSection('works')); await page.locator('[data-dg="work-plan"]').click();
    await poll(page, () => DGOperations.state.plan?.stops.length === 1, undefined, 'visit plan');
    const plan = await page.evaluate(async () => DGOffline.get('plan', 'current')); assert.deepEqual(plan.stops[0].workIds.sort(), [first, second].sort());
    results.push('today/urgent/mine/dong filters match CSV, one facility map marker and a deduplicated two-work visit');

    await page.evaluate(id => DGWorkflows.openFacility(id), location.id); await page.getByText('시간순 기록', { exact: true }).waitFor();
    const history = await page.evaluate(() => DGWorkflows.state.facility);
    assert.equal(history.items.some(x => x.kind === '신고 시설 연결'), true); assert.equal(history.items.some(x => x.kind === '작업에 신고 연결'), true); assert.equal(history.orders.length, 3);
    await page.evaluate(() => { window.print = () => { document.body.dataset.didPrint = 'yes'; }; }); await page.locator('[data-fw="facility-print"]').click();
    await page.waitForFunction(() => document.body.dataset.didPrint === 'yes'); assert.equal((await page.locator('#sheetIn').textContent()).includes('신고 시설 연결'), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    results.push('facility history and printable report include linkage, work, and report events');

    const dossier = await page.evaluate(async id => {
      await db.doc('inspections/dossier-only-inspection').set({ lightId: id, date: Date.now(), result: '정상', memo: '대장 점검 상세 중복 검사', inspector: 'local' });
      const light = byId(id); light.edits = [...(light.edits || []), { at: Date.now(), by: 'local', changes: [{ f: '비고', from: '', to: '대장 수정 상세 중복 검사' }] }];
      return { full: await DGWorkflows.facilitySection(id), additional: await DGWorkflows.facilitySection(id, { omitExistingDetails: true }) };
    }, location.id);
    assert.equal(dossier.full.includes('대장 점검 상세 중복 검사'), true); assert.equal(dossier.full.includes('대장 수정 상세 중복 검사'), true);
    assert.equal(dossier.additional.includes('대장 점검 상세 중복 검사'), false); assert.equal(dossier.additional.includes('대장 수정 상세 중복 검사'), false); assert.equal(dossier.additional.includes('신고 시설 연결'), true); assert.equal(dossier.additional.includes('현재 진행 중 작업 3건'), true);
    assert.equal(/<button|<img|\sid=/.test(dossier.additional), false);
    await page.evaluate(id => openLightDossier(id), location.id);
    const dossierText = await page.locator('#sheetIn').textContent();
    assert.equal(dossierText.split('대장 점검 상세 중복 검사').length - 1, 1); assert.equal(dossierText.split('대장 수정 상세 중복 검사').length - 1, 1);
    assert.equal(dossierText.includes('신고 시설 연결'), true); assert.equal(dossierText.includes('현재 진행 중 작업 3건'), true);
    await page.emulateMedia({ media: 'print' }); assert.equal(await page.locator('#sheet .rep').first().isVisible(), true); assert.equal(await page.locator('#sheet .sheet-head').isVisible(), false); await page.emulateMedia({ media: 'screen' });
    results.push('dossier appendix omits existing inspection/edit details without removing report or active-work history');

    await page.evaluate(() => DGWorkflows.openReportWork('field-ui-report')); await delayLinkedWorkRead(first);
    await page.locator('#dgExistingWork').selectOption(first); await page.locator('[data-fw="link-existing-work"]').click();
    await poll(page, () => workLinkRace.entered, undefined, 'linked work read delayed before closing');
    await page.evaluate(() => { window.closedLinkHistory = new Promise(resolve => addEventListener('popstate', resolve, { once: true })); });
    await page.locator('#sheet [data-close]').click(); await page.evaluate(() => closedLinkHistory.then(() => true));
    await page.evaluate(() => workLinkRace.release()); await poll(page, () => workLinkRace.returned, undefined, 'closed report link response returned');
    assert.equal(await page.locator('#sheet').evaluate(el => el.classList.contains('open')), false);
    assert.equal(await page.locator('#dgReportWork').getAttribute('data-report-id'), 'field-ui-report'); await page.evaluate(() => workLinkRace.restore());
    results.push('closing the report sheet prevents a delayed linked-work response from reopening it');

    await page.evaluate(() => {
      const submit = DGOperations.submit, race = window.failedLinkRace = { calls: [] };
      DGOperations.submit = job => new Promise((resolve, reject) => race.calls.push({ job, resolve, reject }));
      race.restore = () => { DGOperations.submit = submit; };
    });
    await page.evaluate(() => DGWorkflows.openReportWork('field-ui-report')); await page.locator('#dgExistingWork').selectOption(first); await page.locator('[data-fw="link-existing-work"]').click();
    await poll(page, () => failedLinkRace.calls.length === 1, undefined, 'first delayed report link');
    await page.evaluate(() => DGWorkflows.openReportWork('field-ui-duplicate')); await page.locator('#dgExistingWork').selectOption(first); await page.locator('[data-fw="link-existing-work"]').click();
    await poll(page, () => failedLinkRace.calls.length === 2, undefined, 'newer delayed report link');
    await page.evaluate(() => failedLinkRace.calls[0].reject(new Error('이전 신고 연결 지연 실패')));
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('이전 신고 연결 지연 실패'));
    assert.equal(await page.evaluate(() => DGWorkflows.state.reportJob?.id === failedLinkRace.calls[1].job.id), true);
    assert.equal(await page.locator('#dgReportWork fieldset').evaluate(el => el.disabled), true); assert.equal(await page.locator('[data-fw="link-existing-work"]').isDisabled(), true); assert.equal(await page.locator('#dgWorkLinkState').textContent(), '');
    await page.evaluate(() => failedLinkRace.calls[1].resolve({ state: 'queued' })); await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    await page.evaluate(() => failedLinkRace.restore());
    results.push('older link failure cannot clear or unlock a newer report submission');
    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } catch (error) {
    console.error(JSON.stringify(await page.evaluate(async () => ({ toast: document.querySelector('#toast')?.textContent, error: DGOperations?.state.error, filter: DGOperations?.workFilters(), jobs: DGOffline.ready ? (await DGOffline.jobs()).map(x => ({ kind: x.kind, state: x.state, error: x.error })) : [], text: document.querySelector('#sheetIn')?.innerText.slice(-1400) })).catch(() => ({})), null, 2)); throw error;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
