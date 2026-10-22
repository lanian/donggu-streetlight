const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function section(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Source section exists: ${start}`);
  return html.slice(a, b);
}
function context(values = {}) {
  return vm.createContext({ console, Date, Math, crypto: webcrypto, ...values });
}
function load(ctx, start, end) { vm.runInContext(section(start, end), ctx); }
function storage(initial) {
  let saved = JSON.stringify(initial);
  return {
    fail: false,
    getItem() { return saved; },
    setItem(key, value) {
      if (this.fail) { const e = new Error('storage full'); e.name = 'QuotaExceededError'; throw e; }
      saved = value;
    },
  };
}
function localStore(backing) {
  const c = context({ localStorage: backing });
  load(c, 'function localDb(){', '/* Registry:');
  return c.localDb();
}
function memoryDb(initial = {}) {
  const records = copy(initial);
  const control = { failPath: null, rejectBatch: false, loseBatchAck: false, beforeWrite: null, batches: 0 };
  function apply(op) { records[op.path] = op.merge ? { ...(records[op.path] || {}), ...copy(op.data) } : copy(op.data); }
  const db = {
    doc(key) {
      return {
        path: key,
        async get() { return { exists: key in records, data: () => records[key] && copy(records[key]) }; },
        async set(data, options) {
          if (control.beforeWrite) await control.beforeWrite(key);
          if (control.failPath === key) throw new Error('simulated write failure');
          apply({ path: key, data, merge: !!options });
        },
        async update(data) {
          if (control.beforeWrite) await control.beforeWrite(key);
          if (control.failPath === key) throw new Error('simulated write failure');
          assert.ok(key in records, 'update requires an existing document');
          apply({ path: key, data, merge: true });
        },
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, data, options) { ops.push({ path: ref.path, data: copy(data), merge: !!options }); },
        async commit() {
          control.batches++;
          if (control.beforeWrite) await control.beforeWrite('batch');
          if (control.rejectBatch) throw new Error('simulated batch rejection');
          for (const op of ops) apply(op);
          if (control.loseBatchAck) { control.loseBatchAck = false; throw new Error('simulated lost acknowledgement'); }
        },
      };
    },
  };
  return { db, records, control };
}
function inspectionContext(db, { firebase = false, local = false } = {}) {
  const light = { id: 'p1', code: '지호로 1', dong: '지산동' };
  const source = { lightId: light.id, checks: { lamp: 'bad' }, result: '고장', photos: [], memo: 'original' };
  const nodes = { '#saveInsp': { disabled: false }, '#iMemo': { value: 'original' } };
  const toasts = [];
  const c = context({
    db, FB: firebase ? { fs: db } : null,
    S: { me: local ? 'local' : 'staff' },
    OV: { p1: { status: '정상' } },
    CHECKS: [['lamp', '점등 상태']],
    draft: source, DRAFTS: {}, GAL: {},
    byId: id => id === light.id ? light : null,
    $: id => nodes[id],
    repSlots: () => ({}),
    repPatchFor: async reps => ({ reps: copy(reps), photoT: 'representative thumbnail' }),
    toast: value => toasts.push(value),
    render() {}, closeCount: 0,
  });
  c.closeSheet = () => { c.closeCount++; };
  load(c, 'async function patchLight(id,patch){', '/* ---------- Firebase mode');
  load(c, 'async function write(fn,okMsg){', '// Downscale a photo.');
  load(c, 'const INSPECTION_JOBS=', '/* ---------- events ---------- */');
  return { c, source, nodes, toasts };
}

test('local quota failures keep durable data, memory and subscribers unchanged', async () => {
  const backing = storage({ lights: { p1: { status: '정상' } }, inspections: {} });
  const db = localStore(backing);
  let updates = 0;
  db.collection('lights').onSnapshot(() => updates++);
  backing.fail = true;
  const attempts = [
    () => db.collection('inspections').add({ result: '고장' }),
    () => db.doc('lights/p2').set({ status: '고장' }),
    () => db.doc('lights/p1').update({ status: '고장' }),
    () => db.doc('lights/p1').delete(),
    () => db.commitMany([{ path: 'lights/p1', data: { status: '고장' }, merge: true }, { path: 'inspections/i1', data: { result: '고장' } }]),
  ];
  for (const attempt of attempts) await assert.rejects(attempt, { name: 'QuotaExceededError' });
  assert.equal(updates, 1, 'failed writes do not publish a success snapshot');
  assert.equal((await db.doc('lights/p1').get()).data().status, '정상');
  assert.equal((await db.collection('lights').get()).docs.length, 1);
  assert.equal((await db.collection('inspections').get()).docs.length, 0);
  assert.equal((await localStore(backing).doc('lights/p1').get()).data().status, '정상');
  backing.fail = false;
  await db.doc('lights/p1').update({ status: '고장' });
  assert.equal(updates, 2);
  assert.equal((await localStore(backing).doc('lights/p1').get()).data().status, '고장');
});

test('light patches preserve another client’s fields and replace a representative-photo slot map', async () => {
  for (const firebase of [false, true]) {
    const { db, records } = memoryDb({ 'lights/p1': { status: '정상', lat: 35, reps: { 전경: { id: 'a' }, 표찰: { id: 'b' } } } });
    const make = () => {
      const c = context({ db, FB: firebase ? { fs: db } : null, OV: { p1: copy(records['lights/p1']) } });
      load(c, 'async function patchLight(id,patch){', '/* ---------- Firebase mode');
      return c;
    };
    const a = make(), b = make();
    await a.patchLight('p1', { lat: 35.1 });
    await b.patchLight('p1', { status: '고장' });
    assert.equal(records['lights/p1'].lat, 35.1);
    await b.patchLight('p1', { reps: { 전경: { id: 'a' } } });
    assert.equal(records['lights/p1'].reps.표찰, undefined);
    assert.equal(records['lights/p1'].status, '고장');
    await b.patchLight('p2', { status: '점검필요' });
    assert.equal(records['lights/p2'].status, '점검필요');
  }
});

test('closing or switching light while saving cannot corrupt status or close the new draft', async () => {
  for (const switchToOther of [false, true]) {
    const { db, records, control } = memoryDb({ 'lights/p1': { status: '정상' } });
    let release;
    control.beforeWrite = key => key.startsWith('inspections/') ? new Promise(resolve => { release = resolve; }) : undefined;
    const { c, nodes } = inspectionContext(db);
    const pending = c.saveInspection();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    const other = switchToOther ? { lightId: 'p2', checks: {}, result: '정상' } : null;
    c.draft = other;
    delete nodes['#iMemo'];
    release();
    await pending;
    const recordsOfInspection = Object.entries(records).filter(([key]) => key.startsWith('inspections/'));
    assert.equal(recordsOfInspection.length, 1);
    assert.equal(recordsOfInspection[0][1].result, '고장');
    assert.equal(records['lights/p1'].status, '고장');
    assert.equal(c.draft, other);
    assert.equal(c.closeCount, 0);
    assert.equal(c.DRAFTS.p1, undefined);
  }
});

test('edits made to the same draft during save remain as an unsaved draft', async () => {
  const { db, records, control } = memoryDb({ 'lights/p1': { status: '정상' } });
  let release;
  control.beforeWrite = key => key.startsWith('inspections/') ? new Promise(resolve => { release = resolve; }) : undefined;
  const { c, source, nodes } = inspectionContext(db);
  const pending = c.saveInspection();
  await new Promise(resolve => setImmediate(resolve));
  source.result = '정상';
  nodes['#iMemo'].value = 'new note';
  release(); await pending;
  assert.equal(records['lights/p1'].status, '고장');
  assert.equal(c.draft, source);
  assert.equal(c.DRAFTS.p1, source);
  assert.equal(source.memo, 'new note');
  assert.equal(c.closeCount, 0);
  assert.equal(nodes['#saveInsp'].disabled, false);
});

test('local inspection is all-or-nothing on quota failure and keeps the draft for retry', async () => {
  const backing = storage({ lights: { p1: { status: '정상' } }, inspections: {}, photos: {} });
  const db = localStore(backing);
  const { c, source, toasts } = inspectionContext(db, { local: true });
  source.photos.push({ label: '기타', data: 'data:image/jpeg;base64,abc', thumb: 'thumb', w: 2, h: 2 });
  backing.fail = true;
  await c.saveInspection();
  assert.equal((await db.collection('photos').get()).docs.length, 0);
  assert.equal((await db.collection('inspections').get()).docs.length, 0);
  assert.equal((await db.doc('lights/p1').get()).data().status, '정상');
  assert.equal(c.draft, source);
  assert.equal(c.DRAFTS.p1, source);
  assert.match(toasts.at(-1), /저장 공간/);
  backing.fail = false;
  await c.saveInspection();
  assert.equal((await db.collection('photos').get()).docs.length, 1);
  assert.equal((await db.collection('inspections').get()).docs.length, 1);
  assert.equal((await db.doc('lights/p1').get()).data().status, '고장');
  assert.equal(c.draft, null);
});

test('Firebase inspection batches photos, history and light; a rejection leaves all unchanged', async () => {
  const { db, records, control } = memoryDb({ 'lights/p1': { status: '정상', lat: 35.1 } });
  const { c, source } = inspectionContext(db, { firebase: true });
  source.photos.push({ label: '전경', data: 'data:image/jpeg;base64,abc', thumb: 'thumb', w: 2, h: 2 });
  control.rejectBatch = true;
  await c.saveInspection();
  assert.deepEqual(Object.keys(records), ['lights/p1']);
  assert.equal(c.draft, source);
  assert.deepEqual(Object.keys(c.GAL), []);
  control.rejectBatch = false;
  await c.saveInspection();
  const inspection = Object.entries(records).find(([key]) => key.startsWith('inspections/'));
  const photo = Object.entries(records).find(([key]) => key.startsWith('photos/'));
  assert.equal(control.batches, 2);
  assert.equal(photo[1].inspId, inspection[0].split('/')[1]);
  assert.equal(records['lights/p1'].status, '고장');
  assert.equal(records['lights/p1'].lat, 35.1);
  assert.equal(c.closeCount, 1);
});

test('artifact partial failure retries frozen payloads and IDs instead of duplicating history', async () => {
  const { db, records, control } = memoryDb({ 'lights/p1': { status: '정상' } });
  const { c, source, nodes } = inspectionContext(db);
  source.photos.push({ label: '기타', data: 'data:image/jpeg;base64,abc', thumb: 'thumb', w: 2, h: 2 });
  control.failPath = 'lights/p1';
  await c.saveInspection();
  const firstHistory = Object.entries(records).find(([key]) => key.startsWith('inspections/'));
  assert.ok(firstHistory, 'artifact may have written history before the light update fails');
  firstHistory[1].reviewedBy = 'admin';
  firstHistory[1].reviewedAt = 123;
  const savedPayload = copy(firstHistory[1]);
  assert.equal(c.draft, source);
  source.result = '정상';
  nodes['#iMemo'].value = 'edited after failure';
  control.failPath = null;
  await c.saveInspection();
  assert.equal(Object.keys(records).filter(key => key.startsWith('inspections/')).length, 1);
  assert.equal(Object.keys(records).filter(key => key.startsWith('photos/')).length, 1);
  assert.deepEqual(records[firstHistory[0]], savedPayload, 'retry preserves the exact original record and timestamp');
  assert.equal(records['lights/p1'].status, '고장');
  assert.equal(c.draft, source, 'new edits remain available after finishing the pending save');
  assert.equal(source.result, '정상');
  assert.equal(source.memo, 'edited after failure');
});

test('retry after a lost Firebase acknowledgement preserves subsequent review metadata', async () => {
  const { db, records, control } = memoryDb({ 'lights/p1': { status: '정상' } });
  const { c } = inspectionContext(db, { firebase: true });
  control.loseBatchAck = true;
  await c.saveInspection();
  const entry = Object.entries(records).find(([key]) => key.startsWith('inspections/'));
  entry[1].reviewedBy = 'admin';
  entry[1].reviewedAt = 123;
  await c.saveInspection();
  assert.equal(Object.keys(records).filter(key => key.startsWith('inspections/')).length, 1);
  assert.equal(records[entry[0]].reviewedBy, 'admin');
  assert.equal(records[entry[0]].reviewedAt, 123);
});

test('report, shared summary and CSV use the same district and date selection', async () => {
  const lights = [
    { id: 'a', dong: '동A', status: '고장' },
    { id: 'b', dong: '동B', status: '고장' },
  ];
  let csv;
  const c = context({
    REP: { dong: '동A', data: { insp: [
      { lightId: 'a', dong: '동A', date: 10, result: '정상', inspector: 'one' },
      { lightId: 'b', dong: '동B', date: 10, result: '고장', inspector: 'two' },
      { lightId: 'a', dong: '동A', date: 100, result: '고장', inspector: 'one' },
    ] } },
    S: { lights, names: { one: '점검자A', two: '점검자B' }, patrols: [
      { start: 10, dong: '동A', passed: ['a'] },
      { start: 10, dong: '동B', passed: ['b'] },
      { start: 10, dong: '전체', passed: ['b'] },
    ] },
    repRange: () => ({ a: 1, b: 20 }),
    inDong: (light, dong) => dong === '전체' || light.dong === dong,
    adongOf: light => light?.dong || '', adongOrder: () => 0,
    byId: id => lights.find(light => light.id === id),
    dongLabel: value => value, fmtD: value => String(value),
    dl: { save: async file => { csv = file.data; } },
  });
  load(c, 'function reportData(){', 'function reportSection(){');
  load(c, 'function repSummaryText(){', '/* per-light dossier:');
  assert.equal(c.reportData().ins.length, 1);
  assert.equal(c.reportData().pats.length, 1);
  const summary = c.repSummaryText();
  assert.match(summary, /점검 1건/);
  assert.match(summary, /야간 순찰 1회/);
  await c.exportReportCSV();
  assert.match(csv, /"행정동","동A","1","1","1","0","0","1"/);
  assert.match(csv, /점검자A/);
  assert.doesNotMatch(csv, /동B|점검자B/);
});

test('field registration with an existing plate contains a boolean noPlate, never undefined', async () => {
  const fields = { nDong: '지산동', nKind: '보안등', nNum: '123', nAddr: '테스트 위치', nLat: '', nLng: '', nPole: '', nType: 'LED', nNote: '' };
  let saved;
  const c = context({
    $: key => key === '#nNoPlate' ? { checked: false } : { value: fields[key.slice(1)] || '' },
    S: { me: 'staff' }, window: {},
    labelText: () => '지산동 123', newIdFor: () => 'bd-testid',
    lookup: () => null, byId: () => null,
    write: async fn => { await fn(); return true; }, render() {},
    db: { doc: () => ({ set: async value => {
      assert.ok(Object.values(value).every(v => v !== undefined), 'Firebase rejects undefined document fields');
      saved = value;
    } }) },
  });
  load(c, 'async function addLight(){', '/* ---------- unregistered lights:');
  await c.addLight();
  assert.equal(saved.noPlate, false);
});

test('citizen report lightId is authoritative and a deleted ID remains unlinked', async () => {
  const light = { id: 'p2', code: '지호로 65-5', dong: '지산동' };
  let imported, available = true;
  const report = { lightId: 'p2', code: '65-5', issue: '꺼짐', at: 10 };
  const inbox = { id: 'external-1', data: () => report, ref: { update: async () => {} } };
  const c = context({
    IB: {}, S: { reports: [] }, window: { REPORT_CONFIG: { firestore: {} } },
    byId: id => available && id === light.id ? light : null,
    parseCode: () => { throw new Error('an explicit lightId must not fall back to ambiguous code matching'); },
    lightGrid: () => { throw new Error('an explicit lightId must not fall back to a nearby different light'); },
    fsApp: async () => ({ collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: [inbox] }) }) }) }) }),
    db: { collection: () => ({ add: async value => { imported = value; } }) },
    firebase: { firestore: { FieldValue: { delete: () => 'delete-field' } } },
    render() {}, toast() {},
  });
  load(c, 'async function importCitizenReports(){', 'async function addInboxReport(btn){');
  await c.importCitizenReports();
  assert.equal(imported.lightId, 'p2');
  assert.equal(imported.code, light.code);
  available = false;
  report.lat = 35.15;
  report.lng = 126.92;
  for (const code of ['65-5', '']) {
    report.code = code;
    imported = null;
    await c.importCitizenReports();
    assert.ok(imported, 'the report is still imported for manual handling');
    assert.equal(imported.lightId, null);
    assert.equal(imported.code, code);
    assert.equal(imported.dong, '');
  }
});
