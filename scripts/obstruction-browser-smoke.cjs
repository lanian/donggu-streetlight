/* 가림·가설물과 주요 시설 우선순위: a well-lit local street, an obstruction entered through the editor,
   pairs and road reviews that pick it up, crossings near the candidate, the review map, CSV and the
   saved review archive. Local fixture data only; external requests are answered empty. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DONGGU_OBSTRUCTION_ROOT || path.join(__dirname, '..'));
const latitude = 35.14, longitude = 126.93;
const lngAt = metres => longitude + metres / (111320 * Math.cos(latitude * Math.PI / 180));
// four street lights 36 m apart: lit by the registry model alone
const registry = { cols: ['id', 'kind', 'code', 'dong', 'road', 'main', 'sub', 'lampType', 'lat', 'lng'], count: 4, rows: [-54, -18, 18, 54].map((x, i) =>
  ['p-block-' + i, '가로등', '가림로 ' + (i + 1), '지산동', '가림로', '1', String(i + 1), 'LED일반형', latitude, lngAt(x)]) };

// a tiny Overpass answer: one road, a crossing and a bus stop node, a school area, the 동구 boundary
const ring = (dLat, dLng, size) => [[latitude + dLat, longitude + dLng], [latitude + dLat, longitude + dLng + size], [latitude + dLat + size, longitude + dLng + size], [latitude + dLat + size, longitude + dLng], [latitude + dLat, longitude + dLng]].map(([lat, lon]) => ({ lat, lon }));
const overpass = { elements: [
  { type: 'way', id: 1, tags: { highway: 'residential', name: '가림로' }, geometry: [{ lat: latitude, lon: lngAt(-60) }, { lat: latitude, lon: lngAt(60) }] },
  { type: 'node', id: 2, lat: latitude, lon: lngAt(4), tags: { highway: 'crossing' } },
  { type: 'node', id: 3, lat: latitude + .0003, lon: longitude, tags: { highway: 'bus_stop', name: '가림로입구' } },
  { type: 'node', id: 4, lat: latitude + .0003, lon: longitude, tags: { amenity: 'bench' } },
  { type: 'way', id: 5, tags: { amenity: 'school', name: '가림초등학교' }, geometry: ring(.001, -.001, .001) },
  { type: 'way', id: 7, tags: { amenity: 'kindergarten', name: '가림유치원' }, geometry: ring(-.002, .001, .0004) },
  { type: 'relation', id: 6, tags: { boundary: 'administrative', admin_level: '6', name: '동구' }, members: [{ type: 'way', role: 'outer', geometry: ring(-.01, -.01, .02) }] }
] };
async function poll(page, predicate, argument, label) {
  const deadline = Date.now() + 30000;
  do { if (await page.evaluate(predicate, argument)) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}

(async () => {
  const server = http.createServer((req, res) => {
  // Browser checks always run the device (체험) mode: the deployed firebase-config.js points at the real project.
  if (req.url.split('?')[0].endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG = null;'); }
    let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return res.writeHead(400).end(); }
    const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port, results = [], errors = [];
  const record = message => { results.push(message); console.log('PASS: ' + message); };
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (/overpass/.test(url.hostname)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overpass) });
      if (url.origin !== origin) return route.fulfill({ status: 200, body: '', contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/plain' });
      if (url.pathname === '/data/lights.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(registry) });
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push('native dialog: ' + dialog.message()); dialog.dismiss(); });
    await page.goto(origin);
    await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    await poll(page, () => DGLighting.state.loaded, undefined, 'lighting context');
    await page.evaluate(() => { window.__downloads = []; dl = { save: async options => { window.__downloads.push(options); } }; S.demoRole = 'admin'; S.tab = 'admin'; render(); });
    const close = async () => { if (await page.locator('#sheet.open').count()) { await page.evaluate(() => closeSheet('all')); await page.locator('#sheet.open').waitFor({ state: 'hidden' }); } };
    const review = async mode => {
      await close(); await page.evaluate(() => openAdminSection('light'));
      await page.locator('[data-rvmode="' + mode + '"]').click();
      await page.evaluate(() => { window.__previous = S.review; });
      await page.locator('#rvRun').click();
      await poll(page, mode => !!S.review && S.review !== window.__previous && S.review.mode === mode && !S.review.stale, mode, 'the review');
      await page.locator('#rvEvidence').selectOption('all');
      return page.evaluate(() => JSON.parse(JSON.stringify(S.review.cands)));
    };

    assert.equal((await review('pairs')).length, 0, 'the 36 m street is lit by the registry model');

    // 1. the editor: 가림·가설물 has its own form, no night/schedule/lux fields, and stores an always-present record
    await close(); await page.evaluate(() => openAdminSection('lightingcontext'));
    await page.locator('[data-lc="new-obstruction"]').click(); await page.locator('#lcForm[data-kind="obstruction"]').waitFor();
    for (const id of ['#lcNight', '#lcSchedule', '#lcLux', '#lcLevel']) assert.equal(await page.locator(id).count(), 0, id + ' is not asked for an obstruction');
    await page.locator('#lcLabel').fill('가림로 신축 공사 가림막');
    await page.locator('#lcCategory').selectOption('construction');
    await page.locator('#lcLat').fill(String(latitude)); await page.locator('#lcLng').fill(String(longitude));
    await page.locator('#lcRadius').fill('20'); await page.locator('#lcStrength').selectOption('high'); await page.locator('#lcValidDays').fill('120');
    await page.locator('#lcSave').click();
    await poll(page, () => DGLighting.state.records.some(r => r.kind === 'obstruction'), undefined, 'the obstruction to be stored');
    const stored = await page.evaluate(() => DGLighting.state.records.find(r => r.kind === 'obstruction'));
    assert.equal(stored.schedule, 'always'); assert.equal(stored.strength, 'high'); assert.equal(stored.validDays, 120); assert.equal(stored.category, 'construction');
    await close(); await page.evaluate(() => openAdminSection('lightingcontext'));
    assert.match(await page.locator('#asecBody').textContent(), /가림 · 공사 가림막·비계 · 대부분 가림 · 75% 감소/);
    record('가림·가설물 editor stores an always-present construction obstruction without night, schedule or lux fields');

    // 2. pairs review: the well-spaced pair under the obstruction is now a candidate, labelled and filterable
    const pairs = await review('pairs');
    assert.ok(pairs.length >= 1 && pairs.every(c => c.context.classification === 'obstructed'), JSON.stringify(pairs.map(c => c.context.classification)));
    assert.ok(pairs[0].context.registryBase > pairs[0].context.base, 'the unobstructed registry index is kept for comparison');
    const card = page.locator('.rv-candidate').first();
    assert.match(await card.textContent(), /가림·가설물로 부족/); assert.match(await card.textContent(), /가림 1곳/);
    await card.locator('details summary').first().click();
    assert.match(await card.textContent(), /가림·가설물: 가림로 신축 공사 가림막 · 공사 가림막·비계 · 대장 빛 75% 감소/);
    assert.match(await card.textContent(), /가림 전 /);
    await page.locator('#rvEvidence').selectOption('obstructed');
    assert.equal(await page.locator('.rv-candidate').count(), pairs.length, 'the 가림·가설물 영향 filter keeps them');
    await page.locator('#rvEvidence').selectOption('all');
    record('a well-spaced pair under a 75% obstruction becomes an obstructed candidate with its evidence and filter');

    // 3. roads review with a 동구 boundary and a crossing beside the obstruction: the crossing is listed and moves it up
    await page.evaluate(({ latitude, a, b, c }) => {
      ROADS = { ver: 4, ways: [{ id: 'block-road', type: 'residential', name: '가림로', pts: [[latitude, a], [latitude, b]] }], areas: [], bounds: [],
        gu: { name: '동구', polygons: [{ outer: [[latitude - .01, a - .01], [latitude - .01, b + .01], [latitude + .01, b + .01], [latitude + .01, a - .01]], holes: [] }] },
        pois: [{ t: 'crossing', name: '', lat: latitude + .00005, lng: c }] };
      LG = null; S.review = null; invalidateLightingReview('도로망 시험');
    }, { latitude, a: lngAt(-60), b: lngAt(60), c: lngAt(4) });
    const roads = await review('roads');
    const road = roads.find(c => c.wayId === 'block-road');
    assert.ok(road, 'the obstructed stretch of the road is a candidate'); assert.equal(road.context.classification, 'obstructed');
    assert.deepEqual(road.pois.map(p => p.t), ['crossing']); assert.ok(road.pois[0].d <= 30);
    assert.match(await page.locator('.rv-candidate').first().textContent(), /횡단보도 \d+m/);
    assert.match(await page.locator('#asecBody').textContent(), /광주 동구 안만 예측해요 \(동구 경계 기준\)/);
    await page.locator('#rvEvidence').selectOption('poi');
    assert.ok(await page.locator('.rv-candidate').count() >= 1, 'the 횡단보도·정류장·학교 주변 filter shows it');
    await page.locator('#rvEvidence').selectOption('all');
    record('road review finds the obstructed stretch inside 동구 and lists the crossing next to it');

    // 4. the review map draws the obstruction; CSV carries the obstruction and the crossing
    await page.locator('[data-rvmap="all"]').click(); await page.waitForFunction(() => gmap && gmapLayer);
    assert.ok(await page.evaluate(() => gmapLayer.getLayers().some(l => l instanceof L.Circle && l.options.dashArray === '2 4')), 'the obstruction circle is on the map');
    assert.match(await page.locator('.maplegend').textContent(), /갈색: 가림·가설물/);
    await page.locator('[data-rvback]').click(); await page.locator('#csv4').waitFor();
    await page.locator('#csv4').click(); await poll(page, () => window.__downloads.length > 0, undefined, 'the CSV');
    const csv = await page.evaluate(() => window.__downloads.at(-1).data);
    assert.match(csv.split('\r\n')[0], /가림가설물.*주변시설.*가림전대장지수/);
    assert.match(csv, /가림로 신축 공사 가림막 \(75% 감소\)/); assert.match(csv, /횡단보도 \d+m/);
    record('the review map shows the obstruction and the CSV lists it with the nearby crossing');

    // 5. the saved review archive keeps the obstruction and the crossing per candidate
    await poll(page, () => S.review?.historyState && S.review.historyState !== 'preparing', undefined, 'the review archive');
    assert.equal(await page.evaluate(() => S.review.historyState), 'synced', await page.evaluate(() => S.review.historyError));
    const archived = await page.evaluate(async () => { const runs = await db.readAll('lightingRuns'); return JSON.parse(runs.sort((a, b) => b.reviewedAt - a.reviewedAt)[0].candidatesJson); });
    const row = archived.find(r => r.obstructionIds);
    assert.ok(row && row.obstructionIds.length === 1 && row.registryBase > row.base && row.pois.some(p => p.startsWith('crossing:')), JSON.stringify(row));
    record('the review archive keeps obstruction ids, the unobstructed index and nearby crossings');

    // 6. the road network download keeps crossings, bus stops and school areas as points of interest
    const loaded = await page.evaluate(async () => { ROADS = null; try { await idbSet('roads', null); } catch (_) {} const r = await roadsLoad(); return { pois: r.pois, gu: !!r.gu, areas: r.areas.map(a => a.name) }; });
    assert.ok(loaded.gu, 'the 동구 boundary arrives with the roads');
    assert.deepEqual(loaded.pois.map(p => p.t).sort(), ['bus', 'crossing', 'school', 'school']);
    assert.ok(loaded.pois.some(p => p.name === '가림유치원' && p.r > 0), 'a kindergarten mapped as an area is a point of interest');
    assert.deepEqual(loaded.areas, ['가림초등학교'], 'the kindergarten ground does not become a review exclusion area');
    const school = loaded.pois.find(p => p.t === 'school'); assert.equal(school.name, '가림초등학교'); assert.ok(school.r > 50, 'a school area keeps an approximate radius');
    assert.equal(loaded.pois.find(p => p.t === 'bus').name, '가림로입구');
    record('the Overpass download keeps crossings, bus stops and school areas next to the roads and the 동구 boundary');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
