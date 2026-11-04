/* Night theme across the app: walks the main tabs and every management section with the dark theme on, and fails on
   text below 3:1 contrast or a large bright surface. Also checks native controls (color-scheme), dark map tiles, the
   always-dark patrol map, the status-bar colour following a manual theme, and that a forced light theme on a dark
   system stays light. Known intentional bright surfaces: printable QR labels and the inverted toast. */
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
const AUDIT = () => {
  const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const parse = s => { const m = s && s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
  const blend = (fg, bg) => [0, 1, 2].map(i => Math.round(fg[i] * fg[3] + bg[i] * (1 - fg[3])));
  const bgOf = el => { const layers = []; for (let n = el; n && n !== document.documentElement; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; const c = parse(cs.backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let base = layers.length && layers.at(-1)[3] >= 1 ? layers.pop().slice(0, 3) : parse(getComputedStyle(document.body).backgroundColor).slice(0, 3); for (const l of layers.reverse()) base = blend(l, base); return base; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const vis = el => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0 && r.bottom > 0 && r.top < innerHeight * 3; };
  const out = [], seen = new Set(), w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const t = n.textContent.trim(), el = n.parentElement; if (!t || t.length < 2 || !el || !vis(el) || el.closest('script,style,.leaflet-container,svg,.qrl,#toast')) continue;
    const fg = parse(getComputedStyle(el).color), bg = fg && bgOf(el); if (!bg) continue;
    const r = ratio(fg[3] < 1 ? blend(fg, bg) : fg.slice(0, 3), bg), key = el.className + '|' + t.slice(0, 20);
    if (r < 3 && !seen.has(key)) { seen.add(key); out.push('contrast ' + r.toFixed(2) + ' "' + t.slice(0, 30) + '" ' + el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40)); }
  }
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || el.closest('.leaflet-container,svg,.qrl,#toast,.themebtn') || el.matches('button,.btn,input[type=checkbox],input[type=radio],i,img,canvas,video')) continue;
    const c = parse(getComputedStyle(el).backgroundColor), r = el.getBoundingClientRect(); if (!c || c[3] < .9 || lum(c) <= .6 || r.width * r.height < 1200) continue;
    const key = 'surf' + el.tagName + el.className; if (!seen.has(key)) { seen.add(key); out.push('bright surface ' + el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40) + ' ' + getComputedStyle(el).backgroundColor); }
  }
  return out;
};
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const errors = [], checks = [];
  const open = async (scheme, theme) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', colorScheme: scheme });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().url().includes('.js') ? 'text/javascript' : 'text/plain' }));
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); if (process.env.DG_DEBUG) { page.on('framenavigated', f => console.log('NAV', f.url())); page.on('console', m => console.log('C', m.text().slice(0, 120))); }
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);
    await page.evaluate(t => { applyTheme(t); S.demoRole = 'admin'; S.tab = 'inspect'; render(); }, theme);
    return { context, page };
  };
  try {
    // 1. every screen in the night theme (system light, theme chosen in the app — the harder case)
    checks.push('night theme on every screen');
    const { context, page } = await open('light', 'dark');
    const problems = {};
    // close every level and wait until History has settled at depth 0 before the next screen (a pending history.go must not run into it)
    const closeAll = async () => { await page.evaluate(() => { if (NAV.stack.length) closeSheet('all'); }); await page.waitForFunction(() => !NAV.stack.length && (history.state?.nav ?? 0) === 0 && !document.querySelector('#sheet').classList.contains('open')); await page.waitForTimeout(150); };
    const audit = async name => { await page.waitForTimeout(350); const f = await page.evaluate(AUDIT); if (f.length) problems[name] = f; };
    for (const tab of ['inspect', 'admin', 'report']) { await page.evaluate(t => { S.tab = t; render(); }, tab); await audit('tab:' + tab); }
    const sections = await page.evaluate(() => adminKeys());
    assert.ok(sections.length >= 25, 'all management sections are reachable for the audit: ' + sections.length);
    for (const key of sections) { if (process.env.DG_DEBUG) console.log('section', key); await page.evaluate(k => openAdminSection(k), key); await page.waitForTimeout(400); await audit('section:' + key); await closeAll(); }
    await page.evaluate(() => openLight(S.lights.find(l => Number.isFinite(l.lat)).id)); await page.waitForTimeout(300);
    await page.evaluate(() => { document.querySelector('.pair button.b')?.click(); document.querySelectorAll('.pair button.g')[1]?.click(); }); await audit('light detail + checklist');
    await closeAll();
    await page.evaluate(() => { DGDialog.confirm('확인', { title: '버릴까요?', ok: '버리기', danger: true }); }); await audit('dialog'); await page.evaluate(() => DGDialog.cancel());
    assert.deepEqual(problems, {}, 'no low-contrast text or bright surface in the night theme');

    // 2. native controls and the map
    checks.push('native controls, map tiles and status bar');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark', 'form controls, scrollbars and pickers render dark');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.content + '@' + m.getAttribute('media'))), ['#16233D@not all', '#0F1726@all'], 'the status bar follows the chosen theme');
    await page.evaluate(() => openMap('all')); await page.waitForFunction(() => gmap && document.querySelector('#gmap .leaflet-tile-pane'));
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('#gmap .leaflet-tile-pane')).filter), /invert\(1\)/, 'street tiles are darkened');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#gmap .leaflet-bar a')).backgroundColor), 'rgb(23, 34, 58)', 'zoom buttons follow the theme');
    await page.evaluate(() => { gmap.setView([35.1530952, 126.9217072], 18); }); await page.waitForTimeout(500);
    await page.evaluate(() => { gmapLayer.getLayers().find(l => l instanceof L.CircleMarker).fire('click'); }); await page.locator('#mapCard:not([hidden])').waitFor();
    assert.deepEqual(await page.evaluate(AUDIT), [], 'map card and controls are readable');
    await context.close();

    // 3. forced light theme on a dark system stays light; automatic follows the system
    checks.push('light theme on a dark system');
    const light = await open('dark', 'light');
    assert.equal(await light.page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(238, 241, 245)');
    assert.equal(await light.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
    await light.page.evaluate(() => openMap('all')); await light.page.waitForFunction(() => document.querySelector('#gmap .leaflet-tile-pane'));
    assert.equal(await light.page.evaluate(() => getComputedStyle(document.querySelector('#gmap .leaflet-tile-pane')).filter), 'none', 'the light theme keeps the normal street map');
    await light.page.evaluate(() => { closeSheet('all'); applyTheme('auto'); }); await light.page.waitForTimeout(200);
    assert.equal(await light.page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(15, 23, 38)', 'automatic follows the dark system');
    assert.deepEqual(await light.page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.getAttribute('media'))), ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']);

    // 4. the patrol screen is dark in any theme, its map too
    checks.push('patrol map dark in the light theme');
    await light.page.evaluate(() => { applyTheme('light'); openPatrol('전체'); if (pt.watch != null) { navigator.geolocation.clearWatch(pt.watch); pt.watch = null; } ptView('map'); });
    await light.page.waitForFunction(() => document.querySelector('#ptMapBox .leaflet-tile-pane'));
    assert.match(await light.page.evaluate(() => getComputedStyle(document.querySelector('#ptMapBox .leaflet-tile-pane')).filter), /invert\(1\)/);
    assert.equal(await light.page.evaluate(() => getComputedStyle(document.querySelector('#ptFull')).colorScheme), 'dark');
    await light.context.close();

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
