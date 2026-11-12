/* Local fixtures only: assignment acknowledgement, hold, diagnosis and preventive cycles. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => { const pathname = new URL(req.url, 'http://localhost').pathname; if (pathname === '/firebase-config.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG=null;'); } const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : '')); if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end(); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file)); });
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function poll(page, fn) { const end = Date.now() + 15000; do { if (await page.evaluate(fn)) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < end); throw new Error('Expected stored work state was not reached'); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] }), context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const page = await context.newPage(), errors = [], results = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin); await page.waitForFunction(() => S.live && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(async () => { const l = S.lights.find(x => !x.removed); window.essentialLight = l.id; await db.doc('workOrders/essential-work').set(DGOperationsCore.createOrder({ title: '긴급 확인', assignedTo: 'local', priority: '긴급', dueAt: Date.now() - 1000, workflowVersion: 2 }, l, 'local', Date.now() - 10000)); await DGOperations.load(true); await DGOperations.openWork('essential-work'); });
    await page.locator('[data-dg="acknowledge-work"]').click();
    await poll(page, async () => (await db.doc('workOrders/essential-work').get()).data().acknowledgedBy === 'local');
    await page.locator('[data-dg="acknowledge-work"]').waitFor({ state: 'detached' });
    await page.locator('.dg-process summary').click();
    await page.locator('#woHoldReason').selectOption('material'); await page.locator('#woHoldNext').fill(await page.evaluate(() => DGOperationsCore.kstDateKey(Date.now() + 3 * 86400000))); await page.locator('#woHoldAction').fill('입고 예정 확인');
    await page.locator('[data-dg="hold-work"]').click();
    await poll(page, async () => !!(await db.doc('workOrders/essential-work').get()).data().hold);
    const held = await page.evaluate(async () => (await db.doc('workOrders/essential-work').get()).data()); assert.equal(held.status, 'assigned'); assert.ok(held.dueAt < Date.now());
    await page.locator('[data-dg="resume-work"]').click(); await poll(page, async () => !(await db.doc('workOrders/essential-work').get()).data().hold);
    results.push('assignee acknowledgement and reasoned hold/resume retain lifecycle and overdue deadline');
    await page.evaluate(() => DGOperations.openAttention()); await page.locator('#woAttention').waitFor(); assert.match(await page.locator('#woAttention').innerText(), /긴급|기한 초과/);
    await page.evaluate(async value => { const ref = db.doc('workOrders/essential-work'), old = (await ref.get()).data(); await ref.update({ status: 'in_progress', revision: old.revision + 1 }); await db.doc('photos/essential-after').set({ lightId: old.lightId, workId: 'essential-work', kind: 'work', by: 'local', data: value, label: '조치 후', at: Date.now() }); await ref.update({ afterPhotos: ['essential-after'] }); await DGOperations.openWork('essential-work'); }, pixel);
    await page.locator('#woCompletionNote').fill('램프 교체'); await page.locator('#woDiagnosis').selectOption('lamp'); await page.locator('#woRepairAction').selectOption('replace');
    await page.locator('[data-status="completed"]').click(); await poll(page, async () => (await db.doc('workOrders/essential-work').get()).data().status === 'completed');
    const completed = await page.evaluate(async () => (await db.doc('workOrders/essential-work').get()).data());
    if (completed.diagnosis !== 'lamp') console.error('completion diagnostic', JSON.stringify(await page.evaluate(async () => ({ record: (await db.doc('workOrders/essential-work').get()).data(), jobs: (await DGOffline.jobs()).map(job => ({ state: job.state, kind: job.payload?.kind, input: job.payload?.input, error: job.error })), form: document.querySelector('#woDetail')?.innerText })), null, 2));
    assert.equal(completed.diagnosis, 'lamp'); assert.equal(completed.repairAction, 'replace');
    results.push('completion stores explicit cause/action and attention uses whole relevant source');
    await page.locator('[data-status="verified"]').waitFor();
    await page.evaluate(async () => { const light = S.lights.find(light => light.id === essentialLight); await db.doc('workOrders/essential-retain').set({ ...DGOperationsCore.createOrder({ title: '입력 보존', assignedTo: 'local', workflowVersion: 2 }, light, 'local', Date.now()), status: 'in_progress' }); await DGOperations.openWork('essential-retain'); });
    await page.locator('#woCompletionNote').fill('진행 중인 조치 내용'); await page.locator('#woDiagnosis').selectOption('lamp'); await page.locator('#woRepairAction').selectOption('repair');
    await page.locator('[data-dg="acknowledge-work"]').click(); await page.locator('[data-dg="acknowledge-work"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#woCompletionNote').inputValue(), '진행 중인 조치 내용'); assert.equal(await page.locator('#woDiagnosis').inputValue(), 'lamp');
    await page.locator('.dg-process summary').click(); await page.locator('#woHoldNext').fill(await page.evaluate(() => DGOperationsCore.kstDateKey(Date.now() + 3 * 86400000))); await page.locator('#woHoldAction').fill('입고 확인'); await page.locator('[data-dg="hold-work"]').click();
    await page.locator('[data-dg="resume-work"]').waitFor(); assert.equal(await page.locator('#woCompletionNote').inputValue(), '진행 중인 조치 내용'); assert.equal(await page.locator('#woRepairAction').inputValue(), 'repair');
    results.push('acknowledgement and hold preserve unfinished completion input');
    await page.evaluate(() => DGPreventive.open()); await page.locator('[data-pm="new"]').click();
    await page.locator('#pm_title').fill('반복 예방점검'); await page.locator('#pm_intervalDays').fill('1');
    await page.locator('#pm_startDate').fill(await page.evaluate(() => DGOperationsCore.kstDateKey(Date.now() - 3 * 86400000)));
    const selectedIds = await page.locator('[data-pm-light]').evaluateAll(elements => elements.slice(0, 2).map(element => element.dataset.pmLight));
    for (const id of selectedIds) await page.locator('[data-pm-light="' + id + '"]').check();
    await page.evaluate(() => DGPreventive.persistActive());
    await page.reload(); await page.waitForFunction(() => S.live && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(() => DGPreventive.resumeDraft()); await page.locator('#pm_title').waitFor(); assert.equal(await page.locator('#pm_title').inputValue(), '반복 예방점검');
    await page.locator('[data-pm="save"]').click(); await poll(page, async () => (await db.readAll('preventivePlans')).length === 1);
    await page.locator('[data-pm="generate"]').click(); await poll(page, async () => (await db.readAll('preventiveRuns')).length === 2);
    await page.waitForFunction(() => !DGPreventive.state.loading && !!document.querySelector('[data-pm="generate"]:not(:disabled)'));
    await page.locator('[data-pm="generate"]').click(); await poll(page, async () => (await db.readAll('preventiveRuns')).length === 4);
    const cycle = await page.evaluate(async () => ({ runs: await db.readAll('preventiveRuns'), work: (await db.readAll('workOrders')).filter(work => work.title === '반복 예방점검') }));
    assert.equal(cycle.work.length, 2); assert.equal(cycle.runs.filter(run => run.carried).length, 2);
    results.push('preventive draft restores; successive overdue cycles carry active work and never duplicate stock/work events');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } catch (error) { console.error(await page.locator('#sheetIn').innerText().catch(() => '')); throw error; }
  finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
