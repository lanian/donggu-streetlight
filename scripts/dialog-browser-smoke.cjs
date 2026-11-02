/* In-app dialogs (app/dialog.js) in place of window.alert/confirm/prompt: labelled buttons, keyboard and Back-key
   behaviour, queueing, and the form guard that now asks asynchronously and repeats the leave once the person agrees. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
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
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const results = [], errors = [], nativeDialogs = [];
  const open = page => page.evaluate(() => !!document.querySelector('#dgDialog:not([hidden])'));
  const ready = page => page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized && !!window.DGDialog);
  async function scenario(name, run) {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(name + ': ' + e.message)); page.on('dialog', d => { nativeDialogs.push(name + ': ' + d.message()); d.dismiss(); });
    try { await page.goto(origin); await ready(page); await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); }); await run(page); results.push(name); }
    finally { await page.close(); }
  }
  try {
    await scenario('confirm: labelled buttons, danger focuses the safe choice, Escape says no, the button says yes', async page => {
      await page.evaluate(() => { window.__r = DGDialog.confirm('표시한 내용을 저장하지 않고 끝낼까요?', { ok: '저장 없이 끝내기', cancel: '돌아가기', danger: true }); });
      await page.locator('#dgDialog:not([hidden]) .dgdlg').waitFor();
      assert.equal(await page.locator('#dgDialog [data-dgdlg="ok"]').textContent(), '저장 없이 끝내기');
      assert.equal(await page.locator('#dgDialog [data-dgdlg="cancel"]').textContent(), '돌아가기');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.dgdlg), 'cancel', 'a destructive question starts on the safe button');
      assert.equal(await page.evaluate(() => document.querySelector('#dgDialog .dgdlg').getAttribute('aria-modal')), 'true');
      await page.keyboard.press('Escape'); await page.waitForTimeout(50);
      assert.equal(await page.evaluate(async () => await window.__r), false);
      assert.equal(await open(page), false);
      await page.evaluate(() => { window.__r = DGDialog.confirm('되돌릴까요?', { ok: '되돌리기' }); });
      await page.locator('#dgDialog:not([hidden]) [data-dgdlg="ok"]').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.dataset.dgdlg), 'ok', 'a plain question starts on OK');
      await page.locator('#dgDialog [data-dgdlg="ok"]').click();
      assert.equal(await page.evaluate(async () => await window.__r), true);
      // a tap on the backdrop is "no"
      await page.evaluate(() => { window.__r = DGDialog.confirm('x'); });
      await page.locator('#dgDialog:not([hidden])').waitFor(); await page.mouse.click(5, 5);
      assert.equal(await page.evaluate(async () => await window.__r), false);
    });
    await scenario('prompt: required input blocks an empty OK, Enter submits, cancel yields null; alert has one button', async page => {
      await page.evaluate(() => { window.__r = DGDialog.prompt('표찰 번호를 적어 주세요.', { title: '표찰 번호 변경', placeholder: '예: 산수동 915', ok: '변경', required: true }); });
      await page.locator('#dgDialog:not([hidden]) .dgdlg-field').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.className), 'dgdlg-field', 'the field has focus');
      assert.equal(await page.locator('#dgDialog .dgdlg-title').textContent(), '표찰 번호 변경');
      await page.locator('#dgDialog [data-dgdlg="ok"]').click(); await page.waitForTimeout(50);
      assert.equal(await open(page), true, 'empty required input keeps the dialog');
      await page.keyboard.type('산수동 915'); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(async () => await window.__r), '산수동 915');
      await page.evaluate(() => { window.__r = DGDialog.prompt('사진 설명 (선택)', { value: '기존 설명', maxLength: 120 }); });
      await page.locator('#dgDialog:not([hidden]) .dgdlg-field').waitFor();
      assert.equal(await page.locator('#dgDialog .dgdlg-field').inputValue(), '기존 설명');
      await page.locator('#dgDialog [data-dgdlg="cancel"]').click();
      assert.equal(await page.evaluate(async () => await window.__r), null);
      await page.evaluate(() => { window.__r = DGDialog.alert('임시 자료 정리에 실패했어요.', { title: '정리 실패' }); });
      await page.locator('#dgDialog:not([hidden])').waitFor();
      assert.equal(await page.locator('#dgDialog .dgdlg-btns button').count(), 1);
      assert.equal(await page.evaluate(() => document.querySelector('#dgDialog .dgdlg').getAttribute('role')), 'alertdialog');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(async () => await window.__r), true, 'Enter on the focused OK closes an alert');
    });
    await scenario('choose: one tap picks a value; dialogs queue instead of overlapping', async page => {
      await page.evaluate(() => { window.__r = DGDialog.choose('이 사진은 무엇을 찍은 건가요?', { title: '사진 구분', options: ['전경', '표찰', '기타'].map(v => ({ value: v })), value: '표찰' }); });
      await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
      assert.equal(await page.locator('#dgDialog [data-dgdlg-choice]').count(), 3);
      assert.equal(await page.evaluate(() => document.activeElement.textContent), '표찰', 'the current value has focus');
      await page.locator('#dgDialog [data-dgdlg-choice]', { hasText: '기타' }).click();
      assert.equal(await page.evaluate(async () => await window.__r), '기타');
      await page.evaluate(() => { window.__a = DGDialog.confirm('첫 번째'); window.__b = DGDialog.confirm('두 번째'); });
      await page.locator('#dgDialog:not([hidden])').waitFor();
      assert.equal(await page.locator('#dgDialog .dgdlg-msg').textContent(), '첫 번째');
      assert.equal(await page.locator('#dgDialog .dgdlg').count(), 1, 'one box at a time');
      await page.locator('#dgDialog [data-dgdlg="ok"]').click();
      await page.waitForFunction(() => document.querySelector('#dgDialog .dgdlg-msg')?.textContent === '두 번째');
      await page.locator('#dgDialog [data-dgdlg="cancel"]').click();
      assert.deepEqual(await page.evaluate(async () => [await window.__a, await window.__b]), [true, false]);
    });
    await scenario('phone Back while a dialog is open answers no and keeps the screen', async page => {
      await page.evaluate(() => openAdminSection('reg')); await page.locator('#nAddr').waitFor();
      const depth = await page.evaluate(() => history.state && history.state.nav);
      await page.evaluate(() => { window.__r = DGDialog.confirm('삭제할까요?', { ok: '삭제', danger: true }); });
      await page.locator('#dgDialog:not([hidden])').waitFor();
      await page.goBack(); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(async () => await window.__r), false);
      assert.equal(await open(page), false);
      assert.equal(await page.evaluate(() => document.querySelector('#sheet').classList.contains('open')), true, 'the sheet under the dialog is still there');
      assert.equal(await page.evaluate(() => history.state && history.state.nav), depth, 'the History depth is unchanged');
    });
    await scenario('form guard: agreeing in the dialog completes the leave that Back or × started', async page => {
      await page.evaluate(async () => { await DGOffline.configure({ namespace: DGOffline.namespace, durable: false, networkRequired: false }); });
      await page.evaluate(() => openAdminSection('inbox')); await page.locator('#ibNum').waitFor();
      await page.locator('#ibDesc').fill('공유 기기 입력'); await page.waitForTimeout(700);
      await page.goBack(); await page.locator('#dgDialog:not([hidden])').waitFor();
      assert.match(await page.locator('#dgDialog .dgdlg-msg').textContent(), /보관하지 않아요/);
      assert.equal(await page.locator('#dgDialog [data-dgdlg="ok"]').textContent(), '버리고 이동');
      assert.equal(await page.evaluate(() => document.querySelector('#sheet').classList.contains('open')), true, 'the form stays while the question is open');
      assert.equal(await page.evaluate(() => history.state && history.state.nav), 1, 'Back was absorbed while asking');
      await page.locator('#dgDialog [data-dgdlg="ok"]').click();
      await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
      assert.equal(await page.evaluate(() => history.state && history.state.nav), 0, 'the agreed leave went through History');
      // × then "머무르기" keeps everything; × then "버리고 이동" closes
      await page.evaluate(() => openAdminSection('inbox')); await page.locator('#ibNum').waitFor();
      await page.locator('#ibDesc').fill('두 번째 입력'); await page.waitForTimeout(700);
      await page.locator('#sheet .sheet-head .x[data-close]').click(); await page.locator('#dgDialog:not([hidden])').waitFor();
      await page.locator('#dgDialog [data-dgdlg="cancel"]').click(); await page.waitForTimeout(200);
      assert.equal(await page.locator('#ibDesc').inputValue(), '두 번째 입력');
      await page.locator('#sheet .sheet-head .x[data-close]').click(); await page.locator('#dgDialog:not([hidden])').waitFor();
      await page.locator('#dgDialog [data-dgdlg="ok"]').click();
      await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    });
    await scenario('the shipped code no longer calls window.alert/confirm/prompt directly', async page => {
      const files = ['index.html', 'security.js', ...fs.readdirSync(path.join(root, 'app')).filter(f => f.endsWith('.js')).map(f => 'app/' + f)];
      for (const file of files) {
        const src = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const direct = [...src.matchAll(/(^|[^.\w])(alert|confirm|prompt)\(/g)].filter(m => !/Promise\.resolve\($/.test(src.slice(Math.max(0, m.index - 20), m.index + 1)));
        assert.deepEqual(direct.map(m => file + ':' + m[0]), [], file + ' has direct native dialog calls');
      }
    });
    assert.deepEqual(errors, []); assert.deepEqual(nativeDialogs, [], 'no native dialog appeared');
    console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
