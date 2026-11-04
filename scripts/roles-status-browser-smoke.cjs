/* Roles and resident status: 관리 현황 names my role and opens 내 권한 with the capability table (my column marked);
   a blocked action says which role it needs and what mine is. On the citizen report page with a gateway and
   statusUrl, a sent report shows its check code, is remembered on the device, and 처리 상태 보기 shows only the stage. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '..');
const stages = new Map();
const server = http.createServer((req, res) => {
  // Browser checks always run the device (체험) mode: the deployed firebase-config.js points at the real project.
  if (req.url.split('?')[0].endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG = null;'); }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'POST' && (pathname === '/gw' || pathname === '/st')) {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const data = JSON.parse(body); res.setHeader('Content-Type', 'application/json');
      if (pathname === '/gw') { stages.set('R261104-0000ABCD', 'received'); return res.end(JSON.stringify({ receipt: 'R261104-0000ABCD', id: 'qr-x', statusCode: 'K7P2QM' })); }
      if (data.receipt !== 'R261104-0000ABCD' || data.code !== 'K7P2QM') { res.statusCode = 404; return res.end(JSON.stringify({ error: '접수번호나 확인 코드가 맞지 않아요. 다시 확인해 주세요.' })); }
      const stage = stages.get(data.receipt);
      res.end(JSON.stringify({ receipt: data.receipt, stage, label: stage === 'in-progress' ? '처리 중이에요' : '접수됐어요', detail: '안내', updatedOn: '2026-11-04' }));
    }); return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = 'http://localhost:' + port;
  const browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { try { localStorage.setItem('dg-device', 'phone'); } catch (e) {} });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/report/config.js') return route.fulfill({ contentType: 'text/javascript', body: `window.REPORT_CONFIG={org:"동구청",dept:"가로등",phone:"062-111-2222",backend:"gateway",gatewayUrl:"http://localhost:${port}/gw",statusUrl:"http://localhost:${port}/st",allowLocalGateway:true,firestore:{},privacyDays:90,maxPhotoKB:150};` });
    return url.origin === origin || url.origin === 'http://127.0.0.1:' + port ? route.continue() : route.fulfill({ status: 200, body: '', contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/plain' });
  });
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { errors.push('native dialog: ' + d.message()); d.dismiss(); });
  try {
    await page.goto(origin); await page.waitForFunction(() => S.live && DGOffline.ready && S.me === 'local' && DGIntegration.initialized);

    // 1. inspector: role line, 내 권한 sheet, table marks my column, admin-only rows are blocked
    checks.push('inspector sees their role and what it allows');
    await page.evaluate(() => { S.demoRole = 'inspector'; S.tab = 'admin'; render(); });
    assert.match(await page.locator('.myrole').textContent(), /내 역할: 점검자/);
    await page.locator('.myrole [data-myrole]').click(); await page.locator('#sheet .role-table').waitFor();
    assert.equal(await page.evaluate(() => NAV.stack.at(-1).key), 'myrole');
    assert.match(await page.locator('#sheet .role-table thead th.mine').textContent(), /점검자/);
    const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#sheet .role-table tbody tr:not(.grp)')].map(tr => [tr.querySelector('th').textContent, [...tr.querySelectorAll('td')].map(td => td.textContent)])));
    assert.deepEqual(rows['점검 기록 남기기(결과·사진·메모)'], ['✓', '✓', '–']);
    assert.deepEqual(rows['점검 결과 검수 · 재점검 요청'], ['✓', '–', '–']);
    assert.deepEqual(rows['접수번호와 확인 코드로 처리 상태 확인'], ['✓', '✓', '✓']);
    assert.match(await page.locator('#sheet').textContent(), /관리자에게 요청/);
    await page.evaluate(() => closeSheet('all'));
    // the table agrees with can()
    assert.deepEqual(await page.evaluate(() => [can('inspect'), can('admin')]), [true, false]);
    // a blocked action names the needed role and mine
    await page.evaluate(() => need('admin')); assert.match(await page.locator('#toast').textContent(), /관리자만.*내 역할: 점검자/);

    // 2. admin: the roles section carries the table
    checks.push('admin roles section has the table');
    await page.evaluate(() => { S.demoRole = 'admin'; render(); openAdminSection('roles'); });
    await page.locator('#sheet details.help .role-table').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#sheet .role-table thead th.mine').textContent().then(t => /관리자/.test(t)), true);
    await page.evaluate(() => closeSheet('all'));

    // 2b. no staff role (signed out, or signed in without approval): the resident's report entry, no staff data
    checks.push('people without a staff role get the resident entry');
    await page.evaluate(() => { S.fbSignedOut = true; render(); });
    assert.equal(await page.locator('#view .resident a.btn').first().getAttribute('href'), await page.evaluate(() => REPORT_URL));
    assert.equal(await page.locator('#fbSignIn').count(), 1);
    assert.equal(await page.locator('#view .row[data-light]').count(), 0, 'no light list without a role');
    await page.evaluate(() => { S.fbSignedOut = false; render(); });
    assert.match(await page.evaluate(() => vNoAccess()), /직원 승인 전이에요[\s\S]*가로등 고장 신고하기/);

    // 3. resident report page: send → code shown and remembered → status lookup shows only the stage
    checks.push('citizen sees a check code and the stage');
    await page.goto(origin + '/report/?c=' + encodeURIComponent('산수동 642'));
    assert.equal(await page.locator('#statusOpen').isVisible(), true);
    assert.match(await page.locator('#footLead').textContent(), /처리 상태 보기/);
    await page.locator('#issues button').first().click(); await page.locator('#useGps').uncheck();
    await page.locator('#send').click(); await page.locator('#done:not([hidden])').waitFor();
    assert.equal(await page.locator('#receipt').textContent(), 'R261104-0000ABCD');
    assert.equal(await page.locator('#doneCodeText').textContent(), 'K7P2QM');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('dg-report-receipts')).map(x => [x.r, x.k])), [['R261104-0000ABCD', 'K7P2QM']]);
    await page.locator('#doneStatus').click(); await page.locator('#stResult:not([hidden])').waitFor();
    assert.match(await page.locator('#stResult').textContent(), /접수됐어요/);
    assert.equal(await page.locator('#stResult .steps li.now').textContent(), '접수');
    // a later visit: the saved receipt is one tap away and follows the stage
    stages.set('R261104-0000ABCD', 'in-progress');
    await page.goto(origin + '/report/'); await page.locator('#statusOpen').click();
    await page.locator('#stSavedList button').first().click();
    await page.waitForFunction(() => /처리 중이에요/.test(document.querySelector('#stResult').textContent));
    assert.equal(await page.locator('#stResult .steps li.on').count(), 2);
    // a wrong code is explained, nothing shown
    await page.locator('#stCode').fill('AAAAAA'); await page.locator('#stCheck').click();
    await page.locator('#stErr:not([hidden])').waitFor(); assert.match(await page.locator('#stErr').textContent(), /맞지 않아요/);
    assert.equal(await page.locator('#stResult').isHidden(), true);
    // malformed input never leaves the page
    await page.locator('#stReceipt').fill('12345'); await page.locator('#stCheck').click();
    assert.match(await page.locator('#stErr').textContent(), /접수번호를 확인/);

    // 4. without statusUrl the page keeps the old phone wording and no lookup button
    checks.push('lookup hidden when not configured');
    await context.unroute('**/*');
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
    await page.goto(origin + '/report/'); assert.equal(await page.locator('#statusOpen').isHidden(), true);
    assert.match(await page.locator('#footLead').textContent(), /신고만 받아요/);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ results: checks, browserErrors: errors }, null, 2));
  } finally { await context.close(); await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
