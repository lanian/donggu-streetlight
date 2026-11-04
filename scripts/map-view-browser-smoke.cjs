/* Map view: groups when zoomed out, plate labels when close, status chips and legend toggles, search and "내 주변",
   the info card with 점검하기/길찾기. Real Leaflet on the local registry; tiles and GPS are faked. */
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
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', geolocation: { latitude: 35.1530952, longitude: 126.9217072, accuracy: 9 }, permissions: ['geolocation'] });
  // this smoke models field use on a phone: pin the device profile (a 390px window without touch counts as a PC)
  await context.addInitScript(() => { try { localStorage.setItem('dg-device', 'phone'); } catch (e) {} });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  const count = () => page.evaluate(() => +document.querySelector('#mapCount').textContent.replace(/[^\d]/g, ''));
  try {
    await page.goto(origin);
    await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    const seeded = await page.evaluate(() => {
      S.demoRole = 'admin'; S.tab = 'inspect'; render();
      const ls = S.lights.filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lng));
      ls.slice(0, 30).forEach(l => { l.status = '고장'; }); ls.slice(30, 40).forEach(l => { l.status = '점검필요'; });
      openMap('all');
      return { total: ls.length, first: { id: ls[0].id, code: ls[0].code, lat: ls[0].lat, lng: ls[0].lng } };
    });
    await page.waitForFunction(() => gmap && gmapLayer); await page.waitForTimeout(400);

    // 1. zoomed out: groups whose counts add up to every light, a tap zooms into the group
    checks.push('groups when zoomed out');
    assert.ok(await page.evaluate(() => gmap.getZoom()) < 16, 'the whole district fits below the grouping zoom');
    const clusters = await page.locator('#gmap .mapcl').count(); assert.ok(clusters >= 3, 'several groups, got ' + clusters);
    const sum = await page.evaluate(() => [...document.querySelectorAll('#gmap .mapcl b')].reduce((a, b) => a + +b.textContent.replace(/,/g, ''), 0) + gmapLayer.getLayers().filter(l => l instanceof L.CircleMarker).length);
    assert.equal(sum, seeded.total, 'group counts plus single markers cover every light');
    assert.equal(await count(), seeded.total);
    assert.ok(await page.locator('#gmap .mapcl small').count() >= 1, 'a group shows how many of its lights need attention');
    const z0 = await page.evaluate(() => gmap.getZoom());
    await page.locator('#gmap .mapcl').first().click(); await page.waitForTimeout(900);
    assert.ok(await page.evaluate(() => gmap.getZoom()) > z0, 'tapping a group zooms in');

    // 2. close up: individual markers with plate labels
    checks.push('plate labels when close');
    await page.evaluate(f => { gmap.setView([f.lat, f.lng], 19); }, seeded.first); await page.waitForTimeout(700);
    assert.equal(await page.locator('#gmap .mapcl').count(), 0, 'no groups at zoom 19');
    const markers = await page.evaluate(() => gmapLayer.getLayers().filter(l => l instanceof L.CircleMarker).length);
    const labels = await page.locator('#gmap .maplbl').count();
    assert.ok(markers > 0 && labels === markers, `every marker in view carries its code (${labels}/${markers})`);
    assert.ok(await page.evaluate(code => [...document.querySelectorAll('#gmap .maplbl')].some(e => e.textContent === code), seeded.first.code));

    // 3. status chip and legend toggles filter the markers
    checks.push('status chips and legend toggles');
    await page.locator('#mapStat [data-mstat="고장"]').click(); await page.waitForTimeout(200);
    assert.equal(await count(), 30);
    await page.locator('#mapStat [data-mstat="전체"]').click(); await page.waitForTimeout(200);
    assert.equal(await count(), seeded.total);
    await page.locator('#mapLegend [data-legend="정상"]').click(); await page.waitForTimeout(200);
    assert.equal(await count(), 40, 'hiding 정상 through the legend leaves the 40 flagged lights');
    assert.equal(await page.locator('#mapLegend [data-legend="정상"]').getAttribute('aria-pressed'), 'false');
    await page.locator('#mapLegend [data-legend="정상"]').click(); await page.waitForTimeout(200);
    assert.equal(await count(), seeded.total);
    await page.locator('#mapKind [data-kind="보안등"]').click(); await page.waitForTimeout(200);
    assert.ok(await count() < seeded.total, 'the kind chip still filters');
    await page.locator('#mapKind [data-kind="전체"]').click(); await page.waitForTimeout(200);

    // 3b. a tap that misses a small marker by a finger's width still selects the nearest one; a tap far from any does nothing
    checks.push('near-miss tap selects the nearest marker');
    const view = await page.evaluate(() => ({ c: gmap.getCenter(), z: gmap.getZoom() }));
    const near = await page.evaluate(() => {
      hideMapCard(); gmap.setView([35.1530952, 126.9217072], 19, { animate: false }); drawMapMarkers();
      const box = document.getElementById('gmap').getBoundingClientRect(), size = gmap.getSize();
      const pick = GM.singles.map(l => ({ l, q: gmap.latLngToContainerPoint([l.lat, l.lng]) })).filter(({ l, q }) => q.x > 60 && q.x < size.x - 60 && q.y > 60 && q.y < size.y - 160
        && GM.singles.every(o => o === l || gmap.latLngToContainerPoint([o.lat, o.lng]).distanceTo(q) > 80))[0];
      return pick && { id: pick.l.id, x: box.left + pick.q.x, y: box.top + pick.q.y };
    });
    assert.ok(near, 'an isolated marker to tap');
    await page.mouse.click(near.x + 11, near.y + 6); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => GM.sel), near.id, '12 px off the centre still picks it');
    await page.evaluate(() => hideMapCard());
    await page.mouse.click(near.x + 30, near.y + 26); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => GM.sel), null, 'a tap 40 px away selects nothing');
    await page.evaluate(v => { gmap.setView(v.c, v.z, { animate: false }); drawMapMarkers(); }, view);

    // 4. the card: tap a marker → card with the code, 점검하기 and 길찾기; 길찾기 offers map apps with the coordinates
    checks.push('info card and 길찾기');
    await page.evaluate(id => { gmapLayer.getLayers().find(l => l instanceof L.CircleMarker && l.getLatLng().lat === byId(id).lat && l.getLatLng().lng === byId(id).lng).fire('click'); }, seeded.first.id);
    await page.locator('#mapCard:not([hidden])').waitFor();
    assert.equal(await page.locator('#mapCard b').first().textContent(), seeded.first.code);
    assert.equal(await page.locator('#mapCard [data-map-open]').count(), 1);
    assert.equal(await page.evaluate(() => GM.sel), seeded.first.id);
    await page.evaluate(() => { window.__opened = []; window.open = u => { window.__opened.push(u); return null; }; });
    await page.locator('#mapCard [data-map-route]').click();
    await page.locator('#dgDialog:not([hidden]) [data-dgdlg-choice]').first().waitFor();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#dgDialog [data-dgdlg-choice]')].map(b => b.textContent.replace(/앱이 설치된 경우/, '').trim())), ['카카오맵', '네이버 지도', '구글 지도']);
    await page.locator('#dgDialog [data-dgdlg-choice]', { hasText: '카카오맵' }).click();
    const opened = await page.evaluate(() => window.__opened);
    assert.equal(opened.length, 1); assert.ok(opened[0].startsWith('https://map.kakao.com/link/to/') && opened[0].includes(String(seeded.first.lat)) && opened[0].includes(String(seeded.first.lng)), opened[0]);
    await page.locator('#mapCard [data-map-cardclose]').click();
    assert.equal(await page.evaluate(() => document.querySelector('#mapCard').hidden && GM.sel === null), true);

    // 5. search: hits for a partial code, Enter picks the first, the map moves there and the card opens
    checks.push('search in the map');
    const q = seeded.first.code.slice(0, seeded.first.code.length - 1);
    await page.locator('#mapQ').fill(q); await page.waitForFunction(() => document.querySelectorAll('#mapHits [data-maphit]').length > 0);
    const hits = await page.locator('#mapHits [data-maphit]').count(); assert.ok(hits >= 1 && hits <= 8);
    assert.ok(await page.evaluate(q => [...document.querySelectorAll('#mapHits [data-maphit] b')].every(b => b.textContent.replace(/\s+/g, '').includes(q.replace(/\s+/g, ''))), q));
    await page.evaluate(() => { gmap.setView([35.17, 126.95], 14); }); await page.waitForTimeout(300);
    const target = await page.locator('#mapHits [data-maphit] b').first().textContent();
    await page.locator('#mapQ').press('Enter'); await page.waitForTimeout(900);
    assert.ok(await page.evaluate(() => gmap.getZoom()) >= 18, 'the map zooms to the hit');
    await page.locator('#mapCard:not([hidden])').waitFor();
    assert.equal(await page.locator('#mapCard b').first().textContent(), target);
    assert.equal(await page.evaluate(() => document.querySelector('#mapHits').hidden), true, 'the hit list closes after a pick');
    await page.locator('#mapQ').fill(''); await page.waitForTimeout(300);

    // 6. 내 주변: nearest lights by distance from the live position
    checks.push('내 주변 list');
    await page.locator('#mapLoc').click(); await page.waitForFunction(() => ME.pos);
    await page.locator('#mapNear').click(); await page.waitForFunction(() => document.querySelectorAll('#mapHits [data-maphit]').length > 0);
    const dists = await page.evaluate(() => [...document.querySelectorAll('#mapHits .d')].map(d => parseFloat(d.textContent)));
    assert.ok(dists.length >= 2 && dists.every((d, i) => i === 0 || d >= dists[i - 1]) && dists.at(-1) <= 300, 'sorted by distance within 300 m: ' + dists.join(','));
    assert.equal(await page.locator('#mapNear').getAttribute('aria-pressed'), 'true');
    await page.locator('#mapNear').click(); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.querySelector('#mapHits').hidden), true);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
