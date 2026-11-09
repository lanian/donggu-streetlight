/* Vehicle visit-plan handoff smoke. Synthetic GPS and disconnected local storage only.
 * Every external request and every non-GET is blocked; navigation URLs are captured, never opened. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DG_OPERATIONS_ROOT || path.join(__dirname, '..'));
const HERE = { latitude: 35.1530952, longitude: 126.9217072, accuracy: 9 };
const server = http.createServer((req, res) => {
  if (req.url.split('?')[0].endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG=null;'); }
  let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { return res.writeHead(400).end(); }
  const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function poll(page, fn, arg, label) {
  const until = Date.now() + 15000;
  do { if (await page.evaluate(fn, arg)) return; await new Promise(resolve => setTimeout(resolve, 30)); } while (Date.now() < until);
  throw new Error('Timed out: ' + label);
}
(async () => {
  const results = [], errors = [], mutations = [], operatingRequests = []; let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://localhost:' + server.address().port;
  try {
    browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
    async function scenario(name, run) {
      if (process.env.DONGGU_DRIVING_CASE && !name.includes(process.env.DONGGU_DRIVING_CASE)) return;
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (/(^|\.)roadlighting\.kr$/i.test(url.hostname)) operatingRequests.push({ method: request.method(), path: url.pathname });
        if (request.method() !== 'GET') { mutations.push({ method: request.method(), path: url.pathname }); return route.abort(); }
        if (url.origin !== origin) return route.fulfill({ status: 200, body: '', contentType: request.resourceType() === 'script' ? 'text/javascript' : 'text/plain' });
        return route.continue();
      });
      await context.addInitScript(here => {
        localStorage.setItem('dg-device', 'phone');
        window.__drivingGps = { mode: 'hold', requests: [], position: here };
        Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
          getCurrentPosition(success, failure) {
            const request = { success, failure }; __drivingGps.requests.push(request);
            if (__drivingGps.mode === 'success') setTimeout(() => success({ coords: __drivingGps.position, timestamp: Date.now() }), 0);
            if (__drivingGps.mode === 'denied') setTimeout(() => failure({ code: 1, message: 'Synthetic denied GPS' }), 0);
          }, watchPosition() { return 1; }, clearWatch() {}
        } });
        window.__drivingOpened = [];
        window.open = url => { __drivingOpened.push(String(url)); return null; };
      }, HERE);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(name + ': ' + error.message));
      page.on('dialog', dialog => { errors.push(name + ': native dialog ' + dialog.type()); return dialog.dismiss(); });
      try {
        await page.goto(origin);
        await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGOffline.ready && DGIntegration.initialized);
        assert.equal(await page.evaluate(() => DGIntegration.whenReady()), true);
        assert.deepEqual(await page.evaluate(() => ({ firebase: FIREBASE_CONFIG, connected: !!FB, mode: db.mode, actor: S.me })), { firebase: null, connected: false, mode: 'local', actor: 'local' });
        await page.evaluate(() => { S.demoRole = 'admin'; S.tab = 'admin'; render(); openAdminSection('due'); });
        await run({ page, context }); results.push(name); console.log('PASS: ' + name);
      } finally { await context.close(); }
    }
    async function plan(page, count) {
      return page.evaluate(async count => {
        const lights = S.lights.filter(l => !l.removed && !l.posApprox && Number.isFinite(l.lat) && Number.isFinite(l.lng)).slice(0, count);
        if (lights.length !== count) throw new Error('Insufficient precise fixture facilities');
        const createdAt = Date.now() + 10000;
        const plan = { createdAt, stops: lights.map(l => ({ id: l.id, code: l.code, dong: l.dong || '', lat: l.lat, lng: l.lng, visited: false })), distance: 0 };
        DGOperations.state.plan = plan; DGOperations.state.pos = null; S.pos = null;
        await DGOffline.put('plan', 'current', plan); openAdminSection('due');
        return JSON.parse(JSON.stringify(plan));
      }, count);
    }
    const savedPlan = page => page.evaluate(() => DGOffline.get('plan', 'current'));
    const opened = page => page.evaluate(() => __drivingOpened);
    async function panel(page) {
      await page.locator('[data-dg="plan-driving"]').click();
      await page.locator('#dgDrivingPlan').waitFor();
    }
    async function provider(page, index, kind) {
      const leg = page.locator('#dgDrivingPlan .dg-driving-leg').nth(index);
      if (await leg.getAttribute('open') === null) await leg.locator('summary').click();
      await page.locator('[data-dg="driving-open"][data-index="' + index + '"]').click();
      await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
      const expression = kind === 'naver' ? /네이버/ : kind === 'kakao-web' ? /카카오.*웹/ : /카카오.*앱/;
      const choice = page.locator('#dgDialog [data-dgdlg-choice]').filter({ hasText: expression });
      assert.equal(await choice.count(), 1, 'Exactly one explicit ' + kind + ' choice is present');
      await choice.click();
      await poll(page, () => !DGDialog.isOpen(), null, 'provider chooser closes');
    }
    async function gps(page) {
      await page.evaluate(() => { __drivingGps.mode = 'success'; });
      await page.locator('[data-dg="driving-locate"]').click();
      await poll(page, () => __drivingGps.requests.length > 0 && !document.querySelector('[data-dg="driving-locate"]')?.disabled, null, 'fresh synthetic GPS completes');
    }
    function naverStops(url) {
      const route = new URL(url), query = route.searchParams, stops = [];
      assert.equal(route.protocol, 'nmap:'); assert.equal(route.hostname + route.pathname, 'route/car');
      assert.ok(query.get('appname'));
      for (let i = 1; i <= 5; i++) if (query.has('v' + i + 'lat')) stops.push({ lat: Number(query.get('v' + i + 'lat')), lng: Number(query.get('v' + i + 'lng')) });
      stops.push({ lat: Number(query.get('dlat')), lng: Number(query.get('dlng')) });
      assert.equal(query.has('v6lat'), false); return { query, stops };
    }
    function webStops(url) {
      const route = new URL(url); assert.equal(route.origin, 'https://map.kakao.com'); assert.ok(route.pathname.startsWith('/link/by/car/'));
      return route.pathname.split('/').slice(4).map(segment => {
        const values = decodeURIComponent(segment).split(','); return { lat: Number(values.at(-2)), lng: Number(values.at(-1)) };
      });
    }
    const coords = stops => stops.map(stop => ({ lat: stop.lat, lng: stop.lng }));
    await scenario('a single remaining facility exposes an explicit vehicle route workflow', async ({ page }) => {
      const fixture = await plan(page, 1), saved = await savedPlan(page);
      assert.equal(await page.locator('[data-dg="plan-driving"]').count(), 1, 'Even one remaining facility needs a vehicle route action');
      assert.match(await page.locator('[data-dg="plan-driving"]').textContent(), /차량 이동 노선 만들기/);
      await panel(page);
      assert.equal(await page.locator('#dgDrivingPlan .dg-driving-leg').count(), 1);
      assert.equal(await page.evaluate(() => __drivingGps.requests.length), 0, 'Making a route panel never asks for GPS automatically');
      assert.match(await page.locator('#dgDrivingPlan').textContent(), /내 위치 확인/);
      assert.match(await page.locator('#dgDrivingPlan').textContent(), /도로|지도 앱/);
      await provider(page, 0, 'naver');
      const urls = await opened(page); assert.equal(urls.length, 1);
      const route = naverStops(urls[0]); assert.deepEqual(route.stops, coords(fixture.stops));
      assert.equal(route.query.has('slat'), false); assert.equal(route.query.has('slng'), false);
      assert.deepEqual(await savedPlan(page), saved, 'Opening navigation never edits the persisted plan');
      assert.equal(await page.evaluate(() => DGOperations.state.plan.stops.some(stop => stop.visited)), false);
    });
    await scenario('thirteen facilities form every ordered six six one vehicle leg with consistent start and endpoints', async ({ page }) => {
      const fixture = await plan(page, 13), saved = await savedPlan(page); await panel(page);
      assert.equal(await page.locator('#dgDrivingPlan .dg-driving-leg').count(), 3);
      assert.deepEqual(await page.locator('#dgDrivingPlan .dg-driving-leg').evaluateAll(legs => legs.map(leg => leg.querySelectorAll('ol li').length)), [6, 6, 1]);
      assert.equal(await page.evaluate(() => __drivingGps.requests.length), 0);
      // Later legs start at the previous leg's destination even before a GPS fix exists.
      await provider(page, 1, 'kakao-web');
      assert.deepEqual(webStops((await opened(page)).at(-1)), coords([fixture.stops[5], ...fixture.stops.slice(6, 12)]));
      await gps(page);
      const current = { lat: HERE.latitude, lng: HERE.longitude };
      await provider(page, 0, 'naver');
      const naver = naverStops((await opened(page)).at(-1));
      assert.deepEqual(naver.stops, coords(fixture.stops.slice(0, 6)));
      assert.equal(Number(naver.query.get('slat')), current.lat); assert.equal(Number(naver.query.get('slng')), current.lng);
      for (let index = 0; index < 3; index++) {
        await provider(page, index, 'kakao-web');
        const start = index === 0 ? current : fixture.stops[index * 6 - 1];
        assert.deepEqual(webStops((await opened(page)).at(-1)), coords([start, ...fixture.stops.slice(index * 6, index * 6 + 6)]));
      }
      await provider(page, 0, 'kakao-app');
      const app = new URL((await opened(page)).at(-1)), query = app.searchParams;
      assert.equal(app.protocol, 'kakaomap:'); assert.equal(app.hostname, 'route'); assert.equal(query.get('by'), 'car');
      assert.equal(query.get('sp'), current.lat + ',' + current.lng);
      assert.deepEqual(['vp', 'vp2', 'vp3', 'vp4', 'vp5'].map(key => query.get(key)), fixture.stops.slice(0, 5).map(stop => stop.lat + ',' + stop.lng));
      assert.equal(query.get('ep'), fixture.stops[5].lat + ',' + fixture.stops[5].lng); assert.equal(query.has('vp6'), false);
      assert.deepEqual(await savedPlan(page), saved); assert.equal(await page.evaluate(() => DGOperations.state.plan.stops.some(stop => stop.visited)), false);
    });
    await scenario('completed facilities are omitted and current coordinates are used before route construction', async ({ page }) => {
      const fixture = await plan(page, 13);
      const expected = await page.evaluate(() => {
        const plan = DGOperations.state.plan; plan.stops[0].visited = true; byId(plan.stops[1].id).lastInspected = plan.createdAt + 1;
        const moved = byId(plan.stops[2].id); moved.lat += 0.00003; moved.lng += 0.00003;
        return plan.stops.slice(2).map(stop => ({ lat: byId(stop.id).lat, lng: byId(stop.id).lng }));
      });
      await panel(page);
      assert.equal(await page.locator('#dgDrivingPlan .dg-driving-leg').count(), 2);
      assert.deepEqual(await page.locator('#dgDrivingPlan .dg-driving-leg').evaluateAll(legs => legs.map(leg => leg.querySelectorAll('ol li').length)), [6, 5]);
      await provider(page, 0, 'naver'); assert.deepEqual(naverStops((await opened(page))[0]).stops, expected.slice(0, 6));
      assert.equal(await page.evaluate(id => DGOperations.state.plan.stops.find(stop => stop.id === id).visited, fixture.stops[0].id), true);
    });
    await scenario('denied GPS keeps the route usable through a current-location Naver handoff without a guessed first-stop origin', async ({ page }) => {
      const fixture = await plan(page, 1); await panel(page);
      await page.evaluate(() => { __drivingGps.mode = 'denied'; });
      await page.locator('[data-dg="driving-locate"]').click();
      await poll(page, () => __drivingGps.requests.length === 1 && !document.querySelector('[data-dg="driving-locate"]')?.disabled, null, 'denied synthetic GPS is released');
      assert.match(await page.locator('#dgDrivingPlan').textContent(), /내 위치|위치 권한/);
      await page.locator('[data-dg="driving-open"][data-index="0"]').click();
      await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
      const choices = await page.locator('#dgDialog [data-dgdlg-choice]').allTextContents();
      assert.ok(choices.some(text => /네이버/.test(text))); assert.ok(choices.every(text => !/카카오/.test(text)), 'A single destination cannot create a same-point Kakao route without a known start');
      await page.locator('#dgDialog [data-dgdlg-choice]').filter({ hasText: /네이버/ }).click();
      const route = naverStops((await opened(page))[0]);
      assert.deepEqual(route.stops, coords(fixture.stops)); assert.equal(route.query.has('slat'), false); assert.equal(route.query.has('slng'), false);
    });
    await scenario('imprecise and expired GPS fixes never become a Kakao vehicle origin', async ({ page }) => {
      await plan(page, 1); await panel(page);
      await page.evaluate(() => { __drivingGps.position.accuracy = 150; }); await gps(page);
      assert.match(await page.locator('#dgDrivingStatus').textContent(), /정확|위치/);
      await page.locator('[data-dg="driving-open"][data-index="0"]').click();
      await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
      assert.ok((await page.locator('#dgDialog [data-dgdlg-choice]').allTextContents()).every(text => !/카카오/.test(text)));
      await page.locator('#dgDialog [data-dgdlg="cancel"]').click();
      await page.evaluate(() => { __drivingGps.position.accuracy = 9; }); await gps(page);
      assert.match(await page.locator('#dgDrivingStatus').textContent(), /확인한 내 위치/);
      await page.evaluate(() => { window.__drivingRealDateNow = Date.now; Date.now = () => __drivingRealDateNow() + 301000; render(); });
      assert.match(await page.locator('#dgDrivingStatus').textContent(), /5분|다시 확인/);
      await page.locator('[data-dg="driving-open"][data-index="0"]').click();
      await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
      assert.ok((await page.locator('#dgDialog [data-dgdlg-choice]').allTextContents()).every(text => !/카카오/.test(text)));
      await page.locator('#dgDialog [data-dgdlg-choice]').filter({ hasText: /네이버/ }).click();
      const route = naverStops((await opened(page))[0]); assert.equal(route.query.has('slat'), false); assert.equal(route.query.has('slng'), false);
    });
    await scenario('a pending explicit refresh accepts its fresh GPS fix when the previous origin expires', async ({ page }) => {
      await plan(page, 1); await panel(page); await gps(page);
      await page.evaluate(() => {
        window.__drivingRealDateNow = Date.now; window.__drivingAdvance = 299000;
        Date.now = () => __drivingRealDateNow() + __drivingAdvance;
        __drivingGps.mode = 'hold'; __drivingGps.position.latitude += 0.0002;
      });
      await page.locator('[data-dg="driving-locate"]').click();
      await poll(page, () => __drivingGps.requests.length === 2, null, 'explicit GPS refresh before old fix expires');
      await page.evaluate(() => { __drivingAdvance = 301000; __drivingGps.requests[1].success({ coords: __drivingGps.position, timestamp: Date.now() }); });
      await poll(page, () => !document.querySelector('[data-dg="driving-locate"]')?.disabled, null, 'fresh GPS refresh completes across old expiry');
      assert.match(await page.locator('#dgDrivingStatus').textContent(), /확인한 내 위치/, 'Expiry of the old origin must not discard a successful fresh explicit fix');
      await provider(page, 0, 'kakao-web');
      assert.deepEqual(webStops((await opened(page))[0])[0], { lat: HERE.latitude + 0.0002, lng: HERE.longitude });
    });
    await scenario('a changed visible plan releases pending GPS controls and permits a fresh explicit retry', async ({ page }) => {
      const fixture = await plan(page, 13); await panel(page);
      await page.locator('[data-dg="driving-locate"]').click();
      await poll(page, () => __drivingGps.requests.length === 1, null, 'pending GPS for visible plan');
      await page.evaluate(() => {
        DGOperations.state.plan.stops[0].visited = true;
        __drivingGps.requests[0].success({ coords: __drivingGps.position, timestamp: Date.now() });
      });
      await poll(page, () => !document.querySelector('[data-dg="driving-locate"]')?.disabled, null, 'stale visible GPS releases controls');
      assert.match(await page.locator('#dgDrivingStatus').textContent(), /바뀌|다시 확인/);
      await gps(page); await provider(page, 0, 'kakao-web');
      assert.deepEqual(webStops((await opened(page))[0]), coords([{ lat: HERE.latitude, lng: HERE.longitude }, ...fixture.stops.slice(1, 7)]));
    });
    for (const change of ['plan', 'order', 'position', 'visited', 'inspection', 'account', 'navigation']) {
      await scenario('an outstanding provider choice cannot open a stale route after ' + change + ' changes', async ({ page }) => {
        await plan(page, 13); await panel(page);
        await page.locator('[data-dg="driving-open"][data-index="0"]').click();
        await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
        await page.evaluate(change => {
          const plan = DGOperations.state.plan;
          if (change === 'plan') DGOperations.state.plan = { ...JSON.parse(JSON.stringify(plan)), createdAt: plan.createdAt + 1 };
          if (change === 'order') plan.stops.reverse();
          if (change === 'position') byId(plan.stops[0].id).lat += 0.00003;
          if (change === 'visited') plan.stops[0].visited = true;
          if (change === 'inspection') byId(plan.stops[0].id).lastInspected = plan.createdAt + 1;
          if (change === 'account') S.me = 'synthetic-other-actor';
          if (change === 'navigation') S.asec = 'outbox';
        }, change);
        await page.locator('#dgDialog [data-dgdlg-choice]').filter({ hasText: /네이버/ }).click();
        await poll(page, () => !DGDialog.isOpen(), null, 'stale provider chooser settles');
        assert.deepEqual(await opened(page), [], 'No navigation URL is opened from a stale ' + change + ' snapshot');
      });
    }
    for (const change of ['plan', 'account', 'navigation']) {
      await scenario('late GPS cannot restore a route panel or origin after ' + change + ' changes', async ({ page }) => {
        await plan(page, 1); await panel(page);
        await page.locator('[data-dg="driving-locate"]').click();
        await poll(page, () => __drivingGps.requests.length === 1, null, 'pending explicit GPS request');
        const pendingStatus = await page.locator('#dgDrivingStatus').textContent();
        await page.evaluate(change => {
          if (change === 'plan') { DGOperations.state.plan = null; render(); }
          if (change === 'account') S.me = 'synthetic-other-actor';
          if (change === 'navigation') openAdminSection('outbox');
          __drivingGps.requests[0].success({ coords: __drivingGps.position, timestamp: Date.now() });
        }, change);
        await page.waitForTimeout(80);
        assert.equal(await page.evaluate(() => DGOperations.state.pos), null, 'A stale GPS result cannot become the current route origin');
        assert.deepEqual(await opened(page), []);
        if (change !== 'account') assert.equal(await page.locator('#dgDrivingPlan').count(), 0, 'A late callback cannot restore an obsolete panel');
        else assert.equal(await page.locator('#dgDrivingStatus').textContent(), pendingStatus, 'An old account callback cannot publish a success status');
        if (change === 'navigation') assert.equal(await page.evaluate(() => S.asec), 'outbox');
      });
    }
    await scenario('phone and desktop light-dark layouts keep every vehicle leg and action within the panel', async ({ page }) => {
      await plan(page, 13); await panel(page);
      for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: theme }); await page.evaluate(theme => applyTheme(theme), theme);
        if (process.env.DONGGU_DRIVING_CAPTURE_DIR) {
          await page.locator('#dgDrivingPlan').evaluate(panel => panel.scrollIntoView({ block: 'start', behavior: 'auto' }));
          const entryControls = await page.locator('#dgDrivingPlan').evaluate(panel => {
            const sheet = document.querySelector('#sheet').getBoundingClientRect(), head = document.querySelector('#sheet .sheet-head').getBoundingClientRect();
            return [...panel.querySelectorAll('#dgDrivingTitle,#dgDrivingStatus,[data-dg="driving-close"],[data-dg="driving-locate"],[data-dg="driving-open"][data-index="0"]')].map(el => {
              const box = el.getBoundingClientRect(); return { control: el.id || el.dataset.dg, visible: box.top >= Math.max(sheet.top, head.bottom) - 1 && box.bottom <= Math.min(innerHeight, sheet.bottom) + 1 };
            });
          });
          assert.ok(entryControls.length === 5 && entryControls.every(control => control.visible), 'The entry heading, status and first actions fit below the sticky header: ' + JSON.stringify(entryControls));
          fs.mkdirSync(process.env.DONGGU_DRIVING_CAPTURE_DIR, { recursive: true });
          await page.locator('#sheet').screenshot({ path: path.join(process.env.DONGGU_DRIVING_CAPTURE_DIR, 'driving-' + width + '-' + theme + '-entry.png') });
        }
        const lastLeg = page.locator('#dgDrivingPlan .dg-driving-leg').last();
        if (await lastLeg.getAttribute('open') === null) await lastLeg.locator('summary').click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const escaped = await page.locator('#dgDrivingPlan').evaluate(panel => {
          const frame = panel.getBoundingClientRect();
          return [...panel.querySelectorAll('button,.dg-driving-leg')].filter(el => {
            const box = el.getBoundingClientRect(); return box.width > 0 && (box.left < frame.left - 1 || box.right > frame.right + 1);
          }).map(el => {
            const style = getComputedStyle(el), parent = el.parentElement.getBoundingClientRect();
            return { control: el.dataset.dg || el.className, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, frameLeft: frame.left, frameRight: frame.right, visible: el.checkVisibility(), boxSizing: style.boxSizing, cssWidth: style.width, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, parentLeft: parent.left, parentRight: parent.right, parentWidth: parent.width };
          });
        });
        if (escaped.length && process.env.DONGGU_DRIVING_CAPTURE_DIR) {
          fs.mkdirSync(process.env.DONGGU_DRIVING_CAPTURE_DIR, { recursive: true });
          await page.locator('#sheet').screenshot({ path: path.join(process.env.DONGGU_DRIVING_CAPTURE_DIR, 'driving-layout-debug.png') });
        }
        assert.deepEqual(escaped, [], 'Driving actions and leg cards stay inside the ' + width + 'px panel');
        const action = page.locator('[data-dg="driving-open"]').last(); await action.scrollIntoViewIfNeeded();
        assert.equal(await action.isVisible(), true); assert.equal(await action.isEnabled(), true);
        if (process.env.DONGGU_DRIVING_CAPTURE_DIR) {
          fs.mkdirSync(process.env.DONGGU_DRIVING_CAPTURE_DIR, { recursive: true });
          await page.locator('#sheet').screenshot({ path: path.join(process.env.DONGGU_DRIVING_CAPTURE_DIR, 'driving-' + width + '-' + theme + '.png') });
        }
      }
    });
    assert.deepEqual(errors, []); assert.deepEqual(mutations, []); assert.deepEqual(operatingRequests, []);
    console.log(JSON.stringify({ results, browserErrors: errors, mutations, operatingRequests }, null, 2));
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
