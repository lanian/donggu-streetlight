/* Mobile review navigation against isolated local data; external requests are blocked. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DONGGU_REVIEW_ROOT || path.join(__dirname, '..'));
const screenshotDirectory = process.env.DONGGU_REVIEW_SCREENSHOT_DIR && path.resolve(process.env.DONGGU_REVIEW_SCREENSHOT_DIR);
const latitude = 35.14, longitude = 126.93;
const longitudeAt = meters => longitude + meters / (111320 * Math.cos(latitude * Math.PI / 180));
const registry = { cols: ['id', 'kind', 'code', 'dong', 'lampType', 'lat', 'lng'], count: 2, rows: [
  ['review-nav-a', '가로등', '검증로 1', '지산동', 'LED일반형', latitude, longitudeAt(-35)],
  ['review-nav-b', '가로등', '검증로 2', '지산동', 'LED일반형', latitude, longitudeAt(35)]
] };
const server = http.createServer((req, res) => {
  let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { return res.writeHead(400).end(); }
  const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  const results = [], errors = []; let browser, context;
  const record = label => { results.push(label); console.log('PASS: ' + label); };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  try {
    browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.fulfill({ status: 200, body: '', contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/plain' });
      if (url.pathname === '/data/lights.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(registry) });
      return route.continue();
    });
    const page = await context.newPage();
    const screenshot = async name => {
      if (!screenshotDirectory) return;
      fs.mkdirSync(screenshotDirectory, { recursive: true });
      await page.screenshot({ path: path.join(screenshotDirectory, name), fullPage: false });
    };
    page.on('pageerror', error => errors.push(error.stack || error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin);
    await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGOffline.ready && DGIntegration.initialized && DGLighting.state.loaded && DGLightingAreas.state.loaded);
    assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null);
    assert.equal(await page.evaluate(() => S.me), 'local');
    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); window.__reviewDownloads = []; dl = { save: async value => __reviewDownloads.push(value) }; });
    await page.locator('[data-asec="light"]').click();
    await page.locator('[data-rvmode="pairs"]').click();
    await page.locator('#rvRun').click();
    await page.waitForFunction(() => S.review?.historyState === 'synced');
    assert.equal(await page.locator('.rv-candidate').count(), 1);
    assert.equal(await page.evaluate(() => S.review.cands.length), 1);
    await page.evaluate(() => {
      window.__realReview = S.review;
      window.__reviewFixture = (specs, options = {}) => {
        const old = __realReview, template = old.cands[0];
        const candidates = specs.map((spec, index) => {
          const classification = spec.classification || 'observed_dark', length = spec.length || 80;
          const start = { lat: 35.14 + index * .000012, lng: 126.929 }, end = { lat: start.lat, lng: start.lng + length / (111320 * Math.cos(start.lat * Math.PI / 180)) };
          const dark = classification === 'observed_dark', conflict = classification === 'conflict', bright = classification === 'observed_bright';
          return { name: spec.name, wayId: 'nav-road-' + index, type: 'residential', typeLabel: '주택가 도로', dong: spec.dong || '지산동',
            len: length, mid: { lat: start.lat, lng: (start.lng + end.lng) / 2 }, pts: spec.points || [start, end], E: .1,
            near: [{ id: 'nav-near-' + index, code: spec.code || '경계등-' + (index + 1) }], nolight: false, dark: false, score: spec.score || 0,
            context: { ...structuredClone(template.context), classification, base: .1, adjusted: bright ? .5 : .1,
              coverage: { total: length, bright: bright ? length : 0, dark: dark ? length : 0, conflict: conflict ? length : 0, external: 0, unobserved: dark || conflict || bright ? 0 : length, supported: bright ? length : 0, unit: 'm' } }, scopeException: [] };
        });
        candidates.sort((a, b) => b.score - a.score);
        for (const c of candidates) c.key = rvCandidateKey(c);
        S.review = { ...old, mode: 'roads', cands: candidates, show: 20, areas: [], historyState: 'synced', historyError: '', inputRevision: S.rvRevision || 0, validUntil: Infinity };
        S.rvQuery = options.query || ''; S.rvEvidence = options.filter || 'all'; S.rvSort = options.sort || 'priority'; S.rvSelectedKey = ''; S.rvListScroll = 0;
        openAdminSection('light');
      };
    });
    record('real pair review starts with the correct local registry and a complete review archive');

    const specs = [
      { name: '가람길', classification: 'observed_dark', length: 80, score: 250, code: '경계등-가람' },
      { name: '나무길', classification: 'model_weak', length: 120, score: 100 },
      { name: '다온길', classification: 'conflict', length: 60, score: 280 },
      { name: '라온길', classification: 'observed_bright', length: 100, score: -160 },
      { name: '마루길', classification: 'observed_dark', length: 300, score: 255 }
    ];
    const visibleNames = () => page.locator('.rv-candidate > .split > b').allTextContents().then(names => names.map(name => name.replace(/^#\d+\s+/, '')));
    await page.evaluate(input => __reviewFixture(input), specs);
    assert.deepEqual(await visibleNames(), ['다온길', '마루길', '가람길', '나무길', '라온길']);
    await page.locator('#rvSort').selectOption('length');
    assert.deepEqual(await visibleNames(), ['마루길', '나무길', '라온길', '가람길', '다온길']);
    await page.locator('#rvSort').selectOption('name');
    assert.deepEqual(await visibleNames(), ['가람길', '나무길', '다온길', '라온길', '마루길']);
    await page.locator('#rvEvidence').selectOption('dark');
    assert.deepEqual(await visibleNames(), ['가람길', '다온길', '마루길']);
    await page.locator('#rvQuery').fill('경계등-가람');
    await page.waitForFunction(() => document.querySelectorAll('.rv-candidate').length === 1);
    assert.deepEqual(await visibleNames(), ['가람길']);
    await page.locator('[data-rvclear]').click();
    assert.equal(await page.locator('#rvQuery').inputValue(), '');
    assert.equal(await page.locator('#rvEvidence').inputValue(), 'all');
    assert.equal(await page.locator('#rvSort').inputValue(), 'priority');
    assert.deepEqual(await visibleNames(), ['다온길', '마루길', '가람길', '나무길', '라온길']);
    record('search, dark/conflict filter and three sort choices produce the intended candidates and reset together');

    await page.locator('#rvEvidence').selectOption('dark');
    await page.locator('#rvSort').selectOption('length');
    await page.locator('#csv4').click();
    const csv = await page.evaluate(() => __reviewDownloads.at(-1).data);
    const exported = csv.replace(/^\ufeff/, '').split('\r\n').slice(1).map(row => row.split(',')[3].replace(/^"|"$/g, ''));
    assert.deepEqual(exported, ['마루길', '가람길', '다온길']);
    assert.deepEqual(await visibleNames(), exported);
    record('current-view CSV exports every filtered candidate in the same visible order');
    await page.locator('.rv-toolbar').scrollIntoViewIfNeeded();
    await screenshot('donggu-review-list.png');

    await page.locator('[data-rvclear]').click();
    await page.locator('#rvQuery').focus();
    await page.evaluate(() => {
      window.__composingInput = document.getElementById('rvQuery');
      __composingInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      __composingInput.value = 'ㄱ';
      __composingInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true, data: 'ㄱ' }));
    });
    // Exceed the search debounce while an IME owns the input node.
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => __composingInput.isConnected && __composingInput === document.getElementById('rvQuery') && document.activeElement === __composingInput), true, 'Korean composition must keep its focused input node');
    assert.equal(await page.locator('.rv-candidate').count(), 5, 'partial Korean composition must not filter the list');
    await page.evaluate(() => {
      __composingInput.value = '가람';
      __composingInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '가람' }));
      __composingInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', isComposing: false, data: '가람' }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.rv-candidate').length === 1);
    assert.equal(await page.locator('#rvQuery').inputValue(), '가람');
    assert.deepEqual(await visibleNames(), ['가람길']);
    record('Korean IME composition retains the focused node and filters only after the syllables are committed');

    const many = Array.from({ length: 35 }, (_, index) => ({ name: '검증길 ' + String(index + 1).padStart(2, '0'), length: 80 + index, score: 100 - index }));
    await page.evaluate(input => __reviewFixture(input, { query: '검증', filter: 'dark', sort: 'name' }), many);
    await page.locator('#rvMore').click();
    assert.equal(await page.locator('.rv-candidate').count(), 35);
    const seventh = page.locator('.rv-candidate').nth(6);
    await seventh.scrollIntoViewIfNeeded();
    await seventh.locator('[data-rvmap]').click();
    await page.locator('#rvMapSummary').waitFor();
    const originalScroll = await page.evaluate(() => S.rvListScroll);
    const originalKey = await page.evaluate(() => S.rvSelectedKey);
    assert.ok(originalScroll > 100, 'the selected list location must be meaningfully scrolled');
    assert.equal(await page.locator('#rvMapSummary h3').textContent(), '검증길 07');
    if (screenshotDirectory) {
      await page.waitForTimeout(300);
      await screenshot('donggu-review-map.png');
    }
    await page.waitForFunction(() => document.querySelector('.rv-map-nav')?.style.top);
    await page.locator('#sheet').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sticky = await page.evaluate(() => {
      const header = document.querySelector('#sheet .sheet-head').getBoundingClientRect(), nav = document.querySelector('.rv-map-nav').getBoundingClientRect(), sheet = document.getElementById('sheet').getBoundingClientRect();
      return { headerBottom: header.bottom, navTop: nav.top, navBottom: nav.bottom, navLeft: nav.left, navRight: nav.right, sheetLeft: sheet.left, sheetRight: sheet.right, sheetBottom: sheet.bottom };
    });
    assert.ok(sticky.navTop >= sticky.headerBottom - 2, 'map navigation must remain below the sticky title when scrolled');
    assert.ok(sticky.navBottom < sticky.sheetBottom && sticky.navLeft >= sticky.sheetLeft - 1 && sticky.navRight <= sticky.sheetRight + 1);
    await page.locator('#sheet').evaluate(el => { el.scrollTop = 0; });
    record('scrolling map evidence keeps the list/previous/next controls visible below the sticky heading');
    await page.getByRole('button', { name: '다음 후보', exact: true }).click();
    assert.equal(await page.locator('#rvMapSummary h3').textContent(), '검증길 08');
    await page.getByRole('button', { name: '이전 후보', exact: true }).click();
    assert.equal(await page.locator('#rvMapSummary h3').textContent(), '검증길 07');
    await page.locator('[data-rvback]').click();
    await page.waitForFunction(key => document.querySelector('.rv-selected')?.dataset.rvkey === key && document.activeElement === document.querySelector('.rv-selected'), originalKey);
    assert.equal(await page.locator('#rvQuery').inputValue(), '검증');
    assert.equal(await page.locator('#rvEvidence').inputValue(), 'dark');
    assert.equal(await page.locator('#rvSort').inputValue(), 'name');
    assert.ok(Math.abs(await page.locator('#sheet').evaluate(el => el.scrollTop) - originalScroll) <= 3, 'returning to the same candidate restores the original list scroll');
    assert.equal(await page.locator('.rv-candidate').count(), 35);
    record('map next/previous and list return preserve filters, expanded rows, selected candidate and list scroll');

    await page.locator('.rv-selected [data-rvmap]').click();
    await page.getByRole('button', { name: '다음 후보', exact: true }).click();
    const changedKey = await page.evaluate(() => S.rvSelectedKey);
    await page.goBack();
    await page.waitForFunction(key => !document.querySelector('#rvMapSummary') && document.querySelector('.rv-selected')?.dataset.rvkey === key, changedKey);
    assert.equal(await page.locator('#sheet.open').count(), 1);
    assert.match(await page.locator('.rv-selected > .split > b').textContent(), /검증길 08/);
    const selectedOnscreen = await page.locator('.rv-selected').evaluate(el => { const rect = el.getBoundingClientRect(), sheet = document.getElementById('sheet').getBoundingClientRect(); return rect.bottom > sheet.top && rect.top < sheet.bottom; });
    assert.equal(selectedOnscreen, true);
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    record('phone Back moves from map to the newly selected list row, then closes the sheet without another stale view');

    const paged = Array.from({ length: 205 }, (_, index) => ({ name: '검증길 ' + String(index + 1).padStart(3, '0'), length: 35, score: 1000 - index }));
    await page.evaluate(input => __reviewFixture(input), paged);
    await page.locator('[data-rvmap="all"]').click();
    await page.waitForFunction(() => gmap && gmapLayer);
    const markerCount = () => page.evaluate(() => gmapLayer.getLayers().filter(layer => layer instanceof L.CircleMarker && !(layer instanceof L.Circle)).length);
    assert.equal(await markerCount(), 200);
    assert.match(await page.locator('.rv-map-nav').textContent(), /1–200\s*\/\s*205곳/);
    await page.locator('[data-rvpage="1"]').click();
    assert.equal(await markerCount(), 5);
    assert.match(await page.locator('.rv-map-nav').textContent(), /201–205\s*\/\s*205곳/);
    assert.equal(await page.getByRole('button', { name: '다음 200곳', exact: true }).isDisabled(), true);
    await page.evaluate(() => gmapLayer.getLayers().filter(layer => layer instanceof L.CircleMarker && !(layer instanceof L.Circle)).at(-1).openPopup());
    await page.locator('.leaflet-popup [data-rvmap="204"]').click();
    assert.equal(await page.locator('#rvMapSummary h3').textContent(), '검증길 205');
    assert.equal(await page.getByRole('button', { name: '다음 후보', exact: true }).isDisabled(), true);
    await page.locator('[data-rvback]').click();
    await page.waitForFunction(() => document.querySelector('.rv-selected')?.textContent.includes('검증길 205'));
    assert.equal(await page.locator('.rv-candidate').count(), 205);
    record('all 205 candidates are reachable through map pages and returning from the last one expands the list correctly');

    const longRoad = [{ name: '긴 도로 전체 보기', length: 2400, score: 1,
      points: [{ lat: 35.139, lng: 126.919 }, { lat: 35.144, lng: 126.932 }, { lat: 35.137, lng: 126.945 }] }];
    await page.evaluate(input => __reviewFixture(input), longRoad);
    await page.locator('.rv-candidate [data-rvmap]').click();
    await page.waitForFunction(() => gmap && gmap.getBounds().contains([35.139, 126.919]) && gmap.getBounds().contains([35.137, 126.945]));
    assert.equal(await page.evaluate(() => gmap.getBounds().contains([35.144, 126.932])), true);
    assert.ok(await page.evaluate(() => gmap.getZoom()) < 18);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    record('a long bent road fits its full geometry on the mobile map without horizontal page overflow');

    await page.evaluate(() => { for (let i = 0; i < 20; i++) openReviewMap('0'); });
    // The map is one level above the list: its back chevron returns to the list, a second one closes the sheet (NAV-02).
    await page.locator('#sheet .sheet-head [data-close]').click();
    await page.waitForFunction(() => !document.querySelector('#rvMapSummary') && document.querySelector('#rvQuery'));
    // Allow queued canvas redraw and size callbacks from all removed maps to run.
    await page.waitForTimeout(350);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => gmap), null);
    await page.locator('#sheet .sheet-head [data-close]').click();
    await page.waitForFunction(() => !document.querySelector('#sheet').classList.contains('open'));
    await page.evaluate(() => openAdminSection('light'));
    await page.locator('.rv-candidate [data-rvmap]').click();
    record('twenty rapid map replacements followed by close leave no canvas redraw errors or live map');

    await page.evaluate(() => {
      window.__staleMapButton = document.querySelector('#rvMapCandidate [data-rvmap]');
      invalidateLightingReview('검증용 자료 변경');
    });
    // Invalidation leaves the map and lands on the review list one level below, which now asks for a fresh run (NAV-02/03).
    await page.waitForFunction(() => !S.review && !document.querySelector('#rvMapSummary') && S.asec === 'light' && document.querySelector('#sheet').classList.contains('open'));
    await page.evaluate(() => { __staleMapButton.click(); openReviewMap('0'); });
    assert.equal(await page.locator('#rvMapSummary').count(), 0);
    assert.match(await page.locator('#toast').textContent(), /검토를 다시 실행/);
    assert.equal(await page.evaluate(() => S.review), null);
    record('changed inputs invalidate the review and stale candidate navigation cannot reopen obsolete results');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
