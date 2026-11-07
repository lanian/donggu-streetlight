/* Local-only functional implementation regression: edits, planned parts, bulk updates and linked reports. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/firebase-config.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG=null;'); }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function poll(page, predicate, value) {
  const deadline = Date.now() + 15000;
  do { if (await page.evaluate(predicate, value)) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
  throw new Error('Expected browser state was not reached');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/css' }));
  const page = await context.newPage(), errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const ready = async () => { await page.waitForFunction(() => S.live && S.me === 'local' && DGOffline.ready); await page.evaluate(() => DGIntegration.whenReady()); };
    await page.goto(origin); await ready();
    const light = await page.evaluate(async () => {
      const light = S.lights.find(row => !row.removed);
      await db.doc('inventory/work-feature-stock').set({ name: '예정 자재', unit: '개', quantity: 10, unitCost: 100, revision: 1, updatedAt: Date.now(), updatedBy: 'local' });
      for (const id of ['work-feature-a', 'work-feature-b']) await db.doc('workOrders/' + id).set(DGOperationsCore.createOrder({ title: id, assignedTo: 'local' }, light, 'local', Date.now()));
      await db.doc('reports/work-feature-linked').set({ lightId: light.id, issue: '고장', status: '접수', workId: 'work-feature-a', createdAt: Date.now() });
      await db.doc('reports/work-feature-race').set({ lightId: light.id, issue: '소등', status: '접수', createdAt: Date.now() });
      return { id: light.id };
    });
    await page.evaluate(() => DGWorkflows.openReportWork('work-feature-linked'));
    assert.equal(await page.locator('[data-fw="new-from-report"]').isDisabled(), true, 'already-linked report must prevent a new competing work');
    await page.locator('[data-fw="open-linked-work"]').click();
    await page.locator('[data-dg="edit-work"]').waitFor();
    results.push('linked report offers existing work instead of a doomed new-work draft');

    await page.locator('[data-dg="edit-work"]').click();
    await page.locator('#woEditTitle').fill('상태를 유지한 정보 수정');
    await page.locator('#woEditDue').fill('2026-12-31');
    await page.locator('#woPlanStockPart').selectOption('work-feature-stock');
    await page.locator('#woPlanPartQty').fill('6');
    await page.locator('[data-dg="add-planned-part"]').click();
    await poll(page, async () => (await DGOffline.get('workEdit', 'work-feature-a'))?.parts?.[0]?.qty === 6);
    await page.reload(); await ready();
    await page.evaluate(() => DGOperations.openEdit('work-feature-a', 'work-feature-a'));
    assert.equal(await page.locator('#woEditTitle').inputValue(), '상태를 유지한 정보 수정');
    assert.match(await page.locator('#woPlannedParts').innerText(), /예정 자재/);
    await page.locator('[data-dg="save-work-edit"]').click();
    await poll(page, async () => (await db.doc('workOrders/work-feature-a').get()).data()?.title === '상태를 유지한 정보 수정');
    const edited = await page.evaluate(async () => ({ work: (await db.doc('workOrders/work-feature-a').get()).data(), stock: (await db.doc('inventory/work-feature-stock').get()).data(), events: await db.readAll('workEvents', { where: [['workId', '==', 'work-feature-a']] }) }));
    assert.equal(edited.work.status, 'assigned'); assert.equal(edited.work.parts[0].qty, 6); assert.equal(edited.work.revision, 2); assert.equal(edited.stock.quantity, 10);
    assert.equal(edited.events.length, 1); assert.equal(edited.events[0].fromStatus, 'assigned'); assert.equal(edited.events[0].toStatus, 'assigned');
    results.push('metadata and planned materials survive reload; update keeps status and stock, records event');

    await page.evaluate(() => DGOperations.openEdit('work-feature-a'));
    await page.locator('#woEditTitle').fill('충돌 뒤 유지할 입력');
    await page.evaluate(async () => { const ref = db.doc('workOrders/work-feature-a'), old = (await ref.get()).data(); await ref.update({ revision: old.revision + 1, description: '다른 직원 변경' }); });
    await page.locator('[data-dg="save-work-edit"]').click();
    await poll(page, () => !!document.querySelector('#woEditState')?.textContent.includes('변경'));
    assert.equal(await page.locator('#woEditTitle').inputValue(), '충돌 뒤 유지할 입력');
    assert.equal(await page.locator('#woEditForm fieldset').isDisabled(), false);
    assert.equal(await page.evaluate(async () => (await db.doc('workOrders/work-feature-a').get()).data().description), '다른 직원 변경');
    results.push('stale metadata edit preserves the server revision and editable recovery input');
    const staleCount = await page.evaluate(async () => (await DGOffline.list('workEdit')).length);
    await page.evaluate(() => DGOperations.openEdit('work-feature-a', 'work-feature-a'));
    await page.locator('#woEditConflict').waitFor();
    assert.match(await page.locator('#woEditConflict').innerText(), /충돌 뒤 유지할 입력/);
    assert.match(await page.locator('#woEditConflict').innerText(), /다른 직원 변경/);
    await page.evaluate(() => DGOperations.openEdit('work-feature-a', 'work-feature-a'));
    assert.equal(await page.evaluate(async () => (await DGOffline.list('workEdit')).length), staleCount, 'opening a stale draft repeatedly must not create duplicate latest-data drafts');
    await page.locator('[data-dg="resume-stale-work-edit"]').click();
    await page.locator('#woEditTitle').waitFor();
    assert.equal(await page.locator('#woEditTitle').inputValue(), '충돌 뒤 유지할 입력');
    assert.equal(await page.locator('#woEditDescription').inputValue(), '');
    assert.equal(await page.evaluate(() => DGOperations.state.edit.expectedRevision), 3);
    assert.equal(await page.evaluate(async () => !!(await DGOffline.get('workEdit', 'work-feature-a'))), true, 'source draft stays recoverable until replacement sync succeeds');
    await page.locator('[data-dg="save-work-edit"]').click();
    await poll(page, async () => (await db.doc('workOrders/work-feature-a').get()).data().revision === 4);
    await poll(page, async () => !(await DGOffline.get('workEdit', 'work-feature-a')));
    assert.equal(await page.evaluate(async () => (await db.doc('workOrders/work-feature-a').get()).data().title), '충돌 뒤 유지할 입력');
    results.push('stale editor compares preserved input with latest fields, rebases only by explicit choice, and cleans source only after sync');

    await page.evaluate(async () => { closeSheet('all'); await DGOperations.load(true); openAdminSection('works'); });
    await page.locator('[data-work-pick="work-feature-a"]').check();
    await page.locator('[data-work-pick="work-feature-b"]').check();
    await page.locator('[data-dg="bulk-work"]').click();
    await page.locator('#woBulkPriority').selectOption('긴급');
    await page.evaluate(async () => { const ref = db.doc('workOrders/work-feature-b'), old = (await ref.get()).data(); await ref.update({ revision: old.revision + 1 }); });
    await page.locator('[data-dg="save-bulk-work"]').click();
    await poll(page, () => !!document.querySelector('#woBulkResults')?.textContent.includes('충돌'));
    const bulk = await page.evaluate(async () => ({ a: (await db.doc('workOrders/work-feature-a').get()).data(), b: (await db.doc('workOrders/work-feature-b').get()).data(), selected: [...DGOperations.state.workPick.keys()] }));
    assert.equal(bulk.a.priority, '긴급'); assert.equal(bulk.a.status, 'assigned'); assert.equal(bulk.b.priority, '보통'); assert.deepEqual(bulk.selected, ['work-feature-b']);
    results.push('bulk updates commit per work, keep a concurrent conflict selected and show individual results');
    await page.evaluate(id => DGOperations.newWork(id, 'work-feature-race'), light.id);
    await page.locator('#woTitle').fill('신고 충돌 뒤 복구할 새 작업');
    await page.locator('#woAssignee').selectOption('local');
    await page.locator('#woPlanStockPart').selectOption('work-feature-stock');
    await page.locator('#woPlanPartQty').fill('2');
    await page.locator('[data-dg="add-planned-part"]').click();
    await page.evaluate(async () => db.doc('reports/work-feature-race').update({ workId: 'work-feature-a', updatedAt: Date.now() }));
    await page.locator('[data-dg="create-work"]').click();
    await poll(page, () => DGOperations.state.draft?.pending === null);
    assert.equal(await page.locator('#woTitle').inputValue(), '신고 충돌 뒤 복구할 새 작업');
    assert.equal(await page.locator('#woNewForm fieldset').isDisabled(), false);
    await page.locator('[data-work-report="work-feature-race"]').uncheck();
    const draftId = await page.evaluate(() => DGOperations.state.draft.id);
    await page.locator('[data-dg="create-work"]').click();
    await poll(page, async id => (await db.doc('workOrders/' + id).get()).exists, draftId);
    const created = await page.evaluate(async id => ({ work: (await db.doc('workOrders/' + id).get()).data(), stock: (await db.doc('inventory/work-feature-stock').get()).data() }), draftId);
    assert.equal(created.work.parts[0].qty, 2); assert.deepEqual(created.work.reportIds, []); assert.equal(created.stock.quantity, 10);
    results.push('concurrent report-link rejection unlocks and retains input; deselecting it permits save with planned parts');
    await page.evaluate(async id => { const ref = db.doc('workOrders/' + id), old = (await ref.get()).data(); await ref.update({ assignedTo: 'former-staff', revision: old.revision + 1 }); await DGOperations.openEdit(id); }, draftId);
    assert.equal(await page.locator('#woEditAssignee').inputValue(), 'former-staff', 'editing a title must preserve an assignee absent from the active staff list');
    results.push('metadata editor retains the current assignee when the staff list no longer contains them');
    await page.evaluate(async id => {
      closeSheet('all'); DGOperations.state.workPick.clear();
      await db.doc('workOrders/work-feature-draft').set(DGOperationsCore.createOrder({ title: '일괄 배정할 대기 작업' }, byId(id), 'local', Date.now()));
      await DGOperations.load(true); openAdminSection('works');
    }, light.id);
    await page.locator('[data-work-pick="work-feature-draft"]').check();
    await page.locator('[data-dg="bulk-work"]').click();
    await page.locator('#woBulkAssignee').selectOption('local');
    await page.locator('#woBulkPriority').selectOption('높음');
    await page.locator('[data-dg="save-bulk-work"]').click();
    await poll(page, async () => (await db.doc('workOrders/work-feature-draft').get()).data()?.status === 'assigned');
    assert.equal(await page.evaluate(async () => DGOperationsCore.actions((await db.doc('workOrders/work-feature-draft').get()).data(), 'local', false).includes('in_progress')), true);
    results.push('bulk assignment advances a draft into an actionable assigned work while retaining per-work revision checks');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } catch (error) { console.error(await page.locator('#sheetIn').innerText().catch(() => '')); throw error; }
  finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
