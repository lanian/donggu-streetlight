/* Full-app print regressions. Local fixtures only; Firebase and external requests are disabled. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DG_REPORT_ROOT || path.join(__dirname, '..'));
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG=null;'); }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function seedReport(page, count = 1) {
  await page.evaluate(({ photo, count }) => {
    const light = S.lights[0], now = Date.now(), year = new Date(now).getFullYear();
    Object.assign(REP, { period: 'custom', from: year + '-01-01', to: year + '-12-31', dong: '전체', photos: true, inlinePh: false, detail: 'all', err: '', loading: false });
    window.__longMemo = '상세 메모 시작\n' + '배선과 등기구 상태를 확인하고 안전하게 조치했습니다. '.repeat(35) + '\n상세 메모 끝';
    const insp = Array.from({ length: count }, (_, n) => {
      const id = 'output-photo-' + n;
      GAL[id] = { id, lightId: light.id, data: photo, label: '현장', at: now - n * 1000, by: S.me };
      return { id: 'output-inspection-' + n, lightId: light.id, code: light.code, dong: light.dong, date: now - n * 1000, result: n === 0 ? '정상' : '고장', inspector: S.me, checks: {}, memo: n === count - 1 ? __longMemo : '현장 확인 ' + n, thumbs: [{ id, label: '현장', t: photo }] };
    });
    REP.data = { key: reportQueryKey(), at: now, patrols: [], insp };
    Object.assign(REP_PH, { scope: 'all', size: 'm', page: 0 });
    S.tab = 'admin'; render(); openAdminSection('report');
  }, { photo: image, count });
  await page.waitForFunction(() => !REP_PH.loading && !NAV.leaving && !NAV.restoring && document.querySelector('#sheet #repBody'));
}
async function sourceSnapshot(page) {
  return page.evaluate(() => ({ html: document.querySelector('#sheet').innerHTML, scroll: document.querySelector('#sheet').scrollTop, history: history.length, historyState: JSON.stringify(history.state), url: location.href, generation: NAV.gen, stack: NAV.stack.map(x => x.key), section: S.asec, title: document.title, inspections: JSON.stringify(REP.data?.insp), draft: document.querySelector('#outputDraft')?.value }));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.DONGGU_CHROMIUM ? { executablePath: process.env.DONGGU_CHROMIUM } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const checks = [], errors = [];
  async function scenario(name, run) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/css', body: '' }));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(name + ': ' + error.message));
    try {
      await page.goto(origin); await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGIntegration.initialized);
      assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null);
      await run(page); checks.push(name); console.log('PASS: ' + name);
    } finally { await context.close(); }
  }
  try {
    await scenario('period output includes normal inspections, every paginated row/photo and the complete long memo', async page => {
      await seedReport(page, 121);
      assert.equal(await page.locator('#sheet [data-report-inspection]').count(), 100);
      assert.equal(await page.locator('#sheet #repPhotoAppendix img').count(), 48);
      await page.evaluate(() => { document.querySelector('#sheet').scrollTop = 180; window.__prints = []; window.print = () => {
        const output = document.querySelector('#reportPrintRoot'); __prints.push({ rows: output.querySelectorAll('[data-report-inspection]').length, normal: output.querySelector('[data-report-inspection="output-inspection-0"]')?.textContent, photos: output.querySelectorAll('#repPhotoAppendix img').length, memo: output.querySelector('.report-long-note p')?.textContent, kind: output.dataset.printKind, title: document.title, text: output.textContent });
      }; });
      const before = await sourceSnapshot(page);
      await page.evaluate(() => printSheet(document.querySelector('#repPrint')));
      const printed = await page.evaluate(() => __prints[0]);
      assert.equal(printed.rows, 121); assert.equal(printed.photos, 121); assert.match(printed.normal, /정상/);
      assert.equal(printed.memo, await page.evaluate(() => __longMemo)); assert.ok(printed.memo.length >= 1000);
      assert.match(printed.text, /전체 점검|선택 전체 121장/); assert.match(printed.title, /기간보고서/); assert.equal(printed.kind, 'report');
      assert.deepEqual(await sourceSnapshot(page), before);
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.locator('#reportPrintRoot').isVisible(), true);
      assert.equal(await page.locator('#reportPrintRoot').evaluate(el => getComputedStyle(el).page), 'dg-report');
      await page.emulateMedia({ media: 'screen' });
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      assert.equal(await page.locator('#reportPrintRoot').count(), 0); assert.deepEqual(await sourceSnapshot(page), before);
    });
    for (const change of ['navigation', 'dong', 'photos', 'inline', 'detail', 'photoScope', 'photoSize', 'account', 'database']) {
      await scenario('a delayed image cannot print after the report scope changes: ' + change, async page => {
        await seedReport(page);
        await page.evaluate(() => {
          window.__printCalls = 0; window.print = () => { __printCalls++; };
          let release; window.__decodeGate = new Promise(resolve => { release = resolve; }); window.__releaseDecode = release;
          const original = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = function () { if (this.closest('#reportPrintRoot')) { window.__decodeStarted = true; return __decodeGate; } return original.call(this); };
          window.__printing = printSheet(document.querySelector('#repPrint'));
        });
        await page.waitForFunction(() => window.__decodeStarted);
        await page.evaluate(change => {
          if (change === 'navigation') openAdminSection('dashboard');
          if (change === 'dong') REP.dong = S.lights[0].dong;
          if (change === 'photos') REP.photos = false;
          if (change === 'inline') REP.inlinePh = true;
          if (change === 'detail') REP.detail = 'issues';
          if (change === 'photoScope') REP_PH.scope = 'bad';
          if (change === 'photoSize') REP_PH.size = 'l';
          if (change === 'account') S.me = 'output-different-account';
          if (change === 'database') db = { outputDifferentDatabase: true };
          __releaseDecode();
        }, change);
        await page.evaluate(() => __printing);
        const state = await page.evaluate(() => ({ calls: __printCalls, roots: document.querySelectorAll('#reportPrintRoot').length, busy: DongguPrint.busy(), printing: document.body.classList.contains('dg-report-printing'), disabled: document.querySelector('#repPrint')?.disabled }));
        assert.equal(state.calls, 0); assert.equal(state.roots, 0); assert.equal(state.busy, false); assert.equal(state.printing, false); assert.notEqual(state.disabled, true);
      });
    }
    await scenario('a report can reprint without afterprint and stale output is released before later native printing', async page => {
      await seedReport(page, 2);
      await page.evaluate(() => { window.__printCalls = 0; window.print = () => { __printCalls++; }; });
      await page.evaluate(() => printSheet(document.querySelector('#repPrint')));
      await page.evaluate(() => printSheet(document.querySelector('#sheet #repPrint')));
      assert.equal(await page.evaluate(() => __printCalls), 2); assert.equal(await page.locator('#reportPrintRoot').count(), 1);
      await page.evaluate(() => { REP.detail = 'issues'; window.dispatchEvent(new Event('beforeprint')); });
      assert.equal(await page.locator('#reportPrintRoot').count(), 0); assert.equal(await page.evaluate(() => DongguPrint.busy()), false);
    });
    await scenario('dashboard printing preserves the source and retains repeated-fault facility names and counts', async page => {
      await page.evaluate(() => {
        const light = S.lights[0], state = DGManagement.state, now = Date.now();
        state.analytics = DGOperationsCore.analytics([0, 1].map(n => ({ id: 'repeat-' + n, lightId: light.id, date: now - n * 1000, result: '고장' })), [], [], S.lights, now - 86400000, now, []);
        state.loadedRange = state.from + '/' + state.to; state.at = now; state.error = ''; state.dashboardSource = 'local'; state.dashboardComplete = true;
        S.tab = 'admin'; render(); openAdminSection('dashboard');
        const draft = document.createElement('textarea'); draft.id = 'outputDraft'; draft.value = '변경하지 않을 초안'; draft.dataset.uxDirty = 'true'; document.querySelector('#sheet').append(draft);
        window.__printed = null; window.print = () => { const output = document.querySelector('#reportPrintRoot'); __printed = { text: output.textContent, buttons: output.querySelectorAll('button').length }; };
      });
      await page.waitForFunction(() => !NAV.leaving && !NAV.restoring);
      const before = await sourceSnapshot(page), code = await page.evaluate(() => S.lights[0].code);
      await page.locator('[data-mgmt="dashboard-print"]').click(); await page.waitForFunction(() => window.__printed);
      const printed = await page.evaluate(() => __printed);
      assert.ok(printed.text.includes(code)); assert.match(printed.text, /2회/); assert.equal(printed.buttons, 0);
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint'))); assert.deepEqual(await sourceSnapshot(page), before);
    });
    await scenario('the facility workflow print keeps its source sheet, navigation and draft', async page => {
      await page.evaluate(() => {
        const light = S.lights[0];
        DGWorkflows.state.facility = { light, orders: [], metadata: { source: 'local', complete: true, fetchedAt: Date.now() }, items: [{ kind: '점검', at: Date.now(), by: S.me, title: '출력 검증용 시설 점검', detail: '연결 이력 내용 보존', photoCount: 1 }] };
        navRoute('output-fixture-facility', () => {}); openSheet(DGWorkflows.facilityHTML(DGWorkflows.state.facility));
        const draft = document.createElement('textarea'); draft.id = 'outputDraft'; draft.value = '보존할 업무 초안'; draft.dataset.uxDirty = 'true'; document.querySelector('#sheet').append(draft);
        window.__printed = null; window.print = () => { __printed = document.querySelector('#reportPrintRoot').textContent; };
      });
      const before = await sourceSnapshot(page);
      await page.locator('[data-fw="facility-print"]').click(); await page.waitForFunction(() => window.__printed);
      assert.match(await page.evaluate(() => __printed), /출력 검증용 시설 점검/);
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint'))); assert.deepEqual(await sourceSnapshot(page), before);
    });
    await scenario('a real facility dossier keeps its full source memo and prints a complete memo appendix with readable columns', async page => {
      await page.evaluate(async photo => {
        const light = S.lights.find(item => !item.removed && !item.noPlate && item.code), now = Date.now();
        window.__dossierMemo = '시설 이력서 상세 메모 시작\n' + '접속함과 배선의 손상 여부를 확인하고 현장 조치 결과를 기록합니다. '.repeat(35) + '\n시설 이력서 상세 메모 끝';
        await Promise.all(Array.from({ length: 20 }, (_, n) => db.doc('inspections/dossier-output-' + n).set({ lightId: light.id, code: light.code, dong: light.dong, date: now - n * 1000, result: n === 19 ? '정상' : '고장', inspector: S.me, checks: {}, memo: n === 0 ? __dossierMemo : '이력서 일반 점검 ' + n })));
        await db.doc('photos/dossier-output-photo').set({ lightId: light.id, data: photo, label: '이력서 사진', at: now, by: S.me });
        await openLightDossier(light.id);
        window.__printed = null; window.print = () => {
          const output = document.querySelector('#reportPrintRoot');
          __printed = { memo: output.querySelector('.report-long-note p')?.textContent, rows: output.querySelectorAll('.report-dossier-table tbody tr').length, cols: output.querySelectorAll('.report-dossier-table col').length, controls: output.querySelectorAll('button,.noprint,.sheet-head,.sheet-foot').length, text: output.textContent, photos: output.querySelectorAll('.psheet img').length };
        };
      }, image);
      assert.equal(await page.locator('#sheet .dossier-memo').first().textContent(), await page.evaluate(() => __dossierMemo));
      const before = await sourceSnapshot(page);
      await page.evaluate(() => printSheet(document.querySelector('#psPrint')));
      const printed = await page.evaluate(() => __printed);
      assert.equal(printed.memo, await page.evaluate(() => __dossierMemo)); assert.ok(printed.memo.length >= 1000);
      assert.equal(printed.rows, 20); assert.equal(printed.cols, 4); assert.equal(printed.controls, 0); assert.equal(printed.photos, 1); assert.match(printed.text, /전체 내용: 상세 메모 1번/);
      await page.emulateMedia({ media: 'print' });
      const widths = await page.locator('#reportPrintRoot .report-dossier-table col').evaluateAll(cols => cols.slice(0, 3).map(col => parseFloat(getComputedStyle(col).width)));
      [26, 20, 26].forEach((mm, i) => assert.ok(Math.abs(widths[i] - mm * 96 / 25.4) < 1, 'the dossier date/result/inspector columns retain their print widths'));
      await page.emulateMedia({ media: 'screen' }); await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      assert.deepEqual(await sourceSnapshot(page), before);
    });
    await scenario('QR labels keep their SVG and use the separate label page contract', async page => {
      await page.evaluate(() => { QR.q = S.lights.find(light => !light.removed && !light.noPlate && light.code).code; S.tab = 'admin'; render(); openAdminSection('qr'); window.__printed = null; window.print = () => { const output = document.querySelector('#reportPrintRoot'); __printed = { kind: output.dataset.printKind, svg: output.querySelectorAll('svg').length }; }; });
      assert.ok(await page.locator('#sheet .qrgrid svg').count(), 'the fixture must select an existing physical plate');
      const before = await sourceSnapshot(page);
      await page.evaluate(() => printSheet(document.querySelector('#psPrint')));
      const printed = await page.evaluate(() => __printed); assert.equal(printed.kind, 'labels'); assert.ok(printed.svg > 0);
      await page.emulateMedia({ media: 'print' }); assert.equal(await page.locator('#reportPrintRoot').evaluate(el => getComputedStyle(el).page), 'dg-labels');
      assert.equal(await page.locator('#reportPrintRoot .help').isVisible(), false, 'label instructions must not consume the first printed page');
      await page.emulateMedia({ media: 'screen' }); await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      assert.deepEqual(await sourceSnapshot(page), before);
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks, browserErrors: errors }, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
