/* Lighting context integration regression. Local fixture data only; no production requests.
   DONGGU_PLAYWRIGHT_MODULE and DONGGU_CHROMIUM optionally select existing installations.
   DONGGU_BRIGHTNESS_ROOT optionally selects a separate integration checkout for local review.
   DONGGU_BRIGHTNESS_SCREENSHOT optionally saves the synthetic partial-coverage result card. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(process.env.DONGGU_BRIGHTNESS_ROOT || path.join(__dirname, '..'));
const latitude = 35.14, longitude = 126.93;
const lngAt = metres => longitude + metres / (111320 * Math.cos(latitude * Math.PI / 180));
const columns = ['id', 'kind', 'code', 'dong', 'road', 'main', 'sub', 'lampType', 'lat', 'lng'];
const registry = { cols: columns, count: 2, rows: [
  ['p-brightness-a', '가로등', '검증로 1-1', '지산동', '검증로', '1', '1', 'LED일반형', latitude, lngAt(-35)],
  ['p-brightness-b', '가로등', '검증로 1-2', '지산동', '검증로', '1', '2', 'LED일반형', latitude, lngAt(35)]
] };

async function poll(page, predicate, argument, label) {
  const deadline = Date.now() + 30000;
  do {
    if (await page.evaluate(predicate, argument)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}

function serverFor(directory) {
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return res.writeHead(400).end(); }
    const file = path.resolve(directory, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(directory + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
}

async function openFixture(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC', serviceWorkers: 'block' });
  const externalRequests = [], errors = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      externalRequests.push(url.origin + url.pathname);
      return route.fulfill({ status: 200, body: '', contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/plain' });
    }
    if (url.pathname === '/data/lights.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(registry) });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(origin);
  await page.waitForFunction(() => typeof S !== 'undefined' && S.live && DGOffline.ready);
  assert.equal(await page.evaluate(() => FIREBASE_CONFIG), null, 'the smoke never configures a production Firebase project');
  assert.equal(await page.evaluate(() => DGIntegration.whenReady()), true);
  assert.equal(await page.evaluate(() => S.me), 'local');
  assert.equal(await page.evaluate(() => S.lights.length), registry.count);
  return { context, page, errors, externalRequests };
}

async function main() {
  const server = serverFor(root), results = [];
  const record = message => { results.push(message); console.log('PASS: ' + message); };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.DONGGU_CHROMIUM || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
    const fixture = await openFixture(browser, origin);
    const { page, errors } = fixture;
    assert.ok(await page.evaluate(() => typeof DGLighting !== 'undefined'), 'the lighting UI must be integrated before this regression runs');
    await poll(page, () => DGLighting.state.loaded, undefined, 'lighting context to load');
    await page.evaluate(() => {
      window.__lightingJobs = [];
      const execute = DGLightingCommands.execute;
      DGLightingCommands.execute = async (job, options) => { window.__lightingJobs.push(JSON.parse(JSON.stringify(job))); return execute(job, options); };
      window.__lightingDownloads = [];
      dl = { save: async options => { window.__lightingDownloads.push(options); } };
    });
    const kst = millis => new Date(millis + 9 * 3600000).toISOString().slice(0, 16);
    const confirmed = kst(Date.now() - 3600000);
    const point = { lat: latitude, lng: longitude };
    const close = async () => {
      if (await page.locator('#sheet.open').count()) { await page.keyboard.press('Escape'); await page.locator('#sheet.open').waitFor({ state: 'hidden' }); }
    };
    const section = async key => {
      await close(); await page.locator('[data-tab="admin"]').click();
      await page.locator('[data-asec="' + key + '"]').first().click();
    };
    const writeRecord = async (kind, values = {}, id) => {
      await page.evaluate(async ({ kind, point, id }) => DGLighting.openEditor(kind, point, id), { kind, point: values.point || point, id });
      await page.locator('#lcForm').waitFor();
      const owner = await page.evaluate(() => ({ id: DGLighting.state.draft.recordId, revision: DGLighting.state.draft.expectedRevision }));
      await page.locator('#lcLabel').fill(values.label || (kind === 'source' ? '로컬 검증 외부 보행등' : '로컬 검증 관찰'));
      await page.locator('#lcObservedAt').fill(values.observedAt || confirmed);
      await page.locator('#lcNight').setChecked(values.night !== false);
      await page.locator('#lcRadius').fill(String(values.radius || (kind === 'source' ? 25 : 10)));
      await page.locator('#lcValidDays').fill(String(values.validDays || (kind === 'source' ? 90 : 30)));
      await page.locator('#lcSchedule').selectOption(values.schedule || (kind === 'source' ? 'always' : 'hours'));
      await page.locator('#lcStart').fill(values.start || '20:00'); await page.locator('#lcEnd').fill(values.end || '22:00');
      if (kind === 'source') {
        await page.locator('#lcCategory').selectOption('other_public');
        await page.locator('#lcOperator').fill('로컬 검증기관');
        await page.locator('#lcStatus').selectOption(values.status || 'on');
        await page.locator('#lcStrength').selectOption('medium');
        if (values.linked !== undefined || values.distinct !== undefined) await page.locator('#lcForm details summary').click();
        if (values.linked !== undefined) await page.locator('#lcLinked').fill(values.linked);
        if (values.distinct !== undefined) await page.locator('#lcDistinct').setChecked(values.distinct);
      } else {
        await page.locator('#lcLevel').selectOption(values.level || 'unknown');
        await page.locator('#lcLux').fill(values.lux == null ? '' : String(values.lux));
        await page.locator('#lcInstrument').fill(values.instrument || '');
      }
      await page.locator('#lcNote').fill(values.note || '공개되지 않는 로컬 회귀 데이터');
      await page.locator('#lcSave').click();
      await poll(page, async owner => {
        const snapshot = await db.doc('lightingContext/' + owner.id).get();
        return snapshot.exists && snapshot.data().revision === owner.revision + 1;
      }, owner, 'the lighting record to commit');
      await poll(page, owner => DGLighting.state.records.some(r => r.id === owner.id && r.revision === owner.revision + 1), owner, 'the lighting view to receive the committed revision');
      return owner.id;
    };
    const evaluate = async (location = point, minute = 1260) => page.evaluate(({ point, minute }) => {
      const grid = lightGrid(), xy = grid.toXY(point), base = grid.lightAt(xy.x, xy.y);
      return DGLightingModel.evaluate(DGLighting.context({ minute, now: Date.now() }), point, base, { registryNearby: grid.near(xy.x, xy.y, 90).some(x => !x.it.l.removed) });
    }, { point: location, minute });
    const review = async (mode = 'pairs', time = '21:00') => {
      await section('light');
      await page.locator('[data-rvmode="' + mode + '"]').click();
      await page.locator('#rvTime').fill(time);
      await page.evaluate(() => { window.__previousBrightnessReview = S.review; });
      await page.locator('#rvRun').click();
      await poll(page, mode => !!S.review && S.review !== window.__previousBrightnessReview && S.review.mode === mode && !S.review.stale, mode, 'the brightness review to finish');
      await page.locator('#rvEvidence').selectOption('all');
      return page.evaluate(() => JSON.parse(JSON.stringify(S.review.cands)));
    };
    try {
      const before = await review();
      assert.equal(before.length, 1, 'the isolated 70m fixture has one registry-only weak midpoint');
      const base = before[0].E;
      await section('lightingcontext');
      assert.equal(await page.locator('[data-lc="new-source"]').count(), 1);
      const sourceId = await writeRecord('source');
      const stored = await page.evaluate(async id => (await db.doc('lightingContext/' + id).get()).data(), sourceId);
      assert.equal(stored.observedAt, Date.parse(confirmed + '+09:00'), 'datetime-local is interpreted as KST even when the browser time zone is UTC');
      assert.equal(await page.evaluate(() => S.lights.length), registry.count, 'supplemental lights never become managed assets');
      assert.ok(await page.evaluate(() => !S.review || S.review.stale), 'adding context invalidates earlier review results');
      const withSource = await review();
      assert.equal(withSource.length, 1, 'the registry weak point remains reviewable with its new evidence');
      assert.equal(withSource[0].E, base, 'the original registry-only index remains visible');
      assert.ok(withSource[0].context.adjusted > withSource[0].context.base);
      assert.equal(withSource[0].context.classification, 'external_supported');
      record('a manually confirmed external light supports the model without altering managed assets or the registry-only index; KST input is explicit');

      await page.locator('#csv4').click();
      const csv = await page.evaluate(() => window.__lightingDownloads.at(-1)?.data);
      assert.ok(typeof csv === 'string' && csv.includes('외부 광원'), 'CSV carries the supplemental-light interpretation');
      await page.locator('[data-rvmap="all"]').click();
      await page.locator('#gmap').waitFor();
      assert.ok(await page.evaluate(label => {
        const popupTexts = []; gmap.eachLayer(layer => { const popup = layer.getPopup?.(); if (popup) popupTexts.push(String(popup.getContent())); });
        return popupTexts.some(text => text.includes(label));
      }, stored.label), 'the review map identifies the source behind the supplemental contribution');
      record('review CSV and map expose supplemental-light evidence');

      await page.reload();
      await page.waitForFunction(() => S.live && DGOffline.ready);
      assert.equal(await page.evaluate(() => DGIntegration.whenReady()), true);
      await poll(page, id => DGLighting.state.records.some(r => r.id === id), sourceId, 'the saved source after reload');
      await page.evaluate(() => { window.__lightingJobs = []; const execute = DGLightingCommands.execute; DGLightingCommands.execute = async (job, options) => { window.__lightingJobs.push(JSON.parse(JSON.stringify(job))); return execute(job, options); }; });
      await review();
      await writeRecord('source', { status: 'off' }, sourceId);
      assert.ok(await page.evaluate(() => !S.review || S.review.stale), 'same-count source edits invalidate the previous result');
      const switchedOff = await evaluate();
      assert.equal(switchedOff.external, 0);
      assert.equal(switchedOff.adjusted, switchedOff.base);
      assert.ok(switchedOff.hints.some(hint => hint.reason === 'off'));
      record('source records survive reload; editing one existing record invalidates results and an off light cannot brighten them');

      await writeRecord('source', { schedule: 'hours', start: '18:00', end: '06:00' }, sourceId);
      assert.ok((await evaluate(point, 1260)).external > 0);
      assert.ok((await evaluate(point, 120)).external > 0, 'overnight schedules cover the following early morning');
      assert.equal((await evaluate(point, 720)).external, 0, 'night-only source is not applied at noon');
      const oldJob = await page.evaluate(() => window.__lightingJobs.find(job => job.data.status === 'off'));
      assert.ok(oldJob);
      await page.evaluate(job => DGLightingCommands.execute(job, { db, fb: null, user: 'local', admin: true }), oldJob);
      const latest = await page.evaluate(async id => (await db.doc('lightingContext/' + id).get()).data(), sourceId);
      assert.equal(latest.status, 'on', 'replaying an older successful command cannot undo a newer record');
      assert.equal(latest.revision, 3);
      record('KST overnight hours are bounded; immutable operation receipts prevent an old successful retry from overwriting a later edit');

      const beforeObservation = await evaluate();
      const beforeRejected = await page.evaluate(() => DGLighting.state.records.length);
      await page.evaluate(point => DGLighting.openEditor('observation', point), point);
      await page.locator('#lcLabel').fill('기기 없는 실측 거부 검증');
      await page.locator('#lcLux').fill('0');
      await page.locator('#lcSave').click();
      await poll(page, () => /기기|장비/.test(document.querySelector('#toast')?.textContent || ''), undefined, 'a missing-instrument validation message');
      assert.equal(await page.evaluate(() => DGLighting.state.records.length), beforeRejected);
      assert.equal(await page.locator('#lcLux').inputValue(), '0', 'rejected measurement keeps its input');
      await page.locator('[data-lc="discard"]').click();
      const measurementId = await writeRecord('observation', { label: '0 lux 입력 검증', level: 'unknown', lux: 0, instrument: '검증 조도계 · 보행면 수평' });
      const measurement = await page.evaluate(async id => (await db.doc('lightingContext/' + id).get()).data(), measurementId);
      assert.equal(measurement.lux, 0);
      assert.equal(measurement.instrument, '검증 조도계 · 보행면 수평');
      const afterObservation = await evaluate();
      assert.equal(afterObservation.adjusted, beforeObservation.adjusted, 'measured lux is never added to the relative model');
      const brightId = await writeRecord('observation', { label: '가운데 밝음 관찰', level: 'bright' });
      await writeRecord('observation', { label: '가운데 어두움 관찰', level: 'dark' });
      assert.equal((await evaluate()).classification, 'conflict');
      await writeRecord('observation', { label: '가운데 밝음 관찰', level: 'bright', validDays: 1, observedAt: kst(Date.now() - 2 * 86400000) }, brightId);
      const expired = await evaluate();
      assert.equal(expired.classification, 'observed_dark');
      assert.ok(expired.hints.some(hint => hint.reason === 'stale'));
      record('0 lux remains distinct from missing data and never changes the model; conflicting observations are visible and expired bright evidence cannot suppress current darkness');

      const remote = { lat: latitude + 1000 / 110540, lng: longitude };
      await writeRecord('observation', { label: '긴 도로 일부만 밝음', level: 'bright', point: remote, radius: 10 });
      await page.evaluate(({ latitude, start, end }) => {
        ROADS = { ver: 4, ways: [{ id: 'local-road', type: 'residential', name: '부분 관찰 검증로', pts: [[latitude, start], [latitude, end]] }], areas: [], bounds: [] };
        LG = null; S.rvNoLight = true; S.review = null;
      }, { latitude: remote.lat, start: lngAt(-100), end: lngAt(100) });
      const roadCandidates = await review('roads');
      const partial = roadCandidates.find(c => c.name === '부분 관찰 검증로');
      assert.ok(partial && partial.len >= 195);
      assert.ok(partial.context.coverage.bright > 0 && partial.context.coverage.bright < partial.context.coverage.total);
      assert.notEqual(partial.context.classification, 'observed_bright', 'a short observed range does not certify the whole long road');
      assert.equal(partial.context.adjusted, partial.context.base, 'field brightness does not turn into an artificial model contribution');
      record('a 10m observation radius affects only part of a 200m road and does not label the complete road as observed bright');

      const managedPoint = { lat: latitude, lng: lngAt(-35) };
      await writeRecord('observation', { label: '모델과 다른 현장 어두움', level: 'dark', point: managedPoint, radius: 5 });
      const reverse = await review('pairs');
      assert.ok(reverse.some(c => c.point && c.context.base >= .3 && c.context.classification === 'observed_dark'), 'a dark field observation is retained even where the registry model is strong');
      const beforeDuplicate = await evaluate(managedPoint);
      await writeRecord('source', { label: '이미 등록된 동일 광원', point: managedPoint, linked: 'p-brightness-a' });
      const duplicate = await evaluate(managedPoint);
      assert.equal(duplicate.external, beforeDuplicate.external);
      assert.ok(duplicate.hints.some(hint => hint.reason === 'linked_registry'));
      record('reverse model/field disagreements remain candidates, and a source linked to a managed asset cannot be counted twice');

      await page.evaluate(() => {
        const execute = DGLightingCommands.execute;
        DGLightingCommands.execute = async (job, options) => {
          if (job.data.label === '지연 저장 소유권') await new Promise(resolve => { window.__releaseLightingSave = resolve; });
          return execute(job, options);
        };
      });
      await page.evaluate(point => DGLighting.openEditor('source', point), point);
      await page.locator('#lcLabel').fill('지연 저장 소유권');
      await page.locator('#lcSave').click();
      await poll(page, () => typeof window.__releaseLightingSave === 'function', undefined, 'the controlled delayed save');
      const pendingOwner = await page.evaluate(() => ({ id: DGLighting.state.draft.recordId, job: DGLighting.state.draft.pending }));
      await close();
      await page.evaluate(point => DGLighting.openEditor('observation', point), point);
      await page.locator('#lcLabel').fill('이후 작성한 새 관찰');
      const newOwnerId = await page.evaluate(() => DGLighting.state.draft.recordId);
      await poll(page, async id => (await DGOffline.get('lightingDraft', id))?.data.label === '이후 작성한 새 관찰', newOwnerId, 'the newer editor draft to persist');
      await page.evaluate(() => window.__releaseLightingSave());
      await poll(page, async owner => (await db.doc('lightingContext/' + owner.id).get()).exists, pendingOwner, 'the original delayed record to commit');
      await poll(page, async owner => (await DGOffline.jobs()).find(job => job.id === owner.job)?.state === 'synced', pendingOwner, 'the original delayed job to finish');
      assert.equal(await page.locator('#lcLabel').inputValue(), '이후 작성한 새 관찰');
      assert.equal(await page.evaluate(() => DGLighting.state.draft?.data.label), '이후 작성한 새 관찰');
      assert.equal(await page.evaluate(async id => (await DGOffline.get('lightingDraft', id))?.data.label, newOwnerId), '이후 작성한 새 관찰');
      await page.locator('[data-lc="discard"]').click();
      record('completion of an older delayed save preserves a newer editor and its durable draft');

      await page.evaluate(id => DGLighting.openEditor(null, null, id), sourceId);
      await page.locator('#lcNote').fill('충돌 시 유지할 작성 내용');
      await page.evaluate(async id => { const ref = db.doc('lightingContext/' + id), old = (await ref.get()).data(); await ref.update({ revision: old.revision + 1, note: '다른 직원이 먼저 바꾼 기록' }); }, sourceId);
      await page.locator('#lcSave').click();
      await poll(page, async () => (await DGOffline.jobs()).some(job => job.kind === 'lighting' && job.state === 'conflict'), undefined, 'a visible lighting revision conflict');
      assert.equal(await page.evaluate(async id => (await db.doc('lightingContext/' + id).get()).data().note, sourceId), '다른 직원이 먼저 바꾼 기록');
      assert.equal(await page.evaluate(() => DGLighting.state.draft?.data.note), '충돌 시 유지할 작성 내용');
      assert.equal(await page.locator('#lcNote').inputValue(), '충돌 시 유지할 작성 내용');
      record('a concurrent edit produces a retryable outbox conflict and preserves the user draft without overwriting the newer record');

      const secondPage = await fixture.context.newPage();
      secondPage.on('pageerror', error => errors.push(error.message));
      secondPage.on('dialog', dialog => dialog.accept());
      await secondPage.goto(origin); await secondPage.waitForFunction(() => S.live && DGOffline.ready);
      assert.equal(await secondPage.evaluate(() => DGIntegration.whenReady()), true);
      await page.evaluate(point => DGLighting.openEditor('observation', point), point);
      await secondPage.evaluate(point => DGLighting.openEditor('source', point), point);
      const firstDraftId = await page.evaluate(() => DGLighting.state.draft.recordId);
      const secondDraftId = await secondPage.evaluate(() => DGLighting.state.draft.recordId);
      assert.notEqual(firstDraftId, secondDraftId);
      await Promise.all([page.locator('#lcLabel').fill('첫 탭의 미전송 관찰'), secondPage.locator('#lcLabel').fill('둘째 탭의 미전송 광원')]);
      await poll(page, async ids => {
        const a = await DGOffline.get('lightingDraft', ids[0]), b = await DGOffline.get('lightingDraft', ids[1]);
        return a?.data.label === '첫 탭의 미전송 관찰' && b?.data.label === '둘째 탭의 미전송 광원';
      }, [firstDraftId, secondDraftId], 'independent lighting drafts from both tabs');
      await secondPage.close(); await page.reload(); await page.waitForFunction(() => S.live && DGOffline.ready);
      assert.equal(await page.evaluate(() => DGIntegration.whenReady()), true);
      const restored = await page.evaluate(async ids => Promise.all(ids.map(async id => (await DGOffline.get('lightingDraft', id))?.data.label)), [firstDraftId, secondDraftId]);
      assert.deepEqual(restored, ['첫 탭의 미전송 관찰', '둘째 탭의 미전송 광원']);
      for (const [id, label] of [[firstDraftId, restored[0]], [secondDraftId, restored[1]]]) {
        await section('outbox');
        await page.locator('[data-dg="queue-refresh"]').click();
        await page.locator('[data-dg="recover-draft"][data-kind="lightingDraft"][data-id="' + id + '"]').click();
        await page.locator('#lcLabel').waitFor();
        assert.equal(await page.locator('#lcLabel').inputValue(), label, 'the selected draft is recoverable through the outbox UI');
      }
      record('different records drafted in two tabs keep separate durable keys and both remain recoverable after reload');
      if (process.env.DONGGU_BRIGHTNESS_SCREENSHOT) {
        await page.evaluate(({ latitude, start, end }) => {
          ROADS = { ver: 4, ways: [{ id: 'local-road', type: 'residential', name: '부분 관찰 검증로', pts: [[latitude, start], [latitude, end]] }], areas: [], bounds: [] };
          LG = null; S.rvNoLight = true; S.review = null;
        }, { latitude: remote.lat, start: lngAt(-100), end: lngAt(100) });
        await review('roads');
        const card = page.locator('.rv-candidate').filter({ hasText: '부분 관찰 검증로' });
        await card.locator('summary').click();
        await card.screenshot({ path: process.env.DONGGU_BRIGHTNESS_SCREENSHOT });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the phone layout has no horizontal overflow');
      assert.deepEqual(errors, [], 'the actual browser has no uncaught exceptions');
      console.log(JSON.stringify({ results, browserErrors: errors, blockedExternalRequests: fixture.externalRequests.length }, null, 2));
    } catch (error) {
      const diagnostic = await page.evaluate(async () => ({
        toast: document.querySelector('#toast')?.textContent, lightingError: DGLighting.state.error,
        recordCount: DGLighting.state.records.length, editor: DGLighting.state.draft,
        review: S.review && { mode: S.review.mode, stale: S.review.stale, candidates: S.review.cands },
        jobs: (await DGOffline.jobs()).map(job => ({ kind: job.kind, state: job.state, error: job.error, summary: job.summary }))
      })).catch(() => ({}));
      console.error(JSON.stringify({ results, browserErrors: errors, diagnostic }, null, 2));
      throw error;
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
