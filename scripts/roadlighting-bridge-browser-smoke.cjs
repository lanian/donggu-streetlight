/* Operational bridge UI regressions. Synthetic local records, no production service access. */
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DG_ROADLIGHTING_ROOT || path.join(__dirname, '..'));
const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
function zipFiles(bytes) {
  const files = {}; let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'handoff ZIP uses the portable store method');
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28), contentAt = offset + 30 + nameSize + extraSize;
    files[bytes.subarray(offset + 30, offset + 30 + nameSize).toString('utf8')] = bytes.subarray(contentAt, contentAt + size); offset = contentAt + size;
  }
  return files;
}
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.endsWith('/firebase-config.js')) return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('window.FIREBASE_CONFIG=null;');
  const file = path.resolve(root, '.' + decodeURIComponent(pathname) + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' })[path.extname(file)] || 'application/octet-stream');
  let body = fs.readFileSync(file);
  if (file === path.join(root, 'index.html') && !body.includes('src="app/roadlighting.js"')) body = Buffer.from(body.toString().replace('<script src="app/legacy-bridge.js">', '<script src="app/roadlighting-core.js"></script><script src="app/roadlighting.js"></script><script src="app/legacy-bridge.js">'));
  res.end(body);
});
async function seed(page) {
  await page.evaluate(photo => {
    const now = Date.now(), base = S.lights.find(l => l.lampId && !l.removed);
    const light = { ...base, id: 'pbridge-01', lampId: 'bridge-01', code: '합성 동명동 01', dong: '동명동', status: '고장' };
    const other = { ...base, id: 'unmapped-bridge', lampId: '', code: '합성 산수동 02', dong: '산수동', status: '정상' };
    S.lights = [light, other]; S.allLights = S.lights; S.demoRole = 'admin'; S.names.local = '합성 관리자';
    const inspections = [
      { id: 'bridge-i-normal', lightId: light.id, code: light.code, dong: light.dong, result: '정상', date: now, inspector: 'local', memo: '정상 포함 전체 기록', thumbs: [{ id: 'bridge-photo', label: '현장', t: photo }] },
      { id: 'bridge-i-fault', lightId: light.id, code: light.code, dong: light.dong, result: '고장', date: now - 1000, inspector: 'local', memo: '긴 메모 시작 ' + '현장 상태와 조치 내용을 기록합니다. '.repeat(50) + ' 긴 메모 끝', checks: {} },
      { id: 'bridge-i-other', lightId: other.id, code: other.code, dong: other.dong, result: '고장', date: now - 2000, inspector: 'local', memo: '다른 동 기록', checks: {} }
    ];
    const workOrders = [
      { id: 'bridge-work-await', lightId: light.id, code: light.code, title: '검수 대기 합성 작업', status: 'completed', createdAt: now, updatedAt: now, beforePhotos: ['bridge-photo'], afterPhotos: [] },
      { id: 'bridge-work-verified', lightId: light.id, code: light.code, title: '검수 완료 합성 작업', status: 'verified', createdAt: now, verifiedAt: now, afterPhotos: [] }
    ];
    const reports = [{ id: 'bridge-report', lightId: light.id, code: light.code, issue: '꺼짐', desc: '연락처 필드는 기본 제외', contact: '010-TEST-PRIVATE', name: '합성 신고자', status: '접수', createdAt: now }];
    const workEvents = [{ id: 'bridge-event', workId: workOrders[1].id, lightId: light.id, at: now, toStatus: 'verified', by: 'local', costDelta: 0 }];
    const patrols = [{ id: 'bridge-patrol', dong: '전체', start: now, end: now, dist: 800, passed: [light.id, light.id], marks: [{ id: light.id, at: now, result: '정상' }] }];
    window.__bridgeFixture = { inspections, workOrders, reports, workEvents, patrols }; window.__bridgeOriginal = JSON.stringify(__bridgeFixture);
    window.__bridgeRead = DGData.readAll; DGData.readAll = async (database, collection, options = {}) => {
      if (!Object.prototype.hasOwnProperty.call(__bridgeFixture, collection)) return __bridgeRead(database, collection, options);
      window.__bridgeReadCount = (window.__bridgeReadCount || 0) + 1;
      if (window.__bridgeReadFailure) throw new Error('합성 조회 실패');
      if (window.__bridgeReadHold) { window.__bridgeReadEntered = true; await window.__bridgeReadHold; }
      options.onMetadata?.({ source: window.__bridgeSource || 'local', complete: window.__bridgeComplete !== false, fetchedAt: Date.now() });
      return JSON.parse(JSON.stringify(__bridgeFixture[collection]));
    };
    GAL['bridge-photo'] = { id: 'bridge-photo', lightId: light.id, label: '현장', data: photo, at: now };
    window.__bridgePhotoRows = { 'bridge-photo': { id: 'bridge-photo', lightId: light.id, label: '현장', data: photo, at: now } };
    window.__bridgePhotoReads = 0; window.__bridgeOriginalDoc = db.doc;
    db.doc = function (documentPath) {
      if (!documentPath.startsWith('photos/')) return __bridgeOriginalDoc.call(this, documentPath);
      const id = documentPath.slice('photos/'.length);
      return { id, get: async () => { __bridgePhotoReads++; const row = __bridgePhotoRows[id]; return { id, exists: !!row, data: () => row ? JSON.parse(JSON.stringify(row)) : undefined }; } };
    };
    window.__bridgeBlobTypes = []; const create = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { __bridgeBlobTypes.push(blob.type); return create(blob); };
    S.tab = 'admin'; render();
  }, picture);
  await page.evaluate(() => openAdminSection('roadlighting'));
  await page.locator('#dgRoadlightingBridge').waitFor();
}
async function load(page) { await page.locator('[data-rl="load"]').click(); await page.waitForFunction(() => DGRoadlightingBridge.state.snapshot && !DGRoadlightingBridge.state.loading); }
async function prepare(page) { await page.locator('[data-rl="prepare"]').click(); await page.waitForFunction(() => DGRoadlightingBridge.state.package && !DGRoadlightingBridge.state.preparing); }
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.DONGGU_CHROMIUM ? { executablePath: process.env.DONGGU_CHROMIUM } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const results = [], errors = [];
  async function scenario(name, run) {
    if (process.env.DONGGU_BRIDGE_CASE && !name.includes(process.env.DONGGU_BRIDGE_CASE)) return;
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, serviceWorkers: 'block', acceptDownloads: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: route.request().resourceType() === 'script' ? 'text/javascript' : 'text/css' }));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(name + ': ' + error.message));
    try { await page.goto(origin); await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGIntegration.initialized); assert.equal(await page.evaluate(() => typeof globalThis.DGRoadlightingBridge?.view), 'function', 'operational bridge UI is available'); await seed(page); await run(page, context); results.push(name); console.log('PASS: ' + name); }
    finally { await context.close(); }
  }
  try {
    await scenario('full records and ZIP keep identifiers, photos and source records while download stays unregistered', async page => {
      await load(page); await prepare(page);
      const payload = await page.evaluate(() => ({ entries: DGRoadlightingBridge.state.package.entries, manifest: DGRoadlightingBridge.state.package.manifest, batch: DGRoadlightingBridge.state.package.batchId }));
      assert.ok(payload.entries.some(e => e.internalId === 'bridge-i-normal')); assert.ok(payload.entries.some(e => e.internalId === 'bridge-i-other'));
      assert.equal(payload.manifest.unofficial, true); assert.equal(payload.manifest.apiCompatibility, 'unverified');
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-rl="download"]').click()]); assert.match(download.suggestedFilename(), /\.zip$/);
      assert.ok((await page.evaluate(() => __bridgeBlobTypes)).includes('application/zip'), 'ZIP must retain its binary MIME type');
      const files = zipFiles(fs.readFileSync(await download.path())); assert.ok(files['manifest.json']); assert.ok(files['records.json']); assert.ok(Object.keys(files).some(name => name.startsWith('photos/'))); assert.doesNotMatch(files['records.json'].toString('utf8'), /010-TEST-PRIVATE|합성 신고자/); assert.match(files['records.json'].toString('utf8'), /정상 포함 전체 기록/);
      const ledger = await page.evaluate(id => DGOffline.get('roadlighting-batch', id), payload.batch);
      assert.equal(ledger.status, 'exported'); assert.deepEqual(ledger.receipts, {}); assert.equal(await page.evaluate(() => JSON.stringify(__bridgeFixture) === __bridgeOriginal), true);
      assert.match(await page.locator('#dgRoadlightingBridge').textContent(), /사용자 등록 확인|운영 등록/);
    });
    await scenario('dong and type changes require fresh reads and explicit retries recover failed reads', async page => {
      await load(page); await page.locator('#rlDong').selectOption('동명동'); assert.equal(await page.locator('[data-rl="prepare"]').isDisabled(), true);
      await load(page); await prepare(page); assert.equal(await page.evaluate(() => DGRoadlightingBridge.state.package.entries.some(e => e.internalId === 'bridge-i-other')), false);
      await page.evaluate(() => { __bridgeReadFailure = true; }); await page.locator('[data-rl="load"]').click(); await page.getByText('합성 조회 실패', { exact: true }).waitFor(); assert.equal(await page.locator('[data-rl="prepare"]').isDisabled(), true);
      await page.evaluate(() => { __bridgeReadFailure = false; }); await load(page); assert.equal(await page.locator('[data-rl="prepare"]').isEnabled(), true);
    });
    await scenario('manual registration confirmation persists across re-export without mutating work status', async page => {
      await load(page); await prepare(page); const id = await page.evaluate(() => DGRoadlightingBridge.state.package.batchId);
      await page.locator('[data-rl="batch"][data-id="' + id + '"]').click(); await page.locator('#rlReceiptEntry').selectOption('inspections:bridge-i-normal');
      await page.locator('#rlExternalId').fill('GJD-SYNTHETIC-001'); await page.locator('#rlReceiptNote').fill('운영 화면에서 등록 번호를 확인한 합성 기록'); await page.locator('[data-rl="receipt-save"]').click();
      await page.waitForFunction(async id => (await DGOffline.get('roadlighting-batch', id))?.receipts?.['inspections:bridge-i-normal']?.externalId === 'GJD-SYNTHETIC-001', id);
      await load(page); await prepare(page); const saved = await page.evaluate(id => DGOffline.get('roadlighting-batch', id), id);
      assert.equal(saved.receipts['inspections:bridge-i-normal'].status, 'registered'); assert.equal(saved.receipts['inspections:bridge-i-normal'].verifiedByService, false);
      assert.equal(await page.evaluate(() => __bridgeFixture.workOrders[0].status), 'completed');
      await page.reload(); await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGIntegration.initialized); await page.evaluate(() => { S.tab = 'admin'; render(); openAdminSection('roadlighting'); });
      await page.getByText('GJD-SYNTHETIC-001', { exact: false }).waitFor();
    });
    await scenario('cancel and navigation release unresolved reads and late data cannot publish', async page => {
      await page.evaluate(() => { __bridgeReadHold = new Promise(resolve => { __bridgeRelease = resolve; }); });
      await page.locator('[data-rl="load"]').click(); await page.waitForFunction(() => __bridgeReadEntered);
      await page.locator('[data-rl="cancel"]').click(); assert.equal(await page.locator('[data-rl="load"]').isEnabled(), true);
      await page.evaluate(() => { __bridgeReadHold = null; __bridgeRelease(); }); await load(page);
      await page.evaluate(() => { __bridgeReadEntered = false; __bridgeReadHold = new Promise(resolve => { __bridgeRelease = resolve; }); }); await page.locator('[data-rl="load"]').click(); await page.waitForFunction(() => __bridgeReadEntered);
      await page.evaluate(() => openAdminSection('report')); await page.evaluate(() => { __bridgeReadHold = null; __bridgeRelease(); });
      await page.waitForTimeout(250); assert.equal(await page.locator('#dgRoadlightingBridge').count(), 0); assert.equal(await page.evaluate(() => DGRoadlightingBridge.state.loading), false);
    });
    for (const change of ['account', 'database', 'namespace', 'permission']) await scenario(change + ' changes release unresolved reads without publishing previous data', async page => {
      await page.evaluate(() => { __bridgeReadHold = new Promise(resolve => { __bridgeRelease = resolve; }); }); await page.locator('[data-rl="load"]').click(); await page.waitForFunction(() => __bridgeReadEntered);
      await page.evaluate(async change => {
        if (change === 'account') S.me = 'synthetic-other-user';
        if (change === 'database') db = { ...db };
        if (change === 'namespace') await DGOffline.configure({ namespace: 'synthetic-bridge-other', durable: false, networkRequired: false });
        if (change === 'permission') S.demoRole = 'inspector';
      }, change);
      await page.waitForFunction(() => !DGRoadlightingBridge.state.loading); await page.evaluate(() => { __bridgeReadHold = null; __bridgeRelease(); });
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0))); assert.equal(await page.evaluate(() => DGRoadlightingBridge.state.snapshot), null); assert.equal(await page.evaluate(() => DGRoadlightingBridge.state.package), null);
    });
    await scenario('local receipt CAS conflicts preserve typed confirmation and an explicit refresh preserves other records', async page => {
      await load(page); await prepare(page); const batchId = await page.evaluate(() => DGRoadlightingBridge.state.package.batchId);
      await page.locator('#rlReceiptEntry').selectOption('inspections:bridge-i-normal'); await page.locator('#rlExternalId').fill('GJD-MY-DRAFT'); await page.locator('#rlReceiptNote').fill('내 입력을 보존');
      await page.evaluate(async batchId => {
        const stored = await DGOffline.get('roadlighting-batch', batchId), other = stored.entries.find(entry => entry.key !== 'inspections:bridge-i-normal');
        stored.receipts[other.key] = { status: 'registered', externalId: 'GJD-OTHER-TAB', itemHash: other.hash, at: Date.now(), by: 'local', verifiedByService: false };
        await DGOffline.putIfCurrent('roadlighting-batch', batchId, stored, stored.draftRevision);
      }, batchId);
      await page.locator('[data-rl="receipt-save"]').click(); await page.getByText(/다른 탭에서 연계 이력을 변경/).waitFor();
      assert.equal(await page.locator('#rlExternalId').inputValue(), 'GJD-MY-DRAFT'); assert.equal(await page.locator('#rlReceiptNote').inputValue(), '내 입력을 보존');
      await page.locator('[data-rl="history"]').click(); await page.waitForFunction(() => !DGRoadlightingBridge.state.historyLoading); assert.equal(await page.locator('#rlExternalId').inputValue(), 'GJD-MY-DRAFT');
      await page.locator('[data-rl="receipt-save"]').click(); await page.waitForFunction(async batchId => (await DGOffline.get('roadlighting-batch', batchId)).receipts['inspections:bridge-i-normal']?.externalId === 'GJD-MY-DRAFT', batchId);
      const receipts = await page.evaluate(async batchId => Object.values((await DGOffline.get('roadlighting-batch', batchId)).receipts).map(receipt => receipt.externalId), batchId); assert.ok(receipts.includes('GJD-OTHER-TAB')); assert.ok(receipts.includes('GJD-MY-DRAFT'));
    });
    await scenario('an abandoned pending local history read releases on navigation and retries on return', async page => {
      await page.evaluate(() => {
        __originalBridgeList = DGOffline.list; let first = true;
        DGOffline.list = async kind => { if (kind === 'roadlighting-batch' && first) { first = false; __bridgeHistoryEntered = true; await new Promise(resolve => { __releaseBridgeHistory = resolve; }); } return __originalBridgeList(kind); };
      });
      await page.locator('[data-rl="history"]').click(); await page.waitForFunction(() => __bridgeHistoryEntered); await page.evaluate(() => openAdminSection('report')); await page.waitForFunction(() => !DGRoadlightingBridge.state.historyLoading);
      await page.evaluate(() => openAdminSection('roadlighting')); await page.waitForFunction(() => DGRoadlightingBridge.state.historyRequested && !DGRoadlightingBridge.state.historyLoading); assert.equal(await page.locator('[data-rl="history"]').isEnabled(), true);
      await page.evaluate(() => __releaseBridgeHistory()); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0))); assert.equal(await page.locator('#dgRoadlightingBridge').isVisible(), true);
    });
    await scenario('preview counts use the package selector for old work with recent events and exclude out-of-period reports', async page => {
      await page.evaluate(() => {
        const old = Date.parse('2020-01-01T00:00:00+09:00'), now = Date.now(), lightId = __bridgeFixture.inspections[0].lightId;
        __bridgeFixture.reports.push({ id: 'old-report', lightId, createdAt: old, issue: '기간 밖 신고' });
        __bridgeFixture.inspections.push({ id: 'old-inspection', lightId, date: old, result: '고장' });
        __bridgeFixture.workOrders.push({ id: 'old-work-with-event', lightId, createdAt: old, status: 'assigned', title: '과거 접수·최근 처리' });
        __bridgeFixture.workEvents.push({ id: 'recent-event-old-work', workId: 'old-work-with-event', lightId, at: now, toStatus: 'in_progress' });
      });
      await load(page); const counts = await page.evaluate(() => Object.fromEntries(['inspections','reports','workOrders','workEvents'].map(key => [key,DGRoadlightingBridge.state.snapshot.input[key].length])));
      assert.equal(counts.inspections, 3); assert.equal(counts.reports, 1); assert.equal(counts.workOrders, 3); assert.equal(counts.workEvents, 2);
      await prepare(page); const summary = await page.evaluate(() => DGRoadlightingBridge.state.package.summary); for (const key of Object.keys(counts)) assert.equal(summary[key], counts[key]);
    });
    await scenario('a cancelled download keeps prepared history and receipt input survives live redraws', async page => {
      await load(page); await prepare(page); const id = await page.evaluate(() => DGRoadlightingBridge.state.package.batchId);
      await page.locator('#rlReceiptEntry').selectOption('inspections:bridge-i-normal'); await page.locator('#rlExternalId').fill('GJD-UNSAVED-DRAFT'); await page.locator('#rlReceiptNote').fill('실시간 갱신에도 유지할 메모');
      await page.evaluate(() => { dl.save = async () => { throw Object.assign(new Error('사용자 취소'), { code: 'cancelled' }); }; render(); });
      assert.equal(await page.locator('#rlExternalId').inputValue(), 'GJD-UNSAVED-DRAFT'); assert.equal(await page.locator('#rlReceiptNote').inputValue(), '실시간 갱신에도 유지할 메모');
      await page.locator('[data-rl="download"]').click(); await page.waitForFunction(() => !DGRoadlightingBridge.state.downloading);
      const ledger = await page.evaluate(id => DGOffline.get('roadlighting-batch',id), id); assert.equal(ledger.status, 'prepared'); assert.equal(ledger.exportedAt, undefined); assert.deepEqual(ledger.receipts, {});
    });
    await scenario('unknown shared-source completeness is disclosed consistently in preview and package', async page => {
      await page.evaluate(() => { __bridgeSource = 'artifact'; __bridgeComplete = true; }); await load(page); await prepare(page);
      assert.equal(await page.evaluate(() => DGRoadlightingBridge.state.snapshot.provenance.complete), false); assert.equal(await page.evaluate(() => DGRoadlightingBridge.state.package.manifest.provenance.complete), false);
      assert.match(await page.locator('.rl-preview').textContent(), /전체 여부 미확인/); assert.doesNotMatch(await page.locator('.rl-preview').textContent(), /전체 조회 확인/);
    });
    await scenario('malformed local handoff history is reported without crashing or deleting it', async page => {
      await page.evaluate(async () => DGOffline.putIfCurrent('roadlighting-batch','synthetic-malformed',{schemaVersion:1,targetTenant:'gjd',batchId:'synthetic-malformed'},null));
      await page.locator('[data-rl="history"]').click(); await page.waitForFunction(() => /형식/.test(DGRoadlightingBridge.state.historyError), null, { timeout: 3000 });
      assert.equal(await page.locator('[data-rl="load"]').isEnabled(), true); assert.ok(await page.evaluate(() => DGOffline.get('roadlighting-batch','synthetic-malformed')));
    });
    await scenario('bridge original photos use their captured database rather than another account gallery cache', async page => {
      await page.evaluate(() => { GAL['bridge-photo'] = { id:'bridge-photo',lightId:'foreign-private-light',data:'data:image/png;base64,Zm9yZWlnbg==',label:'다른 계정 캐시' }; });
      await load(page); await prepare(page);
      assert.equal(await page.evaluate(() => __bridgePhotoReads), 1, 'the owner-bound original read bypasses the global gallery cache');
      assert.equal(await page.evaluate(() => DGRoadlightingBridge.state.package.missingPhotos), 0);
      assert.equal(await page.evaluate(() => DGRoadlightingBridge.state.package.manifest.photos.every(photo => photo.sourceKind === 'original')), true);
    });
    await scenario('cancelled paginated reads stop before their next page and a fresh query still completes', async page => {
      await page.evaluate(() => {
        const read = DGData.readAll; let first = true; window.__bridgeExtraPages = 0;
        DGData.readAll = async (database, collection, options = {}) => {
          if (collection === 'inspections' && first) { first = false; __bridgePageEntered = true; await new Promise(resolve => { __bridgePageRelease = resolve; }); options.onPage?.(1); __bridgeExtraPages++; }
          return read(database, collection, options);
        };
      });
      await page.locator('[data-rl="load"]').click(); await page.waitForFunction(() => __bridgePageEntered); await page.locator('[data-rl="cancel"]').click();
      await page.evaluate(() => __bridgePageRelease()); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0))); assert.equal(await page.evaluate(() => __bridgeExtraPages), 0);
      await load(page); assert.equal(await page.locator('[data-rl="prepare"]').isEnabled(), true);
    });
    await scenario('repeated preparation cancels reuse a bounded owner photo pool without starting stale queued reads', async page => {
      await page.evaluate(photo => {
        const source = __bridgeFixture.inspections[0], rows = Array.from({length:6},(_,index) => ({...source,id:'held-inspection-'+index,thumbs:[{id:'held-photo-'+index,label:'현장',t:photo}]}));
        __bridgeFixture.inspections = rows; __bridgeFixture.workOrders.forEach(work => {work.beforePhotos=[];work.afterPhotos=[];});
        window.__photoCalls=0; window.__photoActive=0; window.__photoMax=0; window.__photoHold=true; window.__photoReleases=[]; const doc=db.doc;
        db.doc=function(documentPath){if(!documentPath.startsWith('photos/held-photo-'))return doc.call(this,documentPath);const id=documentPath.slice(7);return{id,get:async()=>{__photoCalls++;__photoActive++;__photoMax=Math.max(__photoMax,__photoActive);if(__photoHold)await new Promise(resolve=>__photoReleases.push(resolve));__photoActive--;return{id,exists:true,data:()=>({id,lightId:source.lightId,data:photo,label:'현장'})};}};};
        const build=DGRoadlightingCore.buildPackage; window.__photoBuilds=0; window.__photoTokens=[]; DGRoadlightingCore.buildPackage=function(input,deps){__photoBuilds++;__photoTokens.push(deps.photoSession);return build(input,deps);};
      },picture);
      await load(page); await page.locator('[data-rl="prepare"]').click(); await page.waitForFunction(() => __photoCalls===3);
      for(let round=0;round<3;round++) {await page.locator('[data-rl="cancel"]').click();await page.locator('[data-rl="prepare"]').click();await page.waitForFunction(count=>__photoBuilds>=count,round+2);await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));assert.equal(await page.evaluate(()=>__photoCalls),3,'cancel/reprepare must not create another set of physical reads');}
      assert.equal(await page.evaluate(()=>__photoTokens.every(token=>token===__photoTokens[0])),true);
      await page.evaluate(()=>{__photoHold=false;__photoReleases.splice(0).forEach(resolve=>resolve());});await page.waitForFunction(()=>DGRoadlightingBridge.state.package&&!DGRoadlightingBridge.state.preparing);
      assert.equal(await page.evaluate(()=>__photoCalls),6);assert.equal(await page.evaluate(()=>__photoMax),3);assert.equal(await page.evaluate(()=>DGRoadlightingBridge.state.package.missingPhotos),0);
    });
    await scenario('a different account and namespace never reuse another owner pending photo response', async page => {
      await page.evaluate(() => {
        const source=__bridgeFixture.inspections[0], canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;const ctx=canvas.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,4,4);window.__ownerPhotoA=canvas.toDataURL('image/png');ctx.fillStyle='#0000ff';ctx.fillRect(0,0,4,4);window.__ownerPhotoB=canvas.toDataURL('image/png');
        __bridgeFixture.inspections=[{...source,thumbs:[{id:'cross-owner-photo',label:'현장'}]}];__bridgeFixture.workOrders.forEach(work=>{work.beforePhotos=[];work.afterPhotos=[];});
        window.__ownerCalls=[];window.__ownerReleases=[];const doc=db.doc;
        db.doc=function(documentPath){if(documentPath!=='photos/cross-owner-photo')return doc.call(this,documentPath);const actor=S.me;return{id:'cross-owner-photo',get:async()=>{__ownerCalls.push(actor);if(actor==='local')await new Promise(resolve=>__ownerReleases.push(resolve));return{id:'cross-owner-photo',exists:true,data:()=>({lightId:source.lightId,data:actor==='local'?__ownerPhotoA:__ownerPhotoB,label:actor})};}};};
      });
      await load(page);await page.locator('[data-rl="prepare"]').click();await page.waitForFunction(()=>__ownerCalls.length===1);
      await page.evaluate(async()=>{S.roles=[...S.roles,{id:'bridge-owner-b',role:'admin'}];S.me='bridge-owner-b';await DGOffline.configure({namespace:'bridge-owner-b-ns',durable:false,networkRequired:false});openAdminSection('roadlighting');});
      await load(page);await prepare(page);
      const proof=await page.evaluate(async()=>({actors:__ownerCalls.slice(),actual:DGRoadlightingBridge.state.package.manifest.photos[0].sha256,expected:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(__ownerPhotoB.split(',')[1]),c=>c.charCodeAt(0))))).map(value=>value.toString(16).padStart(2,'0')).join('')}));
      assert.deepEqual(proof.actors,['local','bridge-owner-b']);assert.equal(proof.actual,proof.expected);await page.evaluate(()=>__ownerReleases.splice(0).forEach(resolve=>resolve()));await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));assert.equal(await page.evaluate(()=>DGRoadlightingBridge.state.package.manifest.photos[0].sha256),proof.expected);
    });
    await scenario('desktop and phone light/dark views retain primary actions and receipt drafts without horizontal overflow', async page => {
      await load(page); await prepare(page); await page.locator('#rlReceiptEntry').selectOption('inspections:bridge-i-normal'); await page.locator('#rlExternalId').fill('GJD-QA-VISUAL'); await page.locator('#rlReceiptNote').fill('화면 확인용 합성 등록 이력'); await page.locator('[data-rl="receipt-save"]').click();
      await page.waitForFunction(() => !DGRoadlightingBridge.state.receiptSaving && Object.values(DGRoadlightingBridge.state.history[0].receipts).some(receipt => receipt.externalId === 'GJD-QA-VISUAL'));
      const artifactDir = process.env.DONGGU_ARTIFACT_DIR; if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
      for (const width of [1280, 390]) for (const theme of ['light','dark']) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); await page.evaluate(theme => { applyTheme(theme); render(); }, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.equal(await page.locator('#dgRoadlightingBridge').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
        assert.equal(await page.locator('[data-rl="load"]').isVisible(), true); assert.equal(await page.locator('[data-rl="prepare"]').isVisible(), true); assert.equal(await page.locator('[data-rl="download"]').isVisible(), true); assert.equal(await page.locator('#rlExternalId').inputValue(), 'GJD-QA-VISUAL');
        if (artifactDir) for (const [name, selector] of [['selection','.rl-selection'],['prepared','.rl-preview'],['confirmation','.rl-receipt']]) { await page.locator(selector).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifactDir, 'bridge-' + width + '-' + theme + '-' + name + '.png') }); }
      }
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ results, browserErrors: errors }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
