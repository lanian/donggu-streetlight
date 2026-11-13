/* Official-service handoff: no live report, API, location, or private-data transmission. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '..');
const official = 'https://gjd.roadlighting.kr/slamp/repair/map', officialStatus = 'https://gjd.roadlighting.kr/slamp/repair/status';
const cols = ['id', 'lampId', 'code', 'kind', 'dong', 'road', 'addr', 'removed'];
const registry = { cols, count: 5, rows: [
  ['p111', '111', '산수동 0642', '보안등', '산수동', '', '합성 첫 번째 위치', null],
  ['p112', '112', '산수동 0642', '보안등', '산수동', '', '합성 두 번째 위치', null],
  ['p113', '113', '지호로 65-5', '가로등', '지산동', '지호로', '합성 세 번째 위치', null],
  ['public500', null, '용산동 10', '가로등', '용산동', '', '다른 출처 시설', null],
  ['p114', '114', '산수동 12', '보안등', '산수동', '', '철거 시설', true]
] };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
const turn = () => new Promise(resolve => setTimeout(resolve, 30));
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.DONGGU_CHROMIUM ? { executablePath: process.env.DONGGU_CHROMIUM } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const checks = [], errors = [];
  async function scenario(name, run, options = {}) {
    const context = await browser.newContext({ viewport: { width: options.width || 390, height: 844 }, serviceWorkers: 'block' });
    const mutations = [], sdkRequests = [], targetRequests = [], gateway = [];
    let releaseRegistry, registryStarted = false;
    const registryGate = options.holdRegistry ? new Promise(resolve => { releaseRegistry = resolve; }) : Promise.resolve();
    await context.addInitScript(({ denyClipboard }) => {
      window.__officialProbe = { gpsCalls: 0, copied: [] };
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition(success, failure) { __officialProbe.gpsCalls++; failure?.({ code: 1, message: 'Synthetic unavailable location' }); } } });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (denyClipboard) throw new DOMException('Synthetic denied', 'NotAllowedError'); __officialProbe.copied.push(text); } } });
    }, { denyClipboard: !!options.denyClipboard });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') {
        mutations.push({ method: request.method(), origin: url.origin, path: url.pathname });
        if (url.origin === origin && url.pathname === '/mock-gateway' && options.mode === 'gateway') {
          gateway.push(JSON.parse(request.postData() || '{}'));
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ receipt: 'R261108-1234ABCD' }) });
        }
        return route.abort();
      }
      if (url.pathname === '/data/lights.json' && url.origin === origin) { registryStarted = true; await registryGate; return route.fulfill({ contentType: 'application/json', body: JSON.stringify(registry) }); }
      if (url.pathname === '/report/config.js' && url.origin === origin && options.config) return route.fulfill({ contentType: 'text/javascript', body: 'window.REPORT_CONFIG=' + JSON.stringify(options.config) + ';' });
      if (url.pathname === '/report/config.js' && url.origin === origin && options.mode === 'gateway') return route.fulfill({ contentType: 'text/javascript', body: 'window.REPORT_CONFIG=' + JSON.stringify({ backend: 'gateway', gatewayUrl: origin + '/mock-gateway', allowLocalGateway: true, privacyDays: 90, firestore: {} }) + ';' });
      if (url.pathname === '/report/config.js' && url.origin === origin && options.mode === 'external') return route.fulfill({ contentType: 'text/javascript', body: 'window.REPORT_CONFIG=' + JSON.stringify({ backend: null, sms: '010-SYNTHETIC-RECEIVER', mail: 'qa@example.test', privacyDays: 90 }) + ';' });
      if (url.origin === origin) return route.continue();
      if (/firebase/i.test(url.pathname) || url.hostname === 'www.gstatic.com') sdkRequests.push(url.pathname);
      if (url.origin === new URL(official).origin) { targetRequests.push({ url: url.href, referer: request.headers().referer || '' }); return route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="icon" href="data:,"><title>검증용 운영 화면</title><p>합성 이동 대상</p>' }); }
      return route.fulfill({ contentType: request.resourceType() === 'script' ? 'text/javascript' : 'text/css', body: '' });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(name + ': ' + error.message));
    try {
      await page.goto(origin + '/report/' + (options.query || ''), { waitUntil: 'domcontentloaded' });
      await run({ page, context, mutations, sdkRequests, targetRequests, gateway, releaseRegistry: () => releaseRegistry?.(), registryStarted: () => registryStarted });
      checks.push(name); console.log('PASS: ' + name);
    } finally { releaseRegistry?.(); await context.close(); }
  }
  async function openAssist(page) {
    if (!await page.locator('#contentAssist').evaluate(el => el.open)) await page.locator('#assistSummary').click();
    assert.equal(await page.locator('#contentAssist').evaluate(el => el.open), true);
  }
  async function choose(page, value, index = 0) {
    if (await page.locator('#codeEdit').isVisible()) await page.locator('#codeEdit').click();
    await page.locator('#codeIn').fill(value);
    await page.locator('#codeHint .pick button').nth(index).waitFor();
    await page.locator('#codeHint .pick button').nth(index).click();
  }
  async function assertUnsent(page) {
    assert.equal(await page.locator('#done').isVisible(), false);
    assert.equal(await page.locator('#statusView').isVisible(), false);
    assert.equal(await page.locator('#receipt').textContent(), '');
  }
  try {
    await scenario('default page gives an official handoff without collecting private inputs or opening a fake receipt', async ({ page, mutations, sdkRequests }) => {
      assert.equal(await page.locator('#officialEntry').count(), 1, 'The approved official handoff entry must exist.');
      assert.equal(await page.locator('#officialEntry').isVisible(), true);
      assert.equal(await page.locator('#officialOpen').getAttribute('href'), official);
      assert.equal(await page.locator('#officialOpen').getAttribute('target'), '_blank');
      assert.notEqual(await page.locator('#officialOpen').getAttribute('tabindex'), '-1', 'An enabled official link is keyboard reachable.');
      assert.match(await page.locator('#officialOpen').getAttribute('rel'), /noopener/);
      assert.match(await page.locator('#officialOpen').getAttribute('rel'), /noreferrer/);
      assert.equal(await page.locator('#privateInputs').isVisible(), false);
      assert.equal(await page.locator('#legacySubmit').isVisible(), false);
      assert.equal(await page.locator('#contentAssist').evaluate(el => el.open), false, 'Draft assistance remains optional beside the primary official action.');
      assert.equal(await page.evaluate(() => __officialProbe.gpsCalls), 0);
      assert.deepEqual(sdkRequests, []); assert.deepEqual(mutations, []); await assertUnsent(page);
    });
    await scenario('the official page opens separately with no query, referrer, opener or automatic registration', async ({ page, context, mutations, targetRequests }) => {
      await openAssist(page); await page.locator('#desc').fill('이 창에 남겨 둘 합성 메모');
      const before = await page.url();
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#officialOpen').click()]);
      await popup.waitForLoadState('domcontentloaded');
      assert.equal(popup.url(), official); assert.equal(await popup.evaluate(() => window.opener), null);
      assert.equal(await popup.evaluate(() => document.referrer), ''); assert.equal(page.url(), before);
      assert.equal(await page.locator('#desc').inputValue(), '이 창에 남겨 둘 합성 메모');
      assert.deepEqual(targetRequests.map(item => item.url), [official]); assert.equal(targetRequests[0].referer, '');
      assert.equal(context.pages().length, 2); assert.deepEqual(mutations, []); await assertUnsent(page); await popup.close();
    }, { query: '?c=%EC%82%B0%EC%88%98%EB%8F%99%200642&lid=p111&contact=010-SYNTHETIC-QUERY&url=https%3A%2F%2Fevil.example%2F' });
    await scenario('a verified QR facility copies only the selected plate, external number, issue and complete memo', async ({ page, context, mutations, sdkRequests }) => {
      await page.locator('#codeConfirmed').waitFor({ state: 'visible' }); await openAssist(page);
      const memo = '줄바꿈을 보존하는 합성 메모\n인근 보도에서 확인했습니다. '.repeat(9).slice(0, 480).trim();
      await page.locator('#issues button').first().click(); await page.locator('#desc').fill(memo);
      await page.evaluate(() => { document.querySelector('#contact').value = '010-SYNTHETIC-PRIVATE'; document.querySelector('#consent').checked = true; st.pos = { lat: 35.14, lng: 126.93, acc: 7 }; st.photo = 'data:image/png;base64,SYNTHETIC-PRIVATE-PHOTO'; });
      await page.locator('#officialCopy').click();
      const text = await page.evaluate(() => __officialProbe.copied.at(-1));
      assert.equal(typeof text, 'string'); assert.match(text, /산수동 0642/); assert.match(text, /111/); assert.match(text, /불이 꺼져/); assert.ok(text.includes(memo));
      assert.match(text, /접수 전|접수전|전송 전/); assert.doesNotMatch(text, /010-SYNTHETIC|35\.14|126\.93|SYNTHETIC-PRIVATE-PHOTO|data:image|R\d{6}-/);
      assert.equal(await page.locator('#officialSummary').inputValue(), text); assert.equal(context.pages().length, 1, 'Copy does not open an asynchronous popup.');
      assert.match(await page.locator('#officialCopyState').textContent(), /복사/); assert.equal(await page.locator('#desc').inputValue(), memo);
      await page.evaluate(async () => { const button = document.querySelector('#send'); if (typeof button.onclick === 'function') await button.onclick(); else button.click(); });
      assert.deepEqual(mutations, []); assert.deepEqual(sdkRequests, []); assert.equal(await page.evaluate(() => __officialProbe.gpsCalls), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('dg-report-receipts')), null); await assertUnsent(page);
    }, { query: '?c=%EC%82%B0%EC%88%98%EB%8F%99%200642&lid=p111' });
    await scenario('the stable facility ID wins over a stale QR plate label', async ({ page }) => {
      await page.locator('#codeConfirmed').waitFor({ state: 'visible' }); await openAssist(page); await page.locator('#officialCopy').click();
      const text = await page.evaluate(() => __officialProbe.copied.at(-1));
      assert.match(text, /산수동 0642/); assert.match(text, /111/); assert.doesNotMatch(text, /오래된 다른 표찰/);
      await page.locator('#codeEdit').click();
      assert.equal(await page.locator('#codeIn').inputValue(), '산수동 0642', 'Editing keeps the visible plate in the input.');
      await page.locator('#officialCopy').click();
      const edited = await page.evaluate(() => __officialProbe.copied.at(-1));
      assert.match(edited, /산수동 0642/, 'The copied memo matches the unchanged visible plate immediately after edit.');
      assert.doesNotMatch(edited, /111|오래된 다른 표찰/, 'Editing clears the old verified facility connection.');
      assert.equal(await page.locator('#codeConfirmed').isVisible(), false);
    }, { query: '?c=' + encodeURIComponent('오래된 다른 표찰') + '&lid=p111' });
    await scenario('an explicit missing QR ID never falls back to a duplicate visible plate', async ({ page }) => {
      await page.waitForFunction(() => typeof LIGHTS !== 'undefined' && Array.isArray(LIGHTS));
      await openAssist(page); await page.locator('#officialCopy').click();
      const text = await page.evaluate(() => __officialProbe.copied.at(-1));
      assert.match(text, /산수동 0642/); assert.doesNotMatch(text, /111|112/);
      assert.equal(await page.locator('#codeConfirmed').isVisible(), false);
      await choose(page, '산수동 0642', 1); assert.equal(await page.evaluate(() => st.lightId), 'p112');
      await page.locator('#officialCopy').click(); assert.match(await page.evaluate(() => __officialProbe.copied.at(-1)), /112/);
    }, { query: '?c=%EC%82%B0%EC%88%98%EB%8F%99%200642&lid=missing123' });
    await scenario('removed and unmapped facility IDs are never manufactured into external facility numbers', async ({ page }) => {
      await page.waitForFunction(() => typeof LIGHTS !== 'undefined' && Array.isArray(LIGHTS));
      await openAssist(page); await page.locator('#officialCopy').click(); assert.doesNotMatch(await page.evaluate(() => __officialProbe.copied.at(-1)), /114/);
      await choose(page, '용산동 10'); await page.locator('#officialCopy').click();
      const text = await page.evaluate(() => __officialProbe.copied.at(-1)); assert.match(text, /용산동 10/); assert.doesNotMatch(text, /500/);
    }, { query: '?c=%EC%82%B0%EC%88%98%EB%8F%99%2012&lid=p114' });
    await scenario('editing a QR while its registry is loading rejects the stale facility completion', async ({ page, registryStarted, releaseRegistry }) => {
      const deadline = Date.now() + 10000; while (!registryStarted()) { if (Date.now() > deadline) throw new Error('The QR registry lookup did not start.'); await turn(); }
      await page.locator('#codeEdit').click(); await page.locator('#codeIn').fill('지호로 65-5'); releaseRegistry();
      await page.locator('#codeHint .pick button').first().waitFor(); assert.equal(await page.locator('#codeHint .pick button b').first().textContent(), '지호로 65-5');
      assert.notEqual(await page.evaluate(() => st.lightId), 'p111');
      await page.locator('#codeHint .pick button').first().click(); await openAssist(page); await page.locator('#officialCopy').click();
      assert.match(await page.evaluate(() => __officialProbe.copied.at(-1)), /113/); assert.doesNotMatch(await page.evaluate(() => __officialProbe.copied.at(-1)), /111/);
    }, { query: '?c=%EC%82%B0%EC%88%98%EB%8F%99%200642&lid=p111', holdRegistry: true });
    await scenario('denied clipboard access keeps the draft and selects the readonly memo for manual copy', async ({ page, context, mutations }) => {
      await openAssist(page); await page.locator('#desc').fill('권한 거부 뒤에도 남는 합성 메모'); await page.locator('#officialCopy').click();
      const manual = await page.locator('#officialSummary').evaluate(el => ({ focused: document.activeElement === el, selected: el.selectionEnd - el.selectionStart, length: el.value.length, readonly: el.readOnly }));
      assert.equal(manual.focused, true); assert.equal(manual.readonly, true); assert.equal(manual.selected, manual.length); assert.ok(manual.length > 0);
      assert.match(await page.locator('#officialCopyState').textContent(), /직접|선택|복사/); assert.equal(await page.locator('#desc').inputValue(), '권한 거부 뒤에도 남는 합성 메모');
      assert.equal(context.pages().length, 1); assert.deepEqual(mutations, []); await assertUnsent(page);
    }, { denyClipboard: true });
    await scenario('official status shortcuts use the verified service without exposing local receipt query values', async ({ page, mutations, targetRequests }) => {
      assert.equal(await page.locator('#statusView').isVisible(), false); assert.equal(await page.locator('#statusOpen').isVisible(), false);
      assert.equal(await page.locator('#officialStatus').isVisible(), true); assert.equal(await page.locator('#officialStatus').getAttribute('href'), officialStatus);
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#officialStatus').click()]); await popup.waitForLoadState('domcontentloaded');
      assert.equal(popup.url(), officialStatus); assert.equal(targetRequests[0].referer, ''); assert.deepEqual(mutations, []); await assertUnsent(page); await popup.close();
    }, { query: '?status=1&r=R261108-1234ABCD&k=SYNTHETIC-PRIVATE-CODE' });
    for (const [label, url] of [['scheme', 'javascript:alert(1)'], ['lookalike', 'https://gjd.roadlighting.kr.evil.example/slamp/repair/map'], ['credentials', 'https://user:password@gjd.roadlighting.kr/slamp/repair/map'], ['query', official + '?contact=SYNTHETIC-PRIVATE']]) {
      await scenario('invalid destination ' + label, async ({ page, mutations, targetRequests, sdkRequests }) => {
        const link = page.locator('#officialOpen'); assert.equal(await link.getAttribute('href'), null); assert.equal(await link.getAttribute('aria-disabled'), 'true');
        assert.equal(await page.locator('#privateInputs').isVisible(), false); assert.equal(await page.evaluate(() => __officialProbe.gpsCalls), 0); assert.deepEqual(sdkRequests, []); assert.deepEqual(mutations, []); assert.deepEqual(targetRequests, []); await assertUnsent(page);
      }, { config: { backend: 'official', officialUrl: url, officialName: '검증용 운영서비스' } });
    }
    await scenario('a configured official phone stays reachable when the operating service cannot be used', async ({ page, mutations, targetRequests }) => {
      const phone = page.locator('#officialPhone'); assert.equal(await phone.isVisible(), true);
      assert.equal(await phone.getAttribute('href'), 'tel:0621234567'); assert.equal(await phone.textContent(), '062-123-4567');
      assert.deepEqual(mutations, []); assert.deepEqual(targetRequests, []); await assertUnsent(page);
    }, { config: { backend: 'official', officialUrl: official, officialName: '검증용 운영서비스', phone: '062-123-4567' } });
    await scenario('an unusable destination names the configured phone instead of a dead end', async ({ page }) => {
      assert.match(await page.locator('#officialDestinationNotice').textContent(), /062-123-4567/);
      assert.equal(await page.locator('#officialPhone').isVisible(), true);
    }, { config: { backend: 'official', officialUrl: 'https://evil.example/report', phone: '062-123-4567' } });
    await scenario('without a configured phone no placeholder contact is shown', async ({ page }) => {
      assert.equal(await page.locator('#officialPhoneLine').isVisible(), false);
    }, { config: { backend: 'official', officialUrl: official } });
    await scenario('a bad optional status target does not replace the valid report destination', async ({ page }) => {
      assert.equal(await page.locator('#officialOpen').getAttribute('href'), official); assert.equal(await page.locator('#officialStatus').isVisible(), false); await assertUnsent(page);
    }, { config: { backend: 'official', officialUrl: official, officialStatusUrl: 'https://evil.example/status' } });
    await scenario('explicit gateway deployments preserve their existing form and confirmed server receipt', async ({ page, mutations, gateway, targetRequests }) => {
      assert.equal(await page.locator('#officialEntry').isVisible(), false); assert.equal(await page.locator('#privateInputs').isVisible(), true);
      assert.equal(await page.locator('#contentAssist').evaluate(el => el.open), true);
      await choose(page, '지호로 65-5'); await page.locator('#issues button').first().click(); await page.locator('#desc').fill('합성 게이트웨이 회귀');
      await page.locator('#send').click(); await page.locator('#done').waitFor({ state: 'visible' });
      assert.equal(gateway.length, 1); assert.equal(gateway[0].lightId, 'p113'); assert.equal(gateway[0].desc, '합성 게이트웨이 회귀');
      assert.equal(await page.locator('#receipt').textContent(), 'R261108-1234ABCD'); assert.match(await page.locator('#doneTitle').textContent(), /접수/);
      assert.equal(mutations.length, 1); assert.deepEqual(targetRequests, []);
    }, { mode: 'gateway' });
    await scenario('explicit SMS and mail deployments keep preparation separate from receipt completion', async ({ page, mutations, targetRequests }) => {
      assert.equal(await page.locator('#officialEntry').isVisible(), false); assert.equal(await page.locator('#privateInputs').isVisible(), true);
      await choose(page, '지호로 65-5'); await page.locator('#issues button').first().click(); await page.locator('#send').click();
      await page.locator('#done').waitFor({ state: 'visible' }); assert.match(await page.locator('#doneTitle').textContent(), /전송 전/); assert.equal(await page.locator('#receipt').textContent(), '');
      assert.equal(await page.locator('#doneCopy').isVisible(), true); assert.equal(await page.locator('#alt a').count(), 2); assert.deepEqual(mutations, []); assert.deepEqual(targetRequests, []);
    }, { mode: 'external' });
    await scenario('phone and desktop layouts keep the official primary action and optional copy controls usable', async ({ page }) => {
      const artifactDir = process.env.DONGGU_ARTIFACT_DIR; if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 }); await page.locator('#officialOpen').scrollIntoViewIfNeeded();
        if (await page.locator('#contentAssist').evaluate(el => el.open)) await page.locator('#assistSummary').click();
        assert.equal(await page.locator('#officialOpen').isVisible(), true); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (artifactDir) await page.screenshot({ path: path.join(artifactDir, 'official-report-' + width + '-entry.png'), fullPage: true });
        await openAssist(page); await page.locator('#desc').fill('모바일·PC 복사 보조 내용'); await page.locator('#officialCopy').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('#officialCopy').isVisible(), true); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const escaped = await page.locator('#contentAssist').evaluate(el => {
          const bounds = el.getBoundingClientRect();
          return [...el.querySelectorAll('textarea, .official-copy-buttons > *')].filter(control => {
            const box = control.getBoundingClientRect(); return box.left < bounds.left || box.right > bounds.right;
          }).map(control => ({ id: control.id, boxSizing: getComputedStyle(control).boxSizing, right: control.getBoundingClientRect().right, containerRight: bounds.right }));
        });
        assert.deepEqual(escaped, [], 'Draft fields and actions stay inside their card at ' + width + 'px.');
        if (artifactDir) await page.screenshot({ path: path.join(artifactDir, 'official-report-' + width + '-assist.png'), fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const longCode = 'X'.repeat(40);
      await page.goto(origin + '/report/?c=' + encodeURIComponent(longCode), { waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('#codeText').textContent(), longCode);
      const longPlateLayout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(longPlateLayout.document <= longPlateLayout.viewport, 'A 40-character QR plate stays within the phone viewport: ' + JSON.stringify(longPlateLayout));
      if (artifactDir) await page.screenshot({ path: path.join(artifactDir, 'official-report-390-long-plate.png'), fullPage: true });
    });
  } finally { await browser.close(); server.close(); }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
