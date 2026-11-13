/* 미점검·방문 계획: picking targets (가까운 순, 10곳/전체 선택), the plan up top with progress and the next stop,
   per-leg distances, auto-completion from saved inspections, reordering (위/아래, 내 위치에서 다시 정렬),
   the numbered route map, 길찾기 and 다음 N곳 경로 (waypoints). GPS is a fixed fake position; nothing leaves the local registry. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  // Browser checks always run the device (체험) mode: the deployed firebase-config.js points at the real project.
  if (req.url.split('?')[0].endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG = null;'); }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
const HERE = { latitude: 35.1530952, longitude: 126.9217072, accuracy: 9 };
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', geolocation: HERE, permissions: ['geolocation'] });
  // this smoke models field use on a phone: pin the device profile (a 390px window without touch counts as a PC)
  await context.addInitScript(() => { try { localStorage.setItem('dg-device', 'phone'); } catch (e) {} });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  const stops = () => page.evaluate(() => DGOperations.state.plan.stops.map(s => s.id));
  const dist = (a, b) => { const R = 6371000, r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng), s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
  try {
    await page.goto(origin);
    await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); openAdminSection('due'); });
    await page.locator('#dgDueFilter').waitFor();
    assert.equal(await page.locator('.dg-plan').count(), 0, 'no plan yet');
    assert.equal(await page.locator('[data-dg="make-plan"]').isDisabled(), true, 'nothing picked → the plan button waits');

    // 1. 가까운 순 + 가까운 10곳 선택: the ten nearest to the fixed position, sorted outward, with distances shown
    checks.push('nearest-first picking');
    await page.locator('[data-dg="due-sort"]').click(); await page.waitForFunction(() => DGOperations.state.pos && DGOperations.state.dueSort === 'near');
    await page.locator('.dg-due-row .dg-dist').first().waitFor();
    const shown = await page.evaluate(() => [...document.querySelectorAll('.dg-due-row .dg-dist')].slice(0, 10).map(e => parseFloat(e.textContent)));
    assert.ok(shown.every((d, i) => i === 0 || d >= shown[i - 1]), 'rows are ordered by distance: ' + shown.join(','));
    await page.locator('[data-dg="pick-near"]').click(); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => DGOperations.state.planPick.size), 10);
    assert.equal(await page.locator('[data-plan-light]:checked').count(), 10, 'the ten rows are ticked');
    assert.match(await page.locator('[data-dg="make-plan"]').textContent(), /선택한 10곳/);
    const nearestIds = await page.evaluate(() => [...document.querySelectorAll('.dg-due-row')].slice(0, 10).map(r => r.querySelector('[data-plan-light]').dataset.planLight));
    // untick one by hand, then 선택 해제 clears everything
    await page.locator('[data-plan-light]').first().uncheck(); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => DGOperations.state.planPick.size), 9); assert.match(await page.locator('[data-dg="make-plan"]').textContent(), /9곳/);
    await page.locator('[data-dg="pick-none"]').click(); await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-plan-light]:checked').count(), 0);
    await page.locator('[data-dg="pick-near"]').click(); await page.waitForTimeout(200);

    // 2. the plan: starts from my position, lies above the target list, shows progress, next stop and per-leg distances
    checks.push('plan with next stop and legs');
    await page.locator('[data-dg="make-plan"]').click(); await page.waitForFunction(() => DGOperations.state.plan && DGOperations.state.plan.stops.length === 10 && document.querySelector('.dg-plan'));
    assert.deepEqual((await stops()).slice().sort(), nearestIds.slice().sort(), 'the plan holds the picked lights');
    const plan = await page.evaluate(() => DGOperations.state.plan);
    assert.equal(plan.stops[0].id, nearestIds[0], 'the route starts at the light nearest to me');
    assert.ok(plan.stops.slice(1).every((s, i) => Math.abs(s.distanceFromPrevious - dist(plan.stops[i], s)) < 2), 'each stop carries the straight-line distance from the previous one');
    assert.ok(await page.evaluate(() => document.querySelector('.dg-plan').getBoundingClientRect().top < document.querySelector('#dgDueTargets').getBoundingClientRect().top), 'the plan comes before the target list');
    assert.equal(await page.locator('.dg-progress').getAttribute('aria-valuenow'), '0');
    assert.equal(await page.locator('.dg-plan-next b').textContent(), plan.stops[0].code);
    assert.match(await page.locator('.dg-plan-next small').textContent(), /다음 방문지 1\/10 · 내 위치에서 \d+m/);
    assert.equal(await page.locator('.dg-plan-stop .n').nth(2).textContent(), '3');
    assert.match(await page.locator('.dg-plan-stop').nth(1).locator('small').textContent(), /\+\d+m/);
    assert.equal(await page.evaluate(() => DGOperations.state.planPick.size), 0, 'picks are consumed by the plan');

    // 3. 방문 완료 on the next card, then an inspection saved later marks a stop done by itself
    checks.push('visited and auto-completed stops');
    await page.locator('.dg-plan-next [data-dg="plan-visit"]').click(); await page.waitForFunction(code => document.querySelector('.dg-plan-next b')?.textContent === code, plan.stops[1].code);
    assert.equal(await page.evaluate(() => DGOperations.state.plan.stops[0].visited), true, 'the next card moved on because the first stop is ticked');
    assert.equal(await page.locator('.dg-progress').getAttribute('aria-valuenow'), '10');
    await page.evaluate(() => { byId(DGOperations.state.plan.stops[1].id).lastInspected = Date.now() + 1; render(); }); await page.waitForTimeout(200);
    assert.equal(await page.locator('.dg-plan-stop.done').count(), 2);
    assert.equal(await page.locator('.dg-plan-stop').nth(1).locator('.dg-auto').textContent(), '점검 완료');
    assert.equal(await page.locator('.dg-plan-stop').nth(1).locator('[data-plan-visited]').isDisabled(), true, 'an auto-completed stop cannot be unticked');
    assert.equal(await page.locator('.dg-plan-next b').textContent(), plan.stops[2].code);
    assert.equal(await page.locator('.dg-progress').getAttribute('aria-valuenow'), '20');
    assert.equal(await page.evaluate(async () => (await DGOffline.get('plan', 'current')).stops[0].visited), true, 'the tick is on the device');

    // 4. reordering: 아래로 swaps, 내 위치에서 다시 정렬 keeps done stops first and sorts the rest from here
    checks.push('reordering');
    const before = await stops();
    await page.locator('[data-dg="plan-down"][data-index="2"]').click(); await page.waitForFunction(id => DGOperations.state.plan.stops[3].id === id, before[2]);
    assert.equal((await stops())[2], before[3]);
    assert.ok(await page.evaluate(() => DGOperations.state.plan.stops[3].distanceFromPrevious > 0), 'legs are recomputed');
    await page.locator('[data-dg="plan-up"][data-index="3"]').click(); await page.waitForFunction(id => DGOperations.state.plan.stops[2].id === id, before[2]);
    // shuffle the rest, then re-sort from my position: done stops stay in front, the first open stop is the nearest open one
    await page.evaluate(() => { const p = DGOperations.state.plan; const rest = p.stops.slice(2).reverse(); p.stops = [...p.stops.slice(0, 2), ...rest]; render(); });
    await page.locator('[data-dg="plan-reorder"]').click(); await page.waitForFunction(() => DGOperations.state.plan.reorderedAt);
    const after = await page.evaluate(() => DGOperations.state.plan.stops.map(s => ({ id: s.id, lat: s.lat, lng: s.lng })));
    assert.deepEqual(after.slice(0, 2).map(s => s.id), before.slice(0, 2), 'completed stops keep their place');
    const open = after.slice(2), me = { lat: HERE.latitude, lng: HERE.longitude };
    assert.equal(open[0].id, open.slice().sort((a, b) => dist(me, a) - dist(me, b))[0].id, 'the first open stop is the one nearest to me');

    // 5. the plan map draws the stops in order with a connecting line; done stops are greyed; a tap opens the card
    checks.push('numbered route map');
    await page.locator('[data-dg="plan-map"]').click(); await page.waitForFunction(() => gmap && gmapLayer && document.querySelectorAll('.maprt').length === 10);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.maprt div')].map(d => d.textContent)), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    assert.equal(await page.locator('.maprt.done').count(), 2);
    assert.equal(await page.locator('.maprt.next').count(), 1, 'the next stop is marked on the map');
    assert.equal(await page.locator('.maprt.next div').textContent(), '3', 'the next stop carries its plan number');
    assert.equal(await page.evaluate(() => gmapLayer.getLayers().filter(l => l instanceof L.Polyline && !(l instanceof L.Polygon)).length), 1, 'one dashed line joins the stops');
    assert.equal(await page.locator('#gmap .mapcl').count(), 0, 'no grouping on a plan map');
    await page.locator('.maprt').nth(2).click(); await page.locator('#mapCard:not([hidden])').waitFor();
    assert.equal(await page.locator('#mapCard b').first().textContent(), await page.evaluate(() => byId(DGOperations.state.plan.stops[2].id).code));

    // 5b. the plan map's card reorders unfinished stops; numbers, the line and the saved plan follow
    checks.push('reordering from the plan map');
    const sixth = await page.evaluate(() => DGOperations.state.plan.stops[5].id);
    await page.locator('.maprt').nth(5).click(); await page.locator('#mapCard [data-map-move="next"]').waitFor();
    await page.locator('#mapCard [data-map-move="next"]').click();
    await page.waitForFunction(id => DGOperations.state.plan.stops[2].id === id, sixth);
    await page.waitForFunction(id => document.querySelector('.maprt.next div')?.textContent === '3' && document.querySelector('#mapCard b')?.textContent === byId(id).code, sixth);
    assert.equal(await page.evaluate(async () => (await DGOffline.get('plan', 'current')).stops[2].id), sixth, 'the new order is saved on the device');
    assert.equal(await page.locator('#mapCard [data-map-move="next"]').isDisabled(), true, 'the next stop cannot move to next again');
    assert.equal(await page.locator('#mapCard [data-map-move="earlier"]').isDisabled(), true, 'finished stops stay ahead of it');
    await page.locator('#mapCard [data-map-move="later"]').click();
    await page.waitForFunction(id => DGOperations.state.plan.stops[3].id === id, sixth);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.maprt div')].map(d => d.textContent)), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    await page.locator('.maprt').nth(0).click(); await page.locator('#mapCard:not([hidden])').waitFor();
    assert.equal(await page.locator('#mapCard [data-map-move]').count(), 0, 'a finished stop has no reorder buttons');
    await page.goBack(); await page.locator('.dg-plan').waitFor();
    assert.equal(await page.evaluate(id => document.querySelectorAll('.dg-plan-stop')[3].textContent.includes(byId(id).code), sixth), true, 'the plan list shows the order chosen on the map');

    // 6. 길찾기 from the next card offers the map apps for that stop
    checks.push('길찾기 from the next card');
    await page.evaluate(() => { window.__opened = []; window.open = u => { window.__opened.push(u); return null; }; });
    await page.locator('.dg-plan-next [data-dg="plan-route"]').click();
    await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
    await page.locator('#dgDialog [data-dgdlg-choice]', { hasText: '구글 지도' }).click();
    const next = await page.evaluate(() => DGOperations.state.plan.stops.find(s => !s.visited && (byId(s.id).lastInspected || 0) < DGOperations.state.plan.createdAt));
    const opened = await page.evaluate(() => window.__opened);
    assert.equal(opened.length, 1); assert.ok(opened[0].includes('destination=' + next.lat + ',' + next.lng), opened[0]);

    // 6b. 다음 N곳 경로 hands the next open stops to the map app as waypoints, in plan order
    checks.push('다음 N곳 경로');
    await page.evaluate(() => { window.__opened = []; });
    await page.locator('[data-dg="plan-route-ahead"]').click();
    await page.locator('#dgDialog [data-dgdlg-choice]', { hasText: '구글 지도 · 도보' }).click();
    const ahead = await page.evaluate(() => { const p = DGOperations.state.plan; return p.stops.filter(s => !s.visited && (byId(s.id).lastInspected || 0) < p.createdAt).slice(0, 6); });
    const routeUrl = new URL((await page.evaluate(() => window.__opened))[0]);
    assert.equal(routeUrl.searchParams.get('destination'), ahead[5].lat + ',' + ahead[5].lng, 'the sixth open stop is the destination');
    assert.equal(routeUrl.searchParams.get('waypoints'), ahead.slice(0, 5).map(s => s.lat + ',' + s.lng).join('|'), 'the five before it are waypoints in order');
    assert.equal(routeUrl.searchParams.get('travelmode'), 'walking');
    assert.match(await page.locator('.dg-plan p').first().textContent(), /남은 8곳 약 [\d.]+k?m\(내 위치부터\)/);
    // 카카오맵 app: my position as the start (sp), the first five open stops as vp, vp2 … vp5, the sixth as ep, in order
    await page.evaluate(() => { window.__opened = []; });
    await page.locator('[data-dg="plan-route-ahead"]').click();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#dgDialog [data-dgdlg-choice]')].map(b => b.firstChild.textContent.trim())), ['네이버 지도 · 차량', '카카오맵 · 차량', '카카오맵 · 도보', '구글 지도 · 차량', '구글 지도 · 도보']);
    assert.match(await page.locator('#dgDialog [data-dgdlg-choice]', { hasText: '카카오맵 · 차량' }).textContent(), /내 위치에서 출발 · 경유지 5곳/);
    await page.locator('#dgDialog [data-dgdlg-choice]', { hasText: '카카오맵 · 차량' }).click();
    const kakao = (await page.evaluate(() => window.__opened))[0];
    assert.ok(kakao.startsWith('kakaomap://route?'), kakao);
    const kq = new URLSearchParams(kakao.split('?')[1]);
    const pos = await page.evaluate(() => DGOperations.state.pos);
    assert.equal(kq.get('sp'), pos.lat + ',' + pos.lng, 'the route starts at my position');
    assert.deepEqual(['vp', 'vp2', 'vp3', 'vp4', 'vp5'].map(k => kq.get(k)), ahead.slice(0, 5).map(s => s.lat + ',' + s.lng), 'five waypoints in plan order');
    assert.equal(kq.get('ep'), ahead[5].lat + ',' + ahead[5].lng); assert.equal(kq.get('by'), 'car'); assert.equal(kq.get('vp6'), null);

    // 7. the plan survives a reload, including the auto-completion rule
    checks.push('plan persists');
    const saved = await page.evaluate(() => DGOperations.state.plan.stops.map(s => s.id + ':' + s.visited));
    await page.reload(); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); openAdminSection('due'); }); await page.locator('.dg-plan').waitFor();
    assert.deepEqual(await page.evaluate(() => DGOperations.state.plan.stops.map(s => s.id + ':' + s.visited)), saved);

    checks.push('legacy plans recheck current position quality before routing');
    const legacy = await page.evaluate(async () => {
      const precise = S.lights.filter(l => !l.posApprox && Number.isFinite(l.lat) && Number.isFinite(l.lng)).slice(0, 3);
      const approximate = S.lights.find(l => l.posApprox);
      const stop = (l, visited) => ({ id: l.id, code: l.code, lat: l.lat, lng: l.lng, visited });
      await DGOffline.put('plan', 'current', { createdAt: Date.now(), stops: [stop(precise[0], true), stop(precise[1], false), stop(precise[2], false), stop(approximate, false)], distance: 0 });
      await DGOperations.ready();
      return { kept: precise.map(l => l.id), excluded: approximate.id };
    });
    assert.deepEqual(await stops(), legacy.kept);
    assert.equal(await page.evaluate(() => DGOperations.state.plan.stops[0].visited), true);
    assert.equal(await page.evaluate(() => DGOperations.state.plan.excludedApproximate[0].id), legacy.excluded);
    await page.evaluate(() => { window.__opened = []; window.open = u => { window.__opened.push(u); return null; }; openAdminSection('due'); });
    await page.locator('[data-dg="plan-route-ahead"]').click();
    await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
    await page.evaluate(id => { byId(id).posApprox = true; }, legacy.kept[1]);
    await page.locator('#dgDialog [data-dgdlg-choice]', { hasText: '구글 지도 · 도보' }).click();
    await page.waitForFunction(() => DGOperations.state.plan.stops.length === 2);
    assert.deepEqual(await page.evaluate(() => window.__opened), []);
    await page.evaluate(() => { DGOperations.state.plan.stops = []; openAdminSection('due'); });
    assert.doesNotMatch(await page.locator('.dg-plan').textContent(), /모든 방문지를 마쳤어요/);
    assert.match(await page.locator('.dg-plan').textContent(), /시설/);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
