'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const Data = require('../../app/data.js');
const Core = require('../../app/lighting-area-core.js');
const Commands = require('../../app/lighting-area-commands.js');
const Workflow = require('../../app/lighting-workflow-core.js');
const source = name => fs.readFileSync(path.join(__dirname, '../..', name), 'utf8');
const clone = Data.clone;
const withoutId = ({ id, ...value }) => value;
const record = (id, extra = {}) => ({ id, schemaVersion: 1, label: '산림 내부 제외', effect: 'exclude', reason: 'mountain', note: '보행로 경계 확인', shape: 'circle', lat: 35.14, lng: 126.93, radius: 20, vertices: [], disabled: false, createdAt: 1000, createdBy: 'original-author', updatedAt: 1000, updatedBy: 'original-author', revision: 1, operationId: 'old-area-op', ...extra });

function runInput() {
  const c = { name: '산 아래 길', dong: '지산동', mid: { lat: 35.14, lng: 126.93 }, len: 40, scopeException: ['mountain-one', 'automatic'], context: { classification: 'observed_dark', base: .1, adjusted: .1, coverage: { total: 40, bright: 0, dark: 20, conflict: 0, external: 0, unobserved: 20, supported: 0, unit: 'm' }, sources: [], observations: [] } };
  return { review: { at: Date.UTC(2026, 9, 26, 12), minute: 1260, mode: 'roads', dong: '지산동', kind: '전체', cands: [c], areas: [record('mountain-one')], areaSummary: { manualMeters: 20, manualPoints: 0, includedMeters: 8, byArea: { 'mountain-one': { meters: 20, points: 0 } } }, automaticExclusions: { ways: 1, apt: 0, forest: 72 } }, lights: [], records: [], roads: { ver: 4, at: 1000, ways: [] }, model: { weak: .3 }, calibration: null, baseAt: () => .1 };
}

test('review history preserves the complete area snapshot, scope counts and candidate exceptions', async () => {
  const input = runInput(), original = clone(input.review);
  const run = await Workflow.buildRun(input);
  const versions = JSON.parse(run.inputVersionsJson), candidates = JSON.parse(run.candidatesJson);
  assert.deepEqual(versions.reviewAreas, { records: original.areas, summary: original.areaSummary, automaticExclusions: original.automaticExclusions });
  assert.deepEqual(candidates[0].scopeException, ['mountain-one', 'automatic']);
  assert.equal(candidates.length, run.candidateCount);
  input.review.areas[0].radius = 99; input.review.areaSummary.manualMeters = 300;
  assert.deepEqual(JSON.parse(run.inputVersionsJson).reviewAreas.records, original.areas, 'later scope changes must not rewrite a saved run');
  assert.deepEqual(Workflow.normalizeRun(run), run);
});

test('changing only review-area geometry, state or scope counts changes the run digest', async () => {
  const first = await Workflow.buildRun(runInput());
  for (const change of [input => { input.review.areas[0].radius = 30; }, input => { input.review.areas[0].disabled = true; }, input => { input.review.areaSummary.manualMeters = 25; }, input => { input.review.automaticExclusions.forest = 80; }]) {
    const input = runInput(); change(input);
    const next = await Workflow.buildRun(input);
    assert.notEqual(next.inputDigest, first.inputDigest);
    assert.equal(next.candidatesJson, first.candidatesJson, 'only the review scope changed in this fixture');
  }
  assert.equal((await Workflow.buildRun(runInput())).inputDigest, first.inputDigest);
});

function local(initial = {}) {
  let saved = JSON.stringify(initial);
  const context = vm.createContext({ Date, Math, crypto: webcrypto });
  vm.runInContext(source('app/data.js'), context);
  const db = context.DGData.createLocalDB({ storage: { getItem: () => saved, setItem: (_, value) => { saved = value; } }, indexedDB: null });
  const writes = [], original = db.commitMany;
  db.commitMany = async (ops, options) => { const result = await original(ops, options); writes.push(clone(ops)); return result; };
  return { db, writes, dump: () => JSON.parse(saved), user: 'local' };
}
function firebase(initial = {}) {
  let records = clone(initial);
  const writes = [], reads = [], control = { beforeTransaction: null, failServerRead: false };
  const snapshot = (key, values = records) => ({ exists: Object.hasOwn(values, key), data: () => clone(values[key]) });
  const db = {
    doc: key => ({ path: key, get: async options => {
      reads.push({ key, options });
      if (control.failServerRead) throw Object.assign(new Error('server unavailable'), { code: 'unavailable' });
      return snapshot(key);
    }, set: async () => { throw new Error('Area restore must use revision-checked commands, never raw set'); } }),
    readAll: async collection => Object.entries(records).filter(([key]) => key.startsWith(collection + '/')).map(([key, value]) => ({ ...clone(value), id: key.split('/')[1] })),
    runTransaction: async fn => {
      if (control.beforeTransaction) { const change = control.beforeTransaction; control.beforeTransaction = null; change(records); }
      const next = clone(records), pending = []; let written = false;
      const result = await fn({ get: async ref => { assert.equal(written, false); return snapshot(ref.path, next); }, set: (ref, value) => { written = true; next[ref.path] = clone(value); pending.push({ path: ref.path, data: clone(value) }); } });
      records = next; if (pending.length) writes.push(pending); return result;
    }
  };
  return { db, fb: db, user: 'admin', reads, writes, control, dump: () => clone(records) };
}
function fixture(backend, collections, overwrite = false) {
  let serial = 0;
  const downloads = [], file = { text: async () => JSON.stringify({ app: 'donggu-streetlight', version: 2, complete: true, collections }) };
  const BK = { busy: false, msg: '', photos: true, overwrite, roles: false, file, preview: null };
  const state = { me: backend.user, canWrite: true, lights: [] };
  const context = vm.createContext({ console, Date, Math, Blob, setTimeout, clearTimeout,
    document: { querySelector: () => null, addEventListener() {} },
    DGData: { ...Data, newId: prefix => prefix + '-test-' + (++serial) }, DGLightingAreaCore: Core, DGLightingAreaCommands: Commands,
    DGOffline: { ready: true, register() {}, subscribe() {}, jobs: async () => [], get: async () => null, list: async () => [] },
    BK, FB: backend.fb ? { fs: backend.fb } : null, db: backend.db, S: state,
    listAllRecords: (collection, options) => backend.db.readAll(collection, options), confirm: () => true, render() {}, toast() {}, fmtD: () => '2026.10.26',
    dl: { save: async value => { downloads.push(value); } }
  });
  vm.runInContext(source('app/restore.js'), context);
  vm.runInContext(source('app/lighting-areas.js'), context);
  context.DGLightingAreas.attach({ state: () => state, can: () => true, database: () => backend.db, firebase: () => backend.fb || null, readAll: (collection, options) => backend.db.readAll(collection, options), esc: String, render() {}, toast() {}, invalidateLighting() {} });
  const html = source('index.html'), listStart = html.indexOf('const BK_COLS='), listEnd = html.indexOf('\n', listStart), start = html.indexOf('async function backupExport(){'), end = html.indexOf('/* ---------- period report:', start);
  assert.ok(listStart >= 0 && start >= 0 && end > start);
  vm.runInContext(html.slice(listStart, listEnd) + '\n' + html.slice(start, end), context);
  return { context, BK, downloads, preview: () => context.backupPreview(), restore: () => context.backupImport(), export: () => context.backupExport() };
}

test('actual area backup export preserves records and immutable operation snapshots', async () => {
  const row = withoutId(record('mountain-one'));
  const receipt = { schemaVersion: 1, recordId: 'mountain-one', by: 'original-author', at: 1000, revision: 1, requestHash: 'a'.repeat(64), snapshot: row };
  const backend = local({ lightingAreas: { 'mountain-one': row }, lightingAreaOperations: { 'old-area-op': receipt } });
  const f = fixture(backend, {}); await f.export();
  assert.equal(f.downloads.length, 1);
  const exported = JSON.parse(await f.downloads[0].data.text());
  assert.equal(exported.complete, true); assert.equal(exported.counts.lightingAreas, 1); assert.equal(exported.counts.lightingAreaOperations, 1);
  assert.deepEqual(exported.collections.lightingAreas, [record('mountain-one')]);
  assert.deepEqual(exported.collections.lightingAreaOperations[0].snapshot, row);
});

test('actual area restore skips old receipts and absent disabled areas, and creates a fresh atomic command', async () => {
  const existing = withoutId(record('existing', { label: '현재 구역', revision: 7 }));
  const backend = local({ lightingAreas: { existing } });
  const f = fixture(backend, { lightingAreas: [record('existing', { label: '백업 구역' }), record('new', { label: '  새 구역  ', radius: '25' }), record('disabled', { disabled: true })], lightingAreaOperations: [{ id: 'old-area-op', snapshot: { label: '오래된 영수증' } }] });
  await f.preview();
  assert.equal(f.BK.preview.add, 1); assert.equal(f.BK.preview.skip, 1); assert.equal(f.BK.preview.excluded, 2);
  assert.equal(f.BK.preview.collections.lightingAreaOperations, undefined);
  assert.deepEqual(backend.writes, []);
  await f.restore();
  const saved = backend.dump(), next = saved.lightingAreas.new;
  assert.deepEqual(saved.lightingAreas.existing, existing);
  assert.equal(next.label, '새 구역'); assert.equal(next.radius, 25);
  assert.equal(next.createdBy, 'local'); assert.equal(next.updatedBy, 'local'); assert.equal(next.revision, 1); assert.ok(next.createdAt > 1000);
  assert.match(next.operationId, /^lighting-area-restore-/);
  assert.equal(saved.lightingAreas.disabled, undefined); assert.equal(saved.lightingAreaOperations['old-area-op'], undefined);
  assert.deepEqual(saved.lightingAreaOperations[next.operationId].snapshot, next);
  assert.deepEqual(backend.writes.map(ops => ops.map(op => op.path)), [['lightingAreas/new', 'lightingAreaOperations/' + next.operationId]]);
  assert.match(f.BK.msg, /1건 저장, 1건 건너뜀, 0건 실패, 2건 제외/);
});

test('area backup preview rejects invalid geometry before any restore writes', async () => {
  const backend = local(), f = fixture(backend, { lightingAreas: [record('valid'), record('invalid', { radius: 1001 })] });
  await f.preview();
  assert.equal(f.BK.preview, null); assert.match(f.BK.msg, /백업을 검토하지 못했어요.*반경/);
  await f.restore();
  assert.deepEqual(backend.dump(), {}); assert.deepEqual(backend.writes, []);
});

test('Firebase area overwrite uses the current server revision and retains current creator metadata', async () => {
  const current = withoutId(record('existing', { revision: 7, label: '현재 구역', createdAt: 2000, createdBy: 'current-owner', updatedAt: 3000 }));
  const backend = firebase({ 'lightingAreas/existing': current });
  const f = fixture(backend, { lightingAreas: [record('existing', { label: '복원할 경계', radius: 35, revision: 999 })] }, true);
  await f.preview(); await f.restore();
  const saved = backend.dump(), next = saved['lightingAreas/existing'];
  assert.equal(next.label, '복원할 경계'); assert.equal(next.radius, 35); assert.equal(next.revision, 8);
  assert.equal(next.createdBy, 'current-owner'); assert.equal(next.createdAt, 2000); assert.equal(next.updatedBy, 'admin');
  assert.ok(backend.reads.some(read => read.key === 'lightingAreas/existing' && read.options.source === 'server'));
  assert.deepEqual(saved['lightingAreaOperations/' + next.operationId].snapshot, next);
  assert.equal(backend.writes.length, 1); assert.equal(backend.writes[0].length, 2);
  assert.match(f.BK.msg, /1건 저장, 0건 건너뜀, 0건 실패/);
});

test('a raced area revision preserves the later boundary and returns a failed backup row', async () => {
  const backend = firebase({ 'lightingAreas/existing': withoutId(record('existing', { revision: 7 })) });
  const f = fixture(backend, { lightingAreas: [record('existing', { radius: 35 })] }, true);
  await f.preview();
  backend.control.beforeTransaction = values => { values['lightingAreas/existing'].revision = 8; values['lightingAreas/existing'].radius = 50; values['lightingAreas/existing'].note = '다른 관리자가 수정한 최신 경계'; };
  await f.restore();
  const saved = backend.dump();
  assert.equal(saved['lightingAreas/existing'].radius, 50); assert.equal(saved['lightingAreas/existing'].revision, 8);
  assert.equal(backend.writes.length, 0); assert.equal(Object.keys(saved).length, 1);
  assert.match(f.BK.msg, /0건 저장, 0건 건너뜀, 1건 실패/); assert.notEqual(f.BK.file, null);
  assert.equal(f.downloads.length, 1);
  const failure = JSON.parse(await f.downloads[0].data.text()).failures[0];
  assert.equal(failure.collection, 'lightingAreas'); assert.equal(failure.id, 'existing');
});

test('unavailable server reads cannot restore an area from cached or raw state', async () => {
  const backend = firebase(), f = fixture(backend, { lightingAreas: [record('new')] }, true);
  await f.preview(); backend.control.failServerRead = true; await f.restore();
  assert.deepEqual(backend.dump(), {}); assert.deepEqual(backend.writes, []);
  assert.match(f.BK.msg, /0건 저장, 0건 건너뜀, 1건 실패/);
  assert.deepEqual(clone(backend.reads[0].options), { source: 'server' });
});
