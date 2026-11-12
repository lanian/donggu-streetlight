const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../app/inspection-core.js');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const codes = ['lamp', 'flicker', 'fixture', 'pole', 'base', 'cabinet', 'leak', 'tree'];
const checks = value => Object.fromEntries(codes.map(key => [key, value]));
const prepare = patch => C.prepare({ checks: checks('ok'), checkReasons: {}, readings: [], result: '정상', memo: '', ...patch }, codes, 'worker', 2000);

test('unanswered checks remain uninspected and cannot claim a completed normal inspection', () => {
  const result = prepare({ checks: { lamp: 'ok' }, memo: '출입 불가로 일부만 확인' });
  assert.equal(result.checks.leak, 'uninspected'); assert.equal(result.inspectionComplete, false);
  assert.equal(result.result, '점검필요'); assert.equal(result.checkReasons.leak, '출입 불가로 일부만 확인');
});
test('not-inspected and not-applicable outcomes need an explicit recorded reason', () => {
  assert.throws(() => prepare({ checks: { ...checks('ok'), leak: 'uninspected' } }), /사유/);
  assert.throws(() => prepare({ checks: { ...checks('ok'), cabinet: 'na' } }), /사유/);
  const result = prepare({ checks: { ...checks('ok'), cabinet: 'na' }, checkReasons: { cabinet: '해당 시설에 분전함 없음' } });
  assert.equal(result.inspectionComplete, true); assert.equal(result.result, '정상');
});
test('explicit bad evidence cannot be hidden by choosing a normal overall result', () => {
  assert.equal(prepare({ checks: { ...checks('ok'), leak: 'bad' }, result: '정상' }).result, '고장');
  assert.equal(prepare({ checks: { ...checks('ok'), tree: 'bad' }, result: '정상' }).result, '점검필요');
});
test('electrical readings carry a fixed unit, measured time and active actor without an automatic pass threshold', () => {
  const result = prepare({ readings: [{ kind: 'insulationResistance', value: 0.7, unit: 'MΩ', at: 1500 }, { kind: 'leakageCurrent', value: 0, unit: 'mA', at: 1501 }] });
  assert.deepEqual(result.readings.map(r => [r.kind, r.value, r.unit, r.by]), [['insulationResistance', 0.7, 'MΩ', 'worker'], ['leakageCurrent', 0, 'mA', 'worker']]);
  for (const reading of [{ kind: 'voltage', value: 220, unit: 'V' }, { kind: 'leakageCurrent', value: -1, unit: 'mA' }, { kind: 'leakageCurrent', value: 2, unit: 'MΩ' }, { kind: 'leakageCurrent', value: 'unknown', unit: 'mA' }]) assert.throws(() => prepare({ readings: [reading] }));
});
test('partial inspections preserve full-inspection dates, reinspection and newer repair state', () => {
  const current = { status: '고장', statusAt: 3000, lastInspected: 1000, lastResult: '고장', redoNote: '전선 노출' };
  assert.deepEqual(C.lightPatch(current, { date: 2000, result: '정상', inspectionComplete: false }), {});
  assert.deepEqual(C.lightPatch(current, { date: 2000, result: '고장', inspectionComplete: false }), {});
  const patch = C.lightPatch({ ...current, status: '정상', statusAt: 500 }, { date: 2000, result: '고장', inspectionComplete: false });
  assert.deepEqual(patch, { status: '고장', statusAt: 2000, updatedAt: 2000 });
});
test('complete and legacy queued inspections retain the existing formal-date semantics', () => {
  for (const record of [{ date: 2000, result: '정상', inspectionComplete: true }, { date: 2000, result: '정상' }]) {
    const patch = C.lightPatch({ status: '고장', statusAt: 1000, lastInspected: 1000, redoNote: '재점검' }, record);
    assert.equal(patch.lastInspected, 2000); assert.equal(patch.redoNote, null);
  }
});
test('modern inspection validation receipts are deterministic exact-schema copies and legacy jobs need none', () => {
  const record = { lightId: 'p', date: 2000, inspector: 'worker', ...prepare({ readings: [{ kind: 'leakageCurrent', unit: 'mA', value: 2, at: 1500 }] }), memo: 'receipt excludes optional display fields' };
  const receipt = C.proof('inspection-id', record);
  assert.deepEqual(Object.keys(receipt).sort(), ['schemaVersion', 'inspectionId', 'lightId', 'date', 'inspector', 'checks', 'checkReasons', 'inspectionComplete', 'readings', 'result'].sort());
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.inspectionId, 'inspection-id');
  assert.deepEqual(receipt, C.proof('inspection-id', record)); assert.deepEqual(receipt.readings, record.readings);
  receipt.readings[0].value = 99; receipt.checks.lamp = 'bad';
  assert.equal(record.readings[0].value, 2); assert.equal(record.checks.lamp, 'ok');
  assert.equal(C.proof('old', { lightId: 'p', date: 1, inspector: 'worker', checks: { lamp: 'ok' }, result: '정상' }), null);
});
test('measurement receipts have exactly six deterministic fields only for modern nonempty readings', () => {
  const record = { lightId: 'p', date: 2000, inspector: 'worker', ...prepare({ readings: [{ kind: 'leakageCurrent', unit: 'mA', value: 2, at: 1500 }] }) };
  const receipt = C.measurementProof('inspection-id', record);
  assert.deepEqual(Object.keys(receipt).sort(), ['schemaVersion', 'inspectionId', 'lightId', 'date', 'inspector', 'readings'].sort());
  assert.deepEqual(receipt, { schemaVersion: 1, inspectionId: 'inspection-id', lightId: 'p', date: 2000, inspector: 'worker', readings: record.readings });
  assert.deepEqual(receipt, C.measurementProof('inspection-id', record)); receipt.readings[0].value = 99; assert.equal(record.readings[0].value, 2);
  assert.equal(C.measurementProof('empty', { ...record, readings: [] }), null);
  assert.equal(C.measurementProof('legacy', { lightId: 'p', date: 1, inspector: 'worker', checks: { lamp: 'ok' }, result: '정상' }), null);
});

test('the actual inspection job retains reasons/readings and incomplete evidence cannot clear a facility fault', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/staff-app.js'), 'utf8');
  const start = source.indexOf('function inspectionDraftKey('), end = source.indexOf('async function commitInspectionJob(', start);
  const current = { status: '고장', statusAt: 1000, lastInspected: 1000, redoNote: '전線 재점검' };
  const context = vm.createContext({ console, Date, Math, DGData: require('../../app/data'), DGInspectionCore: C, S: { me: 'worker' }, CHECKS: codes.map(k => [k, k]), repSlots: () => ({}), lightState: async () => current, byId: () => current });
  vm.runInContext(source.slice(start, end), context);
  const draft = { checks: { lamp: 'ok' }, memo: '다른 항목은 접근 불가', result: '정상', readings: [{ kind: 'leakageCurrent', unit: 'mA', value: 2, at: 1500 }], photos: [] };
  const job = context.newInspectionJob({ id: 'p', code: 'p', dong: '동' }, draft);
  assert.equal(job.rec.inspectionComplete, false); assert.equal(job.rec.result, '점검필요'); assert.equal(job.rec.readings[0].value, 2);
  assert.equal(job.rec.checkReasons.leak, draft.memo);
  const ops = await context.inspectionOperations(job);
  assert.equal(ops.some(op => op.path === 'lights/p'), false);
  const proof = ops.find(op => op.path === 'inspectionDetails/' + job.id);
  assert.ok(proof); assert.deepEqual(proof.data, C.proof(job.id, job.rec));
  assert.deepEqual(ops.find(op => op.path === 'inspectionMeasurements/' + job.id)?.data, C.measurementProof(job.id, job.rec));
  const first = context.inspectionDraftKey(draft); draft.readings[0].value = 3;
  assert.notEqual(context.inspectionDraftKey(draft), first);
});

test('saving partial evidence cannot overwrite a repair that arrives after inspection reads', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/staff-app.js'), 'utf8');
  const start = source.indexOf('async function inspectionOperations('), end = source.indexOf('/* Replaced at startup by app/legacy-bridge.js (DGIntegration.saveInspection', start);
  let stored = { lights: { p: { status: '정상', statusAt: 1000, updatedAt: 1000, lastInspected: 1000 } } };
  const D = require('../../app/data'), db = D.createLocalDB({ storage: { getItem: () => JSON.stringify(stored), setItem: (_, value) => { stored = JSON.parse(value); } }, indexedDB: null, locks: { request: (_, action) => Promise.resolve().then(action) } });
  const commit = db.commitMany.bind(db); let raced = false;
  db.commitMany = async (ops, options) => { if (!raced) { raced = true; await db.doc('lights/p').update({ status: '정상', statusAt: 3000, updatedAt: 3000, lastInspected: 3000, lastWorkId: 'repair' }); } return commit(ops, options); };
  const context = vm.createContext({ console, Date, DGData: D, DGInspectionCore: C, db, FB: null, S: { me: 'worker' }, GAL: {}, repSlots: () => ({}), lightState: async id => (await db.doc('lights/' + id).get()).data(), byId: () => stored.lights.p });
  vm.runInContext(source.slice(start, end), context);
  await context.commitInspectionJob({ id: 'partial', rec: { lightId: 'p', inspector: 'worker', date: 2000, result: '고장', inspectionComplete: false, checks: { lamp: 'bad' } }, photos: [], fill: [] });
  assert.equal(stored.lights.p.status, '정상'); assert.equal(stored.lights.p.statusAt, 3000); assert.equal(stored.lights.p.lastWorkId, 'repair');
  assert.ok(stored.inspections.partial, 'observation evidence is still saved exactly once');
});

test('Firebase inspection status decisions share the write transaction even for an administrator', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/staff-app.js'), 'utf8');
  const start = source.indexOf('async function inspectionOperations('), end = source.indexOf('/* Replaced at startup by app/legacy-bridge.js (DGIntegration.saveInspection', start);
  const records = { 'lights/p': { status: '정상', statusAt: 1000, updatedAt: 1000, lastInspected: 1000 } };
  let raced = false;
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const inject = () => { if (!raced) { raced = true; records['lights/p'] = { status: '정상', statusAt: 3000, updatedAt: 3000, lastInspected: 3000, lastWorkId: 'repair' }; } };
  const apply = rows => { for (const row of rows) records[row.path] = { ...records[row.path], ...copy(row.data) }; };
  const db = { doc: path => ({ path }), batch() { const rows = []; return { set: (ref, data) => rows.push({ path: ref.path, data }), commit: async () => { inject(); apply(rows); } }; }, async runTransaction(callback) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const read = {}, rows = []; await callback({ get: async ref => { read[ref.path] = copy(records[ref.path]); return { exists: !!records[ref.path], data: () => copy(records[ref.path]) }; }, set: (ref, data) => rows.push({ path: ref.path, data }) });
      inject(); if (Object.entries(read).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(records[key]))) continue;
      apply(rows); return;
    }
    throw new Error('transaction retries exhausted');
  } };
  const context = vm.createContext({ console, Date, DGData: require('../../app/data'), DGInspectionCore: C, db, FB: { fs: db }, S: { me: 'worker' }, GAL: {}, repSlots: () => ({}), lightState: async () => copy(records['lights/p']), byId: () => records['lights/p'] });
  vm.runInContext(source.slice(start, end), context);
  await context.commitInspectionJob({ id: 'partial-fb', rec: { lightId: 'p', inspector: 'worker', date: 2000, result: '고장', inspectionComplete: false }, photos: [], fill: [] });
  assert.equal(records['lights/p'].status, '정상'); assert.equal(records['lights/p'].statusAt, 3000); assert.ok(records['inspections/partial-fb']);
});
test('maximum modern evidence writes photos, parent, both validation receipts and light in one local commit', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/staff-app.js'), 'utf8'), start = source.indexOf('async function inspectionOperations('), end = source.indexOf('/* Replaced at startup by app/legacy-bridge.js (DGIntegration.saveInspection', start);
  let stored = { lights: { p: { status: '고장', statusAt: 1, lastInspected: 1 } } };
  const D = require('../../app/data'), db = D.createLocalDB({ storage: { getItem: () => JSON.stringify(stored), setItem: (_, value) => { stored = JSON.parse(value); } }, indexedDB: null });
  const commit = db.commitMany.bind(db), batches = []; db.commitMany = async (ops, options) => { batches.push(ops.map(row => row.path)); return commit(ops, options); };
  const rec = { lightId: 'p', date: 2000, inspector: 'worker', ...prepare({ readings: Array.from({ length: 10 }, () => ({ kind: 'leakageCurrent', unit: 'mA', value: 2, at: 1500 })) }) };
  const job = { id: 'max', rec, photos: Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, data: { lightId: 'p', inspId: 'max', by: 'worker', kind: 'inspection', data: 'data:image/png;base64,AA==' } })), fill: [] };
  const context = vm.createContext({ console, Date, DGData: D, DGInspectionCore: C, db, FB: null, S: { me: 'worker' }, GAL: {}, repSlots: () => ({}) }); vm.runInContext(source.slice(start, end), context);
  await context.commitInspectionJob(job);
  assert.equal(batches.length, 1); assert.equal(batches[0].length, 10); assert.ok(batches[0].includes('inspectionDetails/max')); assert.ok(batches[0].includes('inspectionMeasurements/max'));
  assert.deepEqual(stored.inspectionDetails.max, C.proof('max', rec)); assert.equal(Object.keys(stored.photos).length, 6); assert.equal(stored.lights.p.status, '정상');
  assert.deepEqual(stored.inspectionMeasurements.max, C.measurementProof('max', rec));
});

test('prepared photo fallback never bypasses a server permission or authentication denial', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/staff-app.js'), 'utf8'), start = source.indexOf('async function getPhoto(id)'), end = source.indexOf('/* ---------- 대표 사진:', start);
  for (const code of ['permission-denied', 'unauthenticated', 'unavailable']) {
    let fallback = 0;
    const context = vm.createContext({ GAL: {}, db: { doc: () => ({ get: async () => { throw Object.assign(new Error(code), { code }); } }) }, DGFieldKit: { getPhoto: async () => { fallback++; return { id: 'p', data: 'data:image/png;base64,AA==' }; } } });
    vm.runInContext(source.slice(start, end), context);
    const value = await context.getPhoto('p');
    assert.equal(fallback, code === 'unavailable' ? 1 : 0); assert.equal(!!value, code === 'unavailable');
  }
});
test('prepared inspection fallback distinguishes network failure from denied server access', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/staff-app.js'), 'utf8'), start = source.indexOf('async function openLight(id)'), end = source.indexOf('function suggestResult()', start);
  for (const code of ['permission-denied', 'unauthenticated', 'unavailable']) {
    let fallback = 0; const box = {};
    const context = vm.createContext({ console, navigator: { onLine: true }, draft: null, S: { me: 'worker', names: {}, reports: [], canWrite: true }, db: {}, DGOffline: { namespace: 'scope' }, byId: () => ({ id: 'p', code: 'P', status: '정상', dong: '동', lastInspected: 0 }), CHECKS: [], LSTAT: [], PT_LAST: {}, FEATURES: {}, PHOTO_MAX: 6, esc: String, fmtD: String, fmtDT: String, kindBadge: () => '', repBox: () => '', posBox: () => '', lightInfo: () => null, adongOf: () => '동', can: () => false, preparedLightHTML: () => '', navRoute() {}, navGen: () => 1, openSheet() {}, restoreDraft() {}, loadGallery() {}, ensureRepPhotos: () => Promise.resolve(), refreshRepBox() {}, posCheckStart() {}, $: () => box, listAllRecords: async () => { throw Object.assign(new Error(code), { code }); }, DGFieldKit: { forLight: async () => { fallback++; return { preparedAt: 1, rows: [], recentInspections: 3 }; } } });
    vm.runInContext(source.slice(start, end), context); await context.openLight('p');
    assert.equal(fallback, code === 'unavailable' ? 1 : 0);
    if (code === 'unavailable') assert.match(box.innerHTML, /출동 준비 자료/); else assert.match(box.textContent, /불러오지 못/);
  }
});
