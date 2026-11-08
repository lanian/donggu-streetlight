/* Browser lifecycle contract for the shared print transport. No production data or requests. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DG_PRINT_ROOT || path.join(__dirname, '..'));
const fixture = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>원래 시설 업무</title><style>#sourceScroll{height:180px;overflow:auto}.spacer{height:900px}</style><script>window.FIREBASE_CONFIG=null;window.S={asec:"dashboard",me:"account-a"};window.NAV={gen:7,stack:[{key:"asec:dashboard"}]};</script><script src="/app/print.js"></script></head><body><main id="source"><button id="printButton">인쇄 / PDF</button><textarea id="draft" data-ux-dirty="true">보존할 초안</textarea><div id="sourceScroll"><div class="spacer">원래 화면</div></div></main></body></html>';
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/__print-fixture') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(fixture); }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', path.extname(file) === '.js' ? 'text/javascript' : 'text/plain'); res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
  const checks = [], errors = [];
  async function scenario(name, run) {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(name + ': ' + error.message));
    try {
      await page.goto(origin + '/__print-fixture');
      assert.equal(await page.evaluate(() => typeof globalThis.DongguPrint), 'object', 'the real shared print module must be loaded');
      await run(page); checks.push(name); console.log('PASS: ' + name);
    } finally { await page.close(); }
  }
  try {
    await scenario('frozen output preserves the source view, history, scroll and dirty draft, and keeps button/table/QR contents', async page => {
      const result = await page.evaluate(async () => {
        history.pushState({ nav: 1, screen: 'dashboard' }, '', '?source=dashboard');
        document.querySelector('#sourceScroll').scrollTop = 210;
        document.querySelector('#draft').value = '작성 중인 실제 입력';
        const snapshot = () => ({ html: document.querySelector('#source').innerHTML, draft: document.querySelector('#draft').value, dirty: document.querySelector('#draft').dataset.uxDirty, scroll: document.querySelector('#sourceScroll').scrollTop, history: history.length, state: JSON.stringify(history.state), nav: JSON.stringify(NAV), section: S.asec, title: document.title });
        const before = snapshot(); let printed;
        window.print = () => { const target = document.querySelector('#reportPrintRoot'); printed = { title: document.title, kind: target.dataset.printKind, text: target.textContent, buttons: target.querySelectorAll('button').length, tables: target.querySelectorAll('table').length, qr: target.querySelectorAll('svg').length, hidden: target.style.display, printing: document.body.classList.contains('dg-report-printing') }; };
        await DongguPrint.run({ html: '<header class="sheet-head">조작 제목</header><section><h2>검수 현황</h2><p class="noprint">숨길 조작</p><button class="light-row"><b>산수동 642</b><span>반복 고장 3회</span></button><table><tr><td>자재비 1,000원</td></tr></table><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg></section><footer class="sheet-foot">조작 바닥</footer>', title: '동구 검수 현황', kind: 'labels', isCurrent: () => true, button: document.querySelector('#printButton') });
        const after = snapshot(), button = document.querySelector('#printButton');
        const buttonRestored = !button.disabled && button.textContent === '인쇄 / PDF';
        window.dispatchEvent(new Event('afterprint'));
        return { before, after, printed, buttonRestored, busy: DongguPrint.busy(), roots: document.querySelectorAll('#reportPrintRoot').length, classLeft: document.body.classList.contains('dg-report-printing') };
      });
      assert.deepEqual(result.after, result.before); assert.equal(result.buttonRestored, true);
      assert.equal(result.printed.title, '동구 검수 현황'); assert.equal(result.printed.kind, 'labels');
      assert.equal(result.printed.buttons, 0); assert.equal(result.printed.tables, 1); assert.equal(result.printed.qr, 1);
      assert.match(result.printed.text, /산수동 642/); assert.match(result.printed.text, /반복 고장 3회/);
      assert.doesNotMatch(result.printed.text, /숨길 조작|조작 제목|조작 바닥/);
      assert.equal(result.printed.hidden, 'none'); assert.equal(result.printed.printing, true);
      assert.equal(result.busy, false); assert.equal(result.roots, 0); assert.equal(result.classLeft, false);
    });

    await scenario('preparation freezes HTML and rejects a duplicate click without opening a second dialog', async page => {
      const result = await page.evaluate(async () => {
        let resolve, calls = 0, printed = ''; const gate = new Promise(r => { resolve = r; });
        window.print = () => { calls++; printed = document.querySelector('#reportPrintRoot').textContent; };
        const options = { html: '<p>처음 선택한 자료</p>', prepare: () => gate, isCurrent: () => true };
        const first = DongguPrint.run(options); options.html = '<p>나중 자료</p>';
        const duplicate = await DongguPrint.run({ html: '<p>중복 클릭</p>' }).then(() => null, error => ({ code: error.code, message: error.message }));
        resolve(); await first; window.dispatchEvent(new Event('afterprint'));
        return { calls, printed, duplicate, busy: DongguPrint.busy() };
      });
      assert.equal(result.calls, 1); assert.match(result.printed, /처음 선택한 자료/); assert.doesNotMatch(result.printed, /나중 자료/);
      assert.equal(result.duplicate.code, 'print-busy'); assert.match(result.duplicate.message, /인쇄|출력/); assert.equal(result.busy, false);
    });

    for (const change of ['navigation', 'account']) await scenario('scope change during preparation cancels late print: ' + change, async page => {
      const result = await page.evaluate(async change => {
        let resolve, calls = 0; const gate = new Promise(r => { resolve = r; }), gen = NAV.gen, actor = S.me;
        window.print = () => { calls++; };
        const job = DongguPrint.run({ html: '<p>이전 화면 자료</p>', prepare: () => gate, isCurrent: () => NAV.gen === gen && S.me === actor, button: document.querySelector('#printButton') }).catch(error => ({ code: error.code, message: error.message }));
        if (change === 'navigation') NAV.gen++; else S.me = 'account-b'; resolve();
        const failure = await job; return { calls, failure, busy: DongguPrint.busy(), roots: document.querySelectorAll('#reportPrintRoot').length, disabled: document.querySelector('#printButton').disabled, title: document.title };
      }, change);
      assert.equal(result.calls, 0); assert.equal(result.failure.code, 'print-cancelled'); assert.match(result.failure.message, /화면|계정|취소/);
      assert.equal(result.roots, 0); assert.equal(result.busy, false); assert.equal(result.disabled, false); assert.equal(result.title, '원래 시설 업무');
    });

    await scenario('scope is rechecked after delayed image decoding', async page => {
      await page.evaluate(() => {
        let resolve; window.__decodeGate = new Promise(r => { resolve = r; }); window.__resolveDecode = resolve; window.__printCalls = 0;
        const actor = S.me; window.print = () => { __printCalls++; };
        window.__job = DongguPrint.run({ html: '<figure><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="><figcaption>시설 증빙</figcaption></figure>', isCurrent: () => S.me === actor, prepare: target => { target.querySelector('img').decode = () => { window.__decoding = true; return __decodeGate; }; } }).then(() => null, error => ({ code: error.code }));
      });
      await page.waitForFunction(() => window.__decoding);
      const result = await page.evaluate(async () => { S.me = 'account-b'; __resolveDecode(); return { failure: await __job, calls: __printCalls, roots: document.querySelectorAll('#reportPrintRoot').length, busy: DongguPrint.busy() }; });
      assert.equal(result.calls, 0); assert.equal(result.failure.code, 'print-cancelled'); assert.equal(result.roots, 0); assert.equal(result.busy, false);
    });

    await scenario('scope is rechecked after fonts and immediately before printing', async page => {
      const result = await page.evaluate(async () => {
        const nativeRaf = window.requestAnimationFrame; let frames = 0, calls = 0, resolveFonts;
        const fontGate = new Promise(r => { resolveFonts = r; });
        Object.defineProperty(document.fonts, 'ready', { configurable: true, get: () => fontGate });
        const gen = NAV.gen; window.print = () => { calls++; };
        const first = DongguPrint.run({ html: '<p>글꼴 대기</p>', isCurrent: () => NAV.gen === gen }).catch(error => error.code);
        NAV.gen++; resolveFonts(); const fontFailure = await first; delete document.fonts.ready;
        const nextGen = NAV.gen;
        window.requestAnimationFrame = callback => nativeRaf.call(window, time => { if (++frames === 2) NAV.gen++; callback(time); });
        const frameFailure = await DongguPrint.run({ html: '<p>최종 화면 확인</p>', isCurrent: () => NAV.gen === nextGen }).catch(error => error.code);
        window.requestAnimationFrame = nativeRaf; return { fontFailure, frameFailure, calls, frames, busy: DongguPrint.busy() };
      });
      assert.equal(result.fontFailure, 'print-cancelled'); assert.equal(result.frameFailure, 'print-cancelled'); assert.equal(result.calls, 0); assert.equal(result.frames, 2); assert.equal(result.busy, false);
    });

    await scenario('native print failure restores title, button and source and clears temporary output', async page => {
      const result = await page.evaluate(async () => {
        const source = document.querySelector('#source').innerHTML;
        window.print = () => { throw new Error('native printing blocked'); };
        const failure = await DongguPrint.run({ html: '<p>실패할 출력</p>', title: '임시 출력 제목', button: document.querySelector('#printButton') }).catch(error => ({ code: error.code, message: error.message }));
        window.dispatchEvent(new Event('afterprint'));
        return { sourceUnchanged: source === document.querySelector('#source').innerHTML, failure, title: document.title, disabled: document.querySelector('#printButton').disabled, roots: document.querySelectorAll('#reportPrintRoot').length, busy: DongguPrint.busy(), classLeft: document.body.classList.contains('dg-report-printing') };
      });
      assert.match(result.failure.message, /인쇄|출력/); assert.equal(result.sourceUnchanged, true); assert.equal(result.title, '원래 시설 업무');
      assert.equal(result.disabled, false); assert.equal(result.roots, 0); assert.equal(result.busy, false); assert.equal(result.classLeft, false);
    });

    await scenario('cancel releases a preparation that has not finished and prevents later output', async page => {
      const result = await page.evaluate(async () => {
        let resolve, calls = 0; const gate = new Promise(r => { resolve = r; }); window.print = () => { calls++; };
        const job = DongguPrint.run({ html: '<p>취소할 출력</p>', prepare: () => gate }).catch(error => error.code);
        DongguPrint.cancel(); const failure = await job; resolve(); await Promise.resolve();
        return { failure, calls, roots: document.querySelectorAll('#reportPrintRoot').length, busy: DongguPrint.busy() };
      });
      assert.equal(result.failure, 'print-cancelled'); assert.equal(result.calls, 0); assert.equal(result.roots, 0); assert.equal(result.busy, false);
    });

    await scenario('a browser without afterprint can reprint after cleaning the previous output', async page => {
      const result = await page.evaluate(async () => {
        let calls = 0; window.print = () => { calls++; };
        await DongguPrint.run({ html: '<p>첫 출력</p>', title: '첫 제목' }); const first = document.querySelector('#reportPrintRoot');
        await DongguPrint.run({ html: '<p>두 번째 출력</p>', title: '두 번째 제목' });
        const output = document.querySelector('#reportPrintRoot').textContent, roots = document.querySelectorAll('#reportPrintRoot').length;
        window.dispatchEvent(new Event('afterprint'));
        return { calls, output, roots, firstRemoved: !first.isConnected, title: document.title, busy: DongguPrint.busy() };
      });
      assert.equal(result.calls, 2); assert.match(result.output, /두 번째 출력/); assert.doesNotMatch(result.output, /첫 출력/); assert.equal(result.roots, 1); assert.equal(result.firstRemoved, true); assert.equal(result.title, '원래 시설 업무'); assert.equal(result.busy, false);
    });

    await scenario('image decode timeout is bounded and labels the failed image without losing its caption', async page => {
      const result = await page.evaluate(async () => {
        let text = '', calls = 0; const start = performance.now(); window.print = () => { calls++; text = document.querySelector('#reportPrintRoot').textContent; };
        await DongguPrint.run({ html: '<figure><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="><figcaption>고장 증빙 설명</figcaption></figure>', prepare: target => { target.querySelector('img').decode = () => new Promise(() => {}); } });
        const elapsed = performance.now() - start; window.dispatchEvent(new Event('afterprint')); return { text, calls, elapsed, busy: DongguPrint.busy() };
      });
      assert.equal(result.calls, 1); assert.match(result.text, /사진 표시 실패 · 원본을 확인해 주세요/); assert.match(result.text, /고장 증빙 설명/); assert.ok(result.elapsed < 10500, 'image decoding must not wait indefinitely'); assert.equal(result.busy, false);
    });
    await scenario('fallback cleanup and a late old callback never remove a newer print root', async page => {
      const result = await page.evaluate(async () => {
        const nativeTimeout = window.setTimeout, callbacks = []; window.print = () => {};
        window.setTimeout = (callback, ms, ...args) => ms >= 60000 ? (callbacks.push(callback), -1) : nativeTimeout(callback, ms, ...args);
        try {
          await DongguPrint.run({ html: '<p>첫 출력</p>' }); const oldCleanup = callbacks[0];
          await DongguPrint.run({ html: '<p>현재 출력</p>' }); oldCleanup();
          const currentSurvived = document.querySelector('#reportPrintRoot')?.textContent === '현재 출력';
          callbacks[1]();
          return { currentSurvived, roots: document.querySelectorAll('#reportPrintRoot').length, busy: DongguPrint.busy(), printingClass: document.body.classList.contains('dg-report-printing'), title: document.title };
        } finally { window.setTimeout = nativeTimeout; }
      });
      assert.equal(result.currentSurvived, true); assert.equal(result.roots, 0); assert.equal(result.busy, false); assert.equal(result.printingClass, false); assert.equal(result.title, '원래 시설 업무');
    });

    await scenario('the source print button retains its original child nodes and listeners', async page => {
      const result = await page.evaluate(async () => {
        const button = document.querySelector('#printButton'); button.innerHTML = '<span aria-hidden="true">⎙</span><span>인쇄 / PDF</span>';
        const child = button.lastElementChild; let clicks = 0; child.addEventListener('click', () => { clicks++; }); const html = button.innerHTML;
        window.print = () => {};
        await DongguPrint.run({ html: '<p>버튼 보존 검증</p>', button }); window.dispatchEvent(new Event('afterprint'));
        if (button.lastElementChild) button.lastElementChild.click();
        return { htmlPreserved: button.innerHTML === html, nodePreserved: button.lastElementChild === child, clicks, disabled: button.disabled };
      });
      assert.equal(result.htmlPreserved, true); assert.equal(result.nodePreserved, true); assert.equal(result.clicks, 1); assert.equal(result.disabled, false);
    });
    await scenario('late cleanup does not overwrite button state changed after the print call returned', async page => {
      const result = await page.evaluate(async () => {
        const button = document.querySelector('#printButton'); window.print = () => {};
        await DongguPrint.run({ html: '<p>조건 변경 전 출력</p>', button });
        button.disabled = true; button.textContent = '기간 자료를 다시 조회하세요';
        window.dispatchEvent(new Event('afterprint'));
        return { disabled: button.disabled, text: button.textContent, busy: DongguPrint.busy() };
      });
      assert.equal(result.disabled, true); assert.equal(result.text, '기간 자료를 다시 조회하세요'); assert.equal(result.busy, false);
    });
    await scenario('a native beforeprint retains a valid output but releases an obsolete waiting report', async page => {
      const result = await page.evaluate(async () => {
        const gen = NAV.gen; window.print = () => {};
        await DongguPrint.run({ html: '<p>동일 화면 출력</p>', isCurrent: () => NAV.gen === gen });
        window.dispatchEvent(new Event('beforeprint'));
        const validRetained = !!document.querySelector('#reportPrintRoot');
        NAV.gen++; window.dispatchEvent(new Event('beforeprint'));
        return { validRetained, roots: document.querySelectorAll('#reportPrintRoot').length, busy: DongguPrint.busy(), classLeft: document.body.classList.contains('dg-report-printing') };
      });
      assert.equal(result.validRetained, true); assert.equal(result.roots, 0); assert.equal(result.busy, false); assert.equal(result.classLeft, false);
    });
    await scenario('invalidating an unresolved preparation promptly releases its lock and permits the new view to print', async page => {
      await page.evaluate(() => {
        const gen = NAV.gen; window.__calls = 0; window.print = () => { __calls++; };
        window.__job = DongguPrint.run({ html: '<p>종료되지 않는 이전 사진 조회</p>', prepare: () => { window.__preparing = true; return new Promise(() => {}); }, isCurrent: () => NAV.gen === gen, button: document.querySelector('#printButton') }).catch(error => error.code);
      });
      await page.waitForFunction(() => window.__preparing);
      await page.evaluate(() => { NAV.gen++; });
      await page.waitForFunction(() => !DongguPrint.busy(), null, { timeout: 1500 });
      const result = await page.evaluate(async () => {
        const failure = await __job, button = document.querySelector('#printButton');
        await DongguPrint.run({ html: '<p>새 화면 출력</p>', button });
        const text = document.querySelector('#reportPrintRoot')?.textContent; window.dispatchEvent(new Event('afterprint'));
        return { failure, calls: __calls, text, roots: document.querySelectorAll('#reportPrintRoot').length, disabled: button.disabled };
      });
      assert.equal(result.failure, 'print-cancelled'); assert.equal(result.calls, 1); assert.equal(result.text, '새 화면 출력'); assert.equal(result.roots, 0); assert.equal(result.disabled, false);
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
