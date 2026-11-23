/* Real integration module; controlled storage/dialog boundaries, no server or browser. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isDeepStrictEqual } = require('node:util');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const key = draft => JSON.stringify({ checks: draft.checks, checkReasons: draft.checkReasons || {}, readings: draft.readings || [], result: draft.result, memo: draft.memo || '', photos: draft.photos || [] });
const draft = (id = 'L1', memo = '확인 내용') => ({ lightId: id, checks: { lamp: 'ok', leak: 'ok' }, checkReasons: {}, readings: [{ kind: 'leakageCurrent', value: 2, unit: 'mA', at: 1000, by: 'A' }], result: '점검필요', memo, photos: [{ data: 'data:image/png;base64,AA==', label: '전경' }] });

function fixture({ stores = new Map(), startEmpty = false } = {}) {
  const state = { me: 'A', canWrite: true }, writes = [], submitted = [], removed = [], toasts = [], subscribers = [], listeners = new Map();
  const lights = new Map(['L1', 'L2'].map(id => [id, { id, code: id, dong: '동', removed: false }]));
  let database = {}, firebase = null, namespace = 'A', navigation = 1, active = startEmpty ? null : draft(), drafts = active ? { L1: active } : {}, permission = true;
  let putError = null, putGate = null, removeGate = null, submitGate = null, confirmGate = null, sequence = 0, closes = 0;
  const status = { textContent: '현재 화면 상태' }, button = { disabled: false, textContent: '점검 결과 저장' };
  const recordPut = async (ns, kind, id, value) => {
    const gate = putGate; putGate = null;
    writes.push({ namespace: ns, kind, id, value: copy(value) });
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
    if (putError) throw putError;
  };
  const matches = (current, revision, expected) => (current ? current.draftRevision || 0 : null) === revision && (expected === undefined || isDeepStrictEqual(current, copy(expected)));
  const conflict = () => Object.assign(new Error('다른 탭에서 변경했어요.'), { code: 'conflict' });
  const offline = {
    ready: true, durable: true, get namespace() { return namespace; }, async configure() {}, register() {}, subscribe(fn) { subscribers.push(fn); },
    async put(kind, id, value) {
      const ns = namespace;
      await recordPut(ns, kind, id, value);
      stores.set(ns + '|' + kind + ':' + id, copy(value));
    },
    async putIfCurrent(kind, id, value, revision, expected) {
      const ns = namespace, storageKey = ns + '|' + kind + ':' + id;
      const saved = { ...copy(value), draftRevision: (revision || 0) + 1 };
      await recordPut(ns, kind, id, saved);
      if (!matches(stores.get(storageKey) || null, revision, expected)) throw conflict();
      stores.set(storageKey, saved);
      return copy(saved);
    },
    async removeIfCurrent(kind, id, revision, expected) {
      const storageKey = namespace + '|' + kind + ':' + id, gate = removeGate; removeGate = null;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      const current = stores.get(storageKey);
      if (!current) return;
      if (!matches(current, revision, expected)) throw conflict();
      await this.remove(kind, id);
    },
    async get(kind, id) { return copy(stores.get(namespace + '|' + kind + ':' + id) || null); },
    async remove(kind, id) { removed.push({ namespace, kind, id }); stores.delete(namespace + '|' + kind + ':' + id); },
    async list(kind) {
      const prefix = namespace + '|' + kind + ':';
      return [...stores].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ id: key.slice(prefix.length), value: copy(value) }));
    },
    async jobs() { return []; }, async flush() {},
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
    checks: () => [['lamp'], ['leak']], draftDirty: value => !!value, patrol: () => ({}), inspectionDraftKey: key, suggestResult() {},
    newInspectionJob: (light, source) => ({ id: 'inspection-' + ++sequence, key: key(source), rec: { lightId: light.id, inspector: state.me, date: 1000, ...copy(source) } }),
    setDraft: value => { active = value; }, closeSheet: () => { closes++; active = null; }, render() {}, toast: value => toasts.push(value)
  };
  const context = vm.createContext({
    Promise, Date, Map, Set, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, addEventListener: (name, listener) => listeners.set(name, listener),
    document: { querySelector: selector => selector === '#dgDraftState' ? status : selector === '#saveInsp' ? button : null, addEventListener() {} },
    DGOffline: offline, DGOperations: { attach() {}, async ready() {}, async refreshQueue() {} }, DGManagement: { attach() {} },
    DGDialog: { confirm: async () => { const gate = confirmGate; if (!gate) return true; gate.entered.resolve(); return gate.release.promise; } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/integration.js'), 'utf8'), context, { filename: 'app/integration.js' });
  context.DGIntegration.attach(api);
  const gate = name => { const value = { entered: deferred(), release: deferred() }; if (name === 'put') putGate = value; else if (name === 'remove') removeGate = value; else if (name === 'submit') submitGate = value; else confirmGate = value; return value; };
  return {
    ui: context.DGIntegration, context, offline, state, stores, writes, submitted, removed, toasts, status, button, lights,
    get active() { return active; }, get closes() { return closes; }, get namespace() { return namespace; },
    holdPut: () => gate('put'), holdRemove: () => gate('remove'), holdSubmit: () => gate('submit'), holdConfirm: () => gate('confirm'),
    setActive(value) { active = value; drafts[value.lightId] = value; },
    openStored(id) { active = drafts[id]; return active; },
    closeActive() { active = null; },
    async pagehide() { listeners.get('pagehide')(); await context.DGIntegration.flushDraftWrites(); },
    failPut(error) { putError = error; },
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

test('an untouched stale inspection view does not replace the newer copy from the other tab', async () => {
  const first = fixture();
  first.active.memo = '이전 입력';
  await first.ui.persistDraft();
  const second = fixture({ stores: first.stores, startEmpty: true });
  await second.ui.ready();
  second.openStored('L1').memo = '다른 탭의 최신 입력';
  await second.ui.persistDraft();
  await first.pagehide();
  assert.equal(first.stores.get('A|draft:L1').memo, '다른 탭의 최신 입력');
  assert.equal(first.active.memo, '이전 입력');
});

test('conflicting inspection edits stay available in the current view and never replace the saved copy', async () => {
  const first = fixture(), second = fixture({ stores: first.stores });
  second.active.memo = '다른 탭의 보관 기록';
  await second.ui.persistDraft();
  first.active.memo = '아직 화면에 있는 입력';
  await assert.rejects(first.ui.persistDraft(), { code: 'conflict' });
  assert.equal(first.stores.get('A|draft:L1').memo, '다른 탭의 보관 기록');
  assert.equal(first.active.memo, '아직 화면에 있는 입력');
});

test('delivery of an older queued inspection preserves the newer draft from another tab', async () => {
  const first = fixture(), gate = first.holdSubmit(), sending = first.ui.saveInspection();
  await gate.entered.promise;
  const second = fixture({ stores: first.stores, startEmpty: true });
  await second.ui.ready();
  second.openStored('L1').memo = '전송 중 다른 탭에서 보완한 내용';
  await second.ui.persistDraft();
  gate.release.resolve();
  await sending;
  assert.equal(first.stores.get('A|draft:L1').memo, '전송 중 다른 탭에서 보완한 내용');
  assert.equal(first.stores.get('A|draft:L1').__saveJob, undefined);
});

test('an old job cannot delete identical answers in a newer draft with a different pending job', async () => {
  const h = fixture(), gate = h.holdSubmit(), sending = h.ui.saveInspection();
  await gate.entered.promise;
  const latest = copy(h.stores.get('A|draft:L1'));
  latest.draftRevision = (latest.draftRevision || 0) + 1;
  latest.__saveJob = { ...latest.__saveJob, id: 'new-job' };
  h.stores.set('A|draft:L1', latest);
  gate.release.resolve();
  await sending;
  assert.equal(h.stores.get('A|draft:L1')?.__saveJob?.id, 'new-job');
});

for (const changed of [false, true]) {
  test('delayed autosave during delivery ' + (changed ? 'keeps newer answers without the old job' : 'does not recreate delivered input'), async () => {
    const h = fixture(), submitting = h.holdSubmit(), sending = h.ui.saveInspection();
    await submitting.entered.promise;
    const removing = h.holdRemove(); submitting.release.resolve();
    await removing.entered.promise;
    if (changed) h.active.memo = '전송 뒤에 작성한 최신 메모';
    const writing = h.ui.persistDraft();
    removing.release.resolve(); await sending; await writing;
    const saved = h.stores.get('A|draft:L1');
    assert.equal(saved?.memo, changed ? '전송 뒤에 작성한 최신 메모' : undefined);
    assert.equal(saved?.__saveJob, undefined);
    assert.equal(h.closes, changed ? 0 : 1);
  });
}

test('draft snapshot comparison rejects an old revision after deletion and recreation', async () => {
  const offline = require('../../app/offline.js');
  await offline.configure({ namespace: 'local:inspection-recreation', networkRequired: false });
  const first = await offline.putIfCurrent('draft', 'L1', { memo: '이전 초안' });
  await offline.removeIfCurrent('draft', 'L1', first.draftRevision, first);
  const current = await offline.putIfCurrent('draft', 'L1', { memo: '다시 작성한 초안' });
  assert.equal(current.draftRevision, first.draftRevision);
  await assert.rejects(offline.putIfCurrent('draft', 'L1', { memo: '지연된 쓰기' }, first.draftRevision, first), { code: 'conflict' });
  await assert.rejects(offline.removeIfCurrent('draft', 'L1', first.draftRevision, first), { code: 'conflict' });
  assert.deepEqual(await offline.get('draft', 'L1'), current);
});

const staff = fs.readFileSync(path.join(__dirname, '../../app/staff-app.js'), 'utf8');
const updateItems = staff.slice(staff.indexOf('const DRAFT_KIND='), staff.indexOf('function updateItemHtml('));
const updateCheck = staff.slice(staff.indexOf('async function updateCheck('), staff.indexOf('async function updateSheet('));
async function checkUpdate(h, checkApproval = false) {
  const c = h.context;
  Object.assign(c, {
    window: c, draft: h.active, navTop: () => null, fdKind: () => null, pt: {}, $: () => null, byId: id => ({ code: id }),
    navRoute() {}, updateSheet: result => { c.blocked = result; }, dgConfirm: () => true
  });
  vm.runInContext(updateItems + updateCheck, c);
  return vm.runInContext(checkApproval ? 'updateCheck()' : 'updateItems()', c);
}

for (const previous of [false, true]) {
  test('update blocks failed durable inspection autosave with ' + (previous ? 'an older' : 'no') + ' stored copy', async () => {
    const h = fixture();
    if (previous) await h.ui.persistDraft();
    h.active.memo = '기기 저장에 실패한 최신 내용';
    h.failPut(new Error('저장 공간 부족'));
    const result = await checkUpdate(h);
    assert.ok(result.lose.some(row => row.go === 'light:L1'));
    assert.ok(!result.keep.some(row => row.list?.includes('점검 작성 · L1')));
  });
}

test('the actual update approval rejects a peer conflict and preserves both views', async () => {
  const first = fixture(), second = fixture({ stores: first.stores });
  first.active.memo = '기기에 먼저 보관한 점검';
  second.active.memo = '다른 탭에서 작성 중인 점검';
  await first.ui.persistDraft();
  assert.equal(await checkUpdate(second, true), false);
  assert.ok(second.context.blocked.lose.some(row => row.go === 'light:L1'));
  assert.equal(first.stores.get('A|draft:L1').memo, '기기에 먼저 보관한 점검');
  assert.equal(second.active.memo, '다른 탭에서 작성 중인 점검');
});

test('an offscreen inspection draft still blocks update if the last autosave failed', async () => {
  const h = fixture();
  await h.ui.persistDraft();
  h.active.memo = '화면을 이동하기 전에 입력한 최신 내용';
  h.failPut(new Error('저장 공간 부족'));
  await assert.rejects(h.ui.persistDraft(), /저장 공간 부족/);
  h.closeActive();
  assert.equal(await checkUpdate(h, true), false);
  assert.ok(h.context.blocked.lose.some(row => row.go === 'light:L1'));
});

test('a successfully preserved inspection draft appears in the update confirmation', async () => {
  const h = fixture();
  const result = await checkUpdate(h);
  assert.deepEqual([...result.lose], []);
  assert.ok(result.keep.some(row => row.list?.includes('점검 작성 · L1')));
});

test('a failed owned work autosave blocks update even if an older stored draft is readable', async () => {
  const h = fixture({ startEmpty: true });
  await h.offline.put('workDraft', 'work-1', { title: '이전 작업' });
  h.context.DGOperations.persistActive = async () => { throw new Error('다른 탭 초안 변경'); };
  const result = await checkUpdate(h);
  assert.ok(result.lose.some(row => row.go === 'close' && /다른 탭/.test(row.how)));
  assert.equal(result.keep.length, 0);
});

test('update blocks failed draft inventory reads', async () => {
  const h = fixture({ startEmpty: true });
  h.offline.list = async () => { throw new Error('저장소 조회 실패'); };
  const result = await checkUpdate(h);
  assert.ok(result.lose.some(row => row.go === 'outbox'));
  assert.equal(result.keep.length, 0);
});
