/* PC vs phone: the device profile (app/device.js) decides the home screen and which field tools are offered, by input
   type and platform rather than width. Checks a PC, a narrow PC window, an Android phone and an iPad (iPadOS reports
   as a Mac), the manual "화면 방식" override, the remembered tab, the wide PC workspace, and that a PC's coarse
   Wi-Fi/IP position can no longer judge, correct or rank lights. */
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
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const HERE = { latitude: 35.1530952, longitude: 126.9217072 };
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const errors = [], checks = [];
  const boot = page => page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized && window.DEV);
  async function open(opts, { touchPoints, accuracy } = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block', ...opts, ...(accuracy ? { geolocation: { ...HERE, accuracy }, permissions: ['geolocation'] } : {}) });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
    if (touchPoints) await context.addInitScript(n => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => n }), touchPoints);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
    await page.goto(origin); await boot(page); await page.waitForTimeout(300);
    return { context, page };
  }
  const tiles = page => page.evaluate(() => [...document.querySelectorAll('#view .actions button')].map(b => b.querySelector('span').firstChild.textContent.trim()));
  const settle = async page => { await page.evaluate(() => { if (NAV.stack.length) closeSheet('all'); }); await page.waitForFunction(() => !NAV.stack.length && !document.querySelector('#sheet').classList.contains('open')); };
  try {
    // 1. PC: desktop profile, an administrator lands on 관리 현황 with today's counts and a grouped menu
    checks.push('PC lands on management with today strip and groups');
    let { context, page } = await open({ viewport: { width: 1440, height: 900 } });
    assert.deepEqual(await page.evaluate(() => [DEV.kind, DEV.field, document.documentElement.dataset.device]), ['desktop', false, 'desktop']);
    assert.equal(await page.evaluate(() => S.tab), 'admin', 'an administrator on a PC starts on 관리 현황');
    assert.ok(await page.locator('.todaystrip button').count() >= 5);
    // overdue / due-today counts come from their own query over all open work, independent of 보수 작업's filter or paging
    await page.evaluate(async () => {
      const now = Date.now(), base = { schemaVersion: 1, lightId: S.lights[0].id, code: S.lights[0].code, dong: S.lights[0].dong, title: '시험', description: '', type: '수리', priority: '보통', assignedTo: S.me, createdBy: S.me, createdAt: now, updatedAt: now };
      const kstMidnight = Date.parse(new Date(now + 9 * 36e5).toISOString().slice(0, 10) + 'T00:00:00+09:00');
      const rows = [['o1', { status: 'assigned', dueAt: now - 86400000 }], ['o2', { status: 'in_progress', dueAt: now - 3600000 }], ['t1', { status: 'assigned', dueAt: kstMidnight + 86399000 }], ['v1', { status: 'verified', dueAt: now - 86400000 }]];
      for (const [id, x] of rows) await db.doc('workOrders/' + id).set({ ...base, ...x });
      DGOperations.state.filter = 'all'; todayStrip.at = 0; render();
    });
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('.todaystrip [data-asec="works"] b')].map(x => x.textContent); return b.length === 2 && !b.includes('…'); });
    const tc = await page.evaluate(() => [...document.querySelectorAll('.todaystrip [data-asec="works"]')].map(b => b.querySelector('span').textContent + ':' + b.querySelector('b').textContent));
    assert.ok(tc.some(x => /기한 초과/.test(x) && /:2$/.test(x)), 'two open overdue orders (verified excluded), with 보수 작업 on another filter: ' + tc.join(','));
    assert.ok(tc.some(x => /오늘 기한/.test(x) && /:[12]$/.test(x)), 'the order due later today is counted: ' + tc.join(','));
    // a re-inspection request counts as 점검 필요 like the 미점검 list
    const needBefore = await page.evaluate(() => +document.querySelector('.todaystrip [data-asec="due"] b').textContent.replace(/,/g, ''));
    await page.evaluate(() => { const l = S.lights.find(x => !x.removed); l.lastInspected = Date.now(); l.redoNote = '재확인'; l.status = '점검필요'; render(); });
    assert.equal(await page.evaluate(() => +document.querySelector('.todaystrip [data-asec="due"] b').textContent.replace(/,/g, '')), needBefore, 'a fresh inspection with a redo request stays 점검 필요');
    // the sync chip stays a small pill and speaks its state
    const chip = await page.evaluate(() => { const r = document.querySelector('#sync').getBoundingClientRect(); return { h: r.height, label: document.querySelector('#sync').getAttribute('aria-label') }; });
    assert.ok(chip.h <= 30, 'sync chip height ' + chip.h); assert.match(chip.label, /동기화: .+ · 저장 대기함 열기/);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.menugroup')].map(h => h.textContent)).then(g => g.slice(0, 2)), ['접수·조치', '대장·등록']);
    assert.equal(await page.locator('.todaystrip [data-asec="works"]').first().isVisible(), true);
    assert.ok(await page.evaluate(() => document.querySelector('[data-asec="works"]').getBoundingClientRect().bottom < innerHeight), '보수 작업 is above the fold');
    // the 현장 점검 home offers PC alternatives instead of GPS/camera/compass tools
    await page.locator('nav.tabs [data-tab="inspect"]').click(); await page.waitForTimeout(200);
    assert.deepEqual(await tiles(page), ['표찰 사진으로 찾기', '미점검·방문 계획', '순찰 기록', '지도']);
    assert.equal(await page.locator('#ptBtn, #arBtn').count(), 0);
    assert.equal(await page.locator('.devnote [data-devmode-open]').count(), 1);
    // the chosen tab is remembered on this device
    await page.reload(); await boot(page); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => S.tab), 'inspect', 'the last tab used wins over the default');
    // "/" puts the cursor in the search box; the sync chip opens the outbox
    await page.keyboard.press('/'); assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
    await page.evaluate(() => document.activeElement.blur());
    await page.locator('#sync').click(); await page.waitForFunction(() => S.asec === 'outbox' && document.querySelector('#sheet').classList.contains('open'));
    await settle(page);

    // 2. PC workspace: desk screens and maps use the width; a field-only area stays a side panel
    checks.push('wide PC workspace');
    await page.evaluate(() => openAdminSection('works')); await page.waitForTimeout(400);
    const w = await page.evaluate(() => ({ wide: document.querySelector('#sheet').classList.contains('wide'), width: document.querySelector('#sheet').getBoundingClientRect().width }));
    assert.equal(w.wide, true); assert.ok(w.width > 1100, 'works opens across the workspace: ' + w.width);
    await settle(page);
    await page.evaluate(() => openAdminSection('outbox')); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelector('#sheet').classList.contains('wide')), false, 'small screens keep the side panel');
    await settle(page);
    await page.evaluate(() => openMap('all')); await page.waitForFunction(() => window.gmap);
    assert.ok(await page.evaluate(() => document.querySelector('#gmap').getBoundingClientRect().height) > 560, 'the map is tall on a PC');
    assert.equal(await page.evaluate(() => ME.watch), null, 'a PC does not ask for location when a map opens');

    // 3. 길찾기 on a PC: web maps and copying the position, no app-only links
    checks.push('PC routing options');
    await page.evaluate(() => { gmap.setView([35.1530952, 126.9217072], 18); }); await page.waitForTimeout(400);
    await page.evaluate(() => { gmapLayer.getLayers().find(l => l instanceof L.CircleMarker).fire('click'); });
    await page.locator('#mapCard [data-map-route]').click(); await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
    const routes = await page.evaluate(() => [...document.querySelectorAll('#dgDialog [data-dgdlg-choice]')].map(b => b.firstChild.textContent.trim()));
    assert.deepEqual(routes, ['카카오맵 (웹)', '네이버 지도 (웹)', '구글 지도 (웹)', '좌표·주소 복사']);
    await page.evaluate(() => DGDialog.cancel());
    await context.close();

    // 4. a PC with a coarse Wi-Fi/IP position: no judging, correcting, ranking or storing
    checks.push('PC coarse position guarded');
    ({ context, page } = await open({ viewport: { width: 1280, height: 800 } }, { accuracy: 1500 }));
    await page.evaluate(() => { S.tab = 'inspect'; render(); });
    const lightId = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat)).id);
    await page.evaluate(id => openLight(id), lightId); await page.locator('#posTxt').waitFor();
    await page.evaluate(id => posCheckStart(id), lightId);
    await page.waitForFunction(() => /추정치/.test(document.querySelector('#posTxt')?.textContent || ''));
    assert.equal(await page.evaluate(() => document.querySelector('#posFix')?.hidden ?? true), true, 'no 좌표 보정 from a ±1.5km estimate');
    assert.deepEqual(await page.evaluate(() => [draft.pos, draft.posDist]), [null, null], 'the estimate is not stored on the inspection');
    await page.evaluate(() => { PK.pos = { lat: 35.15, lng: 126.92, acc: 1500 }; }); await page.evaluate(() => posFix());
    assert.equal(await page.evaluate(id => byId(id).edits?.length || 0, lightId), 0, 'posFix refuses a coarse fix');
    // tilt: a PC sends no angles → explained after 3s
    await page.evaluate(() => startTilt()); await page.waitForFunction(() => /기울기 값이 들어오지 않아요/.test(document.querySelector('#tiltQuality')?.textContent || ''), null, { timeout: 6000 });
    await settle(page);
    // 내 주변 on the map refuses the estimate
    await page.evaluate(() => openMap('all')); await page.waitForFunction(() => window.gmap);
    await page.locator('#mapLoc').click(); await page.waitForFunction(() => ME.pos && ME.pos.acc > 150);
    await page.locator('#mapNear').click(); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => GM.near), false); assert.equal(await page.evaluate(() => document.querySelector('#mapHits').hidden), true);
    await settle(page);
    // the scanner reads photos first on a PC, the webcam only on request
    await page.evaluate(() => openScanner('inspect')); await page.locator('#camHint [data-camstart]').waitFor();
    assert.equal(await page.evaluate(() => !!(scan.stream)), false, 'no camera started by itself');
    await settle(page);
    // starting a patrol on a PC asks first
    await page.evaluate(() => { S.tab = 'admin'; render(); openAdminSection('patrol'); }); await page.waitForTimeout(300);
    if (await page.locator('[data-ptgo]').count()) {
      await page.locator('[data-ptgo]').first().click(); await page.locator('#dgDialog:not([hidden])').waitFor();
      assert.match(await page.locator('#dgDialog .dgdlg-title').textContent(), /휴대폰에서 시작/);
      await page.locator('#dgDialog [data-dgdlg="cancel"]').click(); await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => pt.on), false);
    }
    await context.close();

    // 5. a narrow PC window is still a PC (mouse, no GPS) even with the phone layout
    checks.push('narrow PC window');
    ({ context, page } = await open({ viewport: { width: 900, height: 800 } }));
    assert.equal(await page.evaluate(() => DEV.kind), 'desktop');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('nav.tabs')).position), 'fixed', 'layout still follows the width (bottom tabs)');
    await page.evaluate(() => { S.tab = 'inspect'; render(); });
    assert.deepEqual(await tiles(page), ['표찰 사진으로 찾기', '미점검·방문 계획', '순찰 기록', '지도']);
    // the manual override: 휴대폰 화면 → field tools, kept after reload, back to 자동
    checks.push('화면 방식 override');
    await page.locator('.devnote [data-devmode-open]').click(); await page.locator('#dgDialog [data-dgdlg-choice]').first().waitFor();
    await page.locator('#dgDialog [data-dgdlg-choice]', { hasText: '휴대폰 화면' }).click(); await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => [DEV.kind, DEV.mode]), ['phone', 'phone']);
    assert.deepEqual(await tiles(page), ['표찰 스캔', '야간 순찰', '주변 찾기', '지도']);
    await page.reload(); await boot(page);
    assert.equal(await page.evaluate(() => DEV.kind), 'phone', 'the choice is kept on this device');
    await page.evaluate(() => DongguDevice.set('auto')); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => DEV.kind), 'desktop');
    await context.close();

    // 6. Android phone: field home, desk work folded, no wide sheets
    checks.push('phone field home');
    ({ context, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: ANDROID }, { accuracy: 8 }));
    assert.deepEqual(await page.evaluate(() => [DEV.kind, S.tab]), ['phone', 'inspect']);
    assert.deepEqual(await tiles(page), ['표찰 스캔', '야간 순찰', '주변 찾기', '지도']);
    await page.evaluate(() => { S.tab = 'admin'; render(); });
    assert.equal(await page.locator('.todaystrip').count(), 0);
    assert.equal(await page.locator('details.deskmenu').count(), 1, 'desk work is folded under PC 업무');
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('details.deskmenu [data-asec]')].map(b => b.dataset.asec).includes('backup')));
    assert.equal(await page.evaluate(() => document.querySelector('details.deskmenu').open), false);
    assert.equal(await page.evaluate(() => !!document.querySelector('details.deskmenu [data-asec="outbox"]')), true, 'an empty outbox stays reachable under PC 업무');
    await page.evaluate(() => { DGOperations.state.drafts = [{ kind: 'draft', id: 'x', updatedAt: Date.now() }]; DGOperations.state.jobs = []; render(); });
    assert.equal(await page.evaluate(() => !!document.querySelector('.menu:not(details .menu) [data-asec="outbox"]')), true, 'drafts put 저장 대기함 among the field items');
    await page.evaluate(() => { DGOperations.state.drafts = []; render(); });
    await page.evaluate(() => openAdminSection('backup')); await page.locator('.deskonly').waitFor();
    assert.equal(await page.evaluate(() => document.querySelector('#sheet').classList.contains('wide')), false);
    await settle(page);
    // AR: a coarse fix stays explained whatever filter is tapped; a refused compass keeps its own reason
    await page.evaluate(() => { window.DeviceOrientationEvent.requestPermission = async () => 'denied'; openAR(); });
    await page.locator('#arList').waitFor();
    await page.evaluate(() => onPosition({ coords: { latitude: 35.1530952, longitude: 126.9217072, accuracy: 900, heading: null, speed: 0 } }));
    assert.match(await page.locator('#arList').textContent(), /GPS를 잡는 중/);
    await page.evaluate(() => { ar.range = 100; arList(true); });
    assert.match(await page.locator('#arList').textContent(), /GPS를 잡는 중/, 'a filter tap does not replace the explanation with "no lights"');
    await page.waitForTimeout(3400);
    assert.equal(await page.locator('#arHead').textContent(), '나침반 권한 없음', 'the refused permission is not relabelled as a missing compass');
    await page.evaluate(() => { delete window.DeviceOrientationEvent.requestPermission; arStop(); });
    await settle(page);
    // a real GPS fix still judges the position
    const id2 = await page.evaluate(() => S.lights.find(l => Number.isFinite(l.lat)).id);
    await page.evaluate(id => { openLight(id); posCheckStart(id); }, id2);
    await page.waitForFunction(() => /등록 좌표/.test(document.querySelector('#posTxt')?.textContent || ''));
    assert.equal(await page.evaluate(() => typeof draft.posDist), 'number');
    await page.evaluate(() => { PK.pos = { lat: 35.16, lng: 126.93, acc: 400 }; posDraw(); });
    assert.equal(await page.evaluate(() => draft.pos && draft.pos.acc), 8, 'a later coarse fix does not erase the good one on the inspection');
    await context.close();

    // 7. iPad (iPadOS reports as a Mac): a field tablet, even at PC width
    checks.push('iPad is a field tablet');
    ({ context, page } = await open({ viewport: { width: 1180, height: 820 }, hasTouch: true, userAgent: IPAD }, { touchPoints: 5 }));
    assert.deepEqual(await page.evaluate(() => [DEV.kind, DEV.field, DEV.ios, S.tab]), ['tablet', true, true, 'inspect']);
    assert.deepEqual(await tiles(page), ['표찰 스캔', '야간 순찰', '주변 찾기', '지도']);
    await context.close();

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
