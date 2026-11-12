/* Real integration module; controlled storage/dialog boundaries, no server or browser. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const key = draft => JSON.stringify({ checks: draft.checks, checkReasons: draft.checkReasons || {}, readings: draft.readings || [], result: draft.result, memo: draft.memo || '', photos: draft.photos || [] });
const draft = (id = 'L1', memo = '확인 내용') => ({ lightId: id, checks: { lamp: 'ok', leak: 'ok' }, checkReasons: {}, readings: [{ kind: 'leakageCurrent', value: 2, unit: 'mA', at: 1000, by: 'A' }], result: '점검필요', memo, photos: [{ data: 'data:image/png;base64,AA==', label: '전경' }] });

function fixture() {
  const state = { me: 'A', canWrite: true }, stores = new Map(), writes = [], submitted = [], removed = [], toasts = [], subscribers = [];
  const lights = new Map(['L1', 'L2'].map(id => [id, { id, code: id, dong: '동', removed: false }]));
  let database = {}, firebase = null, namespace = 'A', navigation = 1, active = draft(), drafts = { L1: active }, permission = true;
  let putGate = null, submitGate = null, confirmGate = null, sequence = 0, closes = 0;
  const status = { textContent: '현재 화면 상태' }, button = { disabled: false, textContent: '점검 결과 저장' };
  const offline = {
    ready: true, durable: true, get namespace() { return namespace; }, register() {}, subscribe(fn) { subscribers.push(fn); },
    async put(kind, id, value) {
      const ns = namespace, valueCopy = copy(value), gate = putGate; putGate = null;
      writes.push({ namespace: ns, kind, id, value: valueCopy });
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      stores.set(ns + '|' + kind + ':' + id, valueCopy);
    },
    async get(kind, id) { return copy(stores.get(namespace + '|' + kind + ':' + id) || null); },
    async remove(kind, id) { removed.push({ namespace, kind, id }); stores.delete(namespace + '|' + kind + ':' + id); },
    async list() { return []; }, async jobs() { return []; }, async flush() {},
    async submit(kind, payload, options) {
      submitted.push({ namespace, kind, payload: copy(payload), options: copy(options) });
      const gate = submitGate; submitGate = null;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      return { state: 'synced' };
    }
  };
  const api = {
    state: () => state, database: () => database, firebase: () => firebase, activeDraft: () => active, drafts: () => drafts,
    byId: id => lights.get(id), can: () => permission, navGen: () => navigation, navAlive: gen => navigation === gen,
    checks: () => [['lamp'], ['leak']], draftDirty: value => !!value, inspectionDraftKey: key, suggestResult() {},
    newInspectionJob: (light, source) => ({ id: 'inspection-' + ++sequence, key: key(source), rec: { lightId: light.id, inspector: state.me, date: 1000, ...copy(source) } }),
    setDraft: value => { active = value; }, closeSheet: () => { closes++; active = null; }, render() {}, toast: value => toasts.push(value)
  };
  const context = vm.createContext({
    Promise, Date, Map, Set, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, addEventListener() {},
    document: { querySelector: selector => selector === '#dgDraftState' ? status : selector === '#saveInsp' ? button : null, addEventListener() {} },
    DGOffline: offline, DGOperations: { attach() {}, async refreshQueue() {} }, DGManagement: { attach() {} },
    DGDialog: { confirm: async () => { const gate = confirmGate; if (!gate) return true; gate.entered.resolve(); return gate.release.promise; } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/integration.js'), 'utf8'), context, { filename: 'app/integration.js' });
  context.DGIntegration.attach(api);
  const gate = name => { const value = { entered: deferred(), release: deferred() }; if (name === 'put') putGate = value; else if (name === 'submit') submitGate = value; else confirmGate = value; return value; };
  return {
    ui: context.DGIntegration, state, stores, writes, submitted, removed, toasts, status, button, lights,
    get active() { return active; }, get closes() { return closes; }, get namespace() { return namespace; },
    holdPut: () => gate('put'), holdSubmit: () => gate('submit'), holdConfirm: () => gate('confirm'),
    setActive(value) { active = value; drafts[value.lightId] = value; },
    change(kind) { if (kind === 'actor') state.me = 'B'; if (kind === 'database') database = {}; if (kind === 'namespace') namespace = 'B'; if (kind === 'firebase') firebase = {}; if (kind === 'navigation') navigation++; if (kind === 'permission') permission = false; },
    emit: event => subscribers.forEach(fn => fn(event))
  };
}

for (const change of ['actor', 'database', 'namespace']) {
  test('queued inspection autosave does not write after ' + change + ' changes', async () => {
    const h = fixture(), gate = h.holdPut(), first = h.ui.persistDraft();
    await gate.entered.promise;
    h.active.memo = '대기 중인 이전 계정의 새 입력';
    const second = h.ui.persistDraft();
    h.change(change); h.status.textContent = '바뀐 문맥의 상태'; gate.release.resolve();
    await first; await second;
    assert.equal(h.writes.length, 1, 'A queued old-context write must stop before acquiring current storage');
    assert.equal(h.status.textContent, '바뀐 문맥의 상태', 'A completed old write must not publish into the new screen');
    assert.equal(h.stores.has('B|draft:L1'), false);
  });
}

for (const change of ['actor', 'database', 'namespace', 'source', 'facility', 'navigation', 'permission']) {
  test('unanswered-check confirmation cannot enqueue an obsolete inspection after ' + change + ' changes', async () => {
    const h = fixture(), source = h.active; delete source.checks.leak;
    const gate = h.holdConfirm(), saving = h.ui.saveInspection(); await gate.entered.promise;
    let replacement;
    if (change === 'source') { replacement = draft('L2', '새 시설의 입력'); h.setActive(replacement); }
    else if (change === 'facility') h.lights.delete('L1');
    else h.change(change);
    gate.release.resolve(true); await saving;
    assert.equal(h.submitted.length, 0, 'No old source may be enqueued using a changed form/session');
    assert.equal(source.checks.leak, undefined, 'An obsolete confirmation must not rewrite old answers');
    assert.equal(h.closes, 0);
    if (replacement) assert.equal(h.active, replacement);
  });
}

test('an account change during draft persistence stops the pending inspection before enqueue', async () => {
  const h = fixture(), gate = h.holdPut(), saving = h.ui.saveInspection(); await gate.entered.promise;
  h.change('actor'); h.change('namespace'); h.change('database'); const replacement = draft('L2', '새 계정의 입력'); h.setActive(replacement);
  gate.release.resolve(); await saving;
  assert.equal(h.submitted.length, 0); assert.equal(h.active, replacement); assert.equal(h.closes, 0);
});

test('a delivered old-account inspection cannot remove or close an identical new-account draft', async () => {
  const h = fixture(), source = copy(h.active), gate = h.holdSubmit(), saving = h.ui.saveInspection(); await gate.entered.promise;
  h.change('actor'); h.change('namespace'); h.change('database'); const replacement = copy(source); h.setActive(replacement);
  h.stores.set('B|draft:L1', copy(replacement)); gate.release.resolve(); await saving;
  assert.equal(h.active, replacement); assert.equal(h.closes, 0); assert.deepEqual(h.stores.get('B|draft:L1'), replacement);
  assert.equal(h.removed.some(row => row.namespace === 'B'), false);
});

test('same-session saves keep typed reasons, readings, photos and newer in-flight edits', async () => {
  const h = fixture(), source = h.active, before = copy(source), gate = h.holdSubmit(), saving = h.ui.saveInspection(); await gate.entered.promise;
  source.photos.push({ data: 'data:image/png;base64,AQ==', label: '추가 사진' }); gate.release.resolve(); await saving;
  assert.equal(h.submitted.length, 1); assert.deepEqual(h.submitted[0].payload.rec.photos, before.photos);
  assert.deepEqual(h.submitted[0].payload.rec.readings, before.readings); assert.deepEqual(h.submitted[0].payload.rec.checkReasons, before.checkReasons);
  assert.equal(h.active, source); assert.equal(h.active.photos.length, 2); assert.equal(h.closes, 0);
  assert.equal(h.stores.get('A|draft:L1').photos.length, 2);
});

test('same-session missing answers retain explicit uninspected semantics and a cancelled dialog has no write', async () => {
  for (const answer of [true, false]) {
    const h = fixture(), source = h.active; delete source.checks.leak;
    const gate = h.holdConfirm(), saving = h.ui.saveInspection(); await gate.entered.promise; gate.release.resolve(answer); await saving;
    assert.equal(h.submitted.length, answer ? 1 : 0);
    if (answer) { assert.equal(h.submitted[0].payload.rec.checks.leak, 'uninspected'); assert.equal(h.submitted[0].payload.rec.inspector, 'A'); }
    else { assert.equal(source.checks.leak, undefined); assert.equal(h.writes.length, 0); }
  }
});
