const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const C = require('../../app/operations-core.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
async function fixture() {
  const stores = { A: new Map(), B: new Map() }, events = {}, fields = {}, messages = [], removes = [], submits = [];
  let actor = 'A', backend = {}, namespace = 'A';
  const controls = { put: null, get: null };
  const offline = {
    ready: true, get namespace() { return namespace; },
    register() {}, subscribe() {}, jobs: async () => [], list: async () => [],
    async get(kind, id) { const value = clone(stores[namespace].get(kind + ':' + id)); if (controls.get) await controls.get.promise; return value; },
    async putIfCurrent(kind, id, value, revision) {
      const store = stores[namespace], key = kind + ':' + id;
      if (controls.put) { const hook = controls.put; controls.put = null; hook.entered.resolve(); await hook.promise; if (hook.conflict) throw Object.assign(new Error('competing draft'), { code: 'conflict' }); }
      const old = store.get(key); if ((old?.draftRevision ?? null) !== revision) throw Object.assign(new Error('stale revision'), { code: 'conflict' });
      const saved = { ...clone(value), draftRevision: (old?.draftRevision || 0) + 1 }; store.set(key, saved); return saved;
    },
    async removeIfCurrent(kind, id, revision) { const store = stores[namespace], key = kind + ':' + id; removes.push({ namespace, key }); if (store.get(key)?.draftRevision === revision) store.delete(key); },
    async submit(kind, payload) { submits.push({ namespace, kind, payload }); return { state: 'queued' }; }
  };
  const document = { querySelector: selector => fields[selector] || null, querySelectorAll: () => [], addEventListener(name, fn) { (events[name] ||= []).push(fn); } };
  const context = vm.createContext({ console, crypto: webcrypto, Date, Math, TextEncoder, navigator: { onLine: true }, document, setTimeout, clearTimeout, DGOffline: offline, DGOperationsCore: C, DGWorkCommands: {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/operations.js'), 'utf8'), context);
  const order = { id: 'w', ...C.createOrder({ title: '원래 작업', assignedTo: 'A' }, { id: 'l', code: 'L' }, 'A', 1) };
  const api = { state: () => ({ me: actor, names: {}, roles: [], lights: [] }), can: () => true, firebase: () => backend, database: () => backend, esc: value => String(value ?? ''), fmtDT: String, render() {}, toast: value => messages.push(value), byId: () => ({ id: 'l', code: 'L' }), readAll: async () => [], readPage: async () => ({ rows: [], hasMore: false, complete: true, source: 'server', fetchedAt: 1 }),
    navigate(markup) {
      const token = /data-editor-token="([^"]+)"/.exec(markup)?.[1], fieldset = { disabled: false };
      const form = { isConnected: true, dataset: { editorToken: token }, querySelector: () => fieldset };
      fields['#woEditForm'] = form;
      for (const [id, value] of Object.entries({ woEditTitle: '수정 중인 작업', woEditDescription: '', woEditType: '수리', woEditPriority: '보통', woEditAssignee: actor, woEditDue: '' })) fields['#' + id] = { value, closest: () => form };
      fields['#woEditState'] = { textContent: '' };
    }
  };
  backend.doc = () => ({ get: async () => ({ exists: true, data: () => clone(order) }) });
  context.DGOperations.attach(api);
  return { ui: context.DGOperations, offline, stores, controls, removes, messages, submits, fields,
    switch(namespaceValue = 'B', { changeActor = true, changeBackend = true } = {}) { namespace = namespaceValue; if (changeActor) actor = 'B'; if (changeBackend) backend = {}; },
    click(action) { const button = { dataset: { dg: action }, disabled: false, isConnected: true }; for (const fn of events.click || []) fn({ target: { closest: () => button } }); },
    seed(kind = 'workEdit') { stores.A.set(kind + ':w', { workId: 'w', storageId: 'w', title: 'A draft', draftRevision: 1 }); stores.B.set(kind + ':w', { workId: 'w', storageId: 'w', title: 'B draft', draftRevision: 1 }); return clone(stores.A.get(kind + ':w')); }
  };
}

test('queued cleanup cannot remove another namespace draft with the same id and revision', async () => {
  const f = await fixture(), draft = f.seed(), gate = deferred(), entered = deferred();
  f.controls.put = { ...gate, entered };
  const writing = f.ui.writeDraft({ workId: 'other', storageId: 'other' }, 'workEdit').catch(() => {});
  await entered.promise;
  const clearing = f.ui.clearWorkDraft(draft, 'workEdit');
  f.switch(); gate.resolve(); await writing; await clearing;
  assert.equal(f.stores.B.get('workEdit:w')?.title, 'B draft');
  assert.equal(f.stores.A.has('workEdit:w'), true);
  assert.deepEqual(f.removes, []);
});

test('cleanup rechecks ownership after its asynchronous draft read', async () => {
  const f = await fixture(), draft = f.seed(), gate = deferred();
  f.controls.get = gate;
  const clearing = f.ui.clearWorkDraft(draft, 'workEdit');
  await new Promise(resolve => setImmediate(resolve));
  f.switch(); gate.resolve(); await clearing;
  assert.equal(f.stores.B.get('workEdit:w')?.title, 'B draft');
  assert.deepEqual(f.removes, []);
});

test('draft owner established at first write also protects cleanup first invoked after switching', async () => {
  const f = await fixture(), draft = f.seed(); draft.title = 'A owner';
  await f.ui.writeDraft(draft, 'workEdit');
  f.stores.B.set('workEdit:w', { title: 'B draft', draftRevision: draft.draftRevision });
  f.switch(); await f.ui.clearWorkDraft(draft, 'workEdit');
  assert.equal(f.stores.B.get('workEdit:w')?.title, 'B draft');
  assert.deepEqual(f.removes, []);
});

test('a failed old-namespace write never creates its recovery copy in the new namespace', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred();
  f.controls.put = { ...gate, entered, conflict: true };
  const writing = f.ui.writeDraft({ workId: 'w', storageId: 'w', title: 'A private draft' }, 'workEdit').catch(() => {});
  await entered.promise; f.switch(); gate.resolve(); await writing;
  assert.equal(f.stores.B.size, 0);
});

test('account or backend changes invalidate queued cleanup even if namespace text is reused', async t => {
  for (const change of [{ changeActor: true, changeBackend: false }, { changeActor: false, changeBackend: true }]) await t.test(JSON.stringify(change), async () => {
    const f = await fixture(), draft = f.seed(), gate = deferred(), entered = deferred();
    f.controls.put = { ...gate, entered };
    const writing = f.ui.writeDraft({ workId: 'other', storageId: 'other' }, 'workEdit').catch(() => {});
    await entered.promise; const clearing = f.ui.clearWorkDraft(draft, 'workEdit');
    f.switch('A', change); gate.resolve(); await writing; await clearing;
    assert.equal(f.stores.A.has('workEdit:w'), true); assert.deepEqual(f.removes, []);
  });
});

test('work edit cannot enqueue a previously owned save after draft persistence changes account', async () => {
  const f = await fixture(); await f.ui.openEdit('w');
  const gate = deferred(), entered = deferred(); f.controls.put = { ...gate, entered };
  f.click('save-work-edit'); await entered.promise;
  f.switch(); gate.resolve();
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.submits.length, 0); assert.equal(f.stores.B.size, 0);
});

test('successful recovered edit cleanup removes its unchanged source only after delivery', async () => {
  const f = await fixture(), draft = f.seed();
  draft.recoverySource = { id: 'source', revision: 2 };
  f.stores.A.set('workEdit:source', { title: '이전 사용자 입력', draftRevision: 2 });
  await f.ui.clearWorkDraft(draft, 'workEdit', { delivered: true });
  assert.equal(f.stores.A.has('workEdit:source'), false);
});

test('discarding a recovered edit preserves its source and successful delivery preserves newer source changes', async () => {
  const f = await fixture(), draft = f.seed();
  draft.recoverySource = { id: 'source', revision: 2 };
  f.stores.A.set('workEdit:source', { title: '다른 탭의 새 입력', draftRevision: 3 });
  await f.ui.clearWorkDraft(draft, 'workEdit');
  assert.equal(f.stores.A.get('workEdit:source').title, '다른 탭의 새 입력');
  const next = f.seed(); next.recoverySource = draft.recoverySource;
  await f.ui.clearWorkDraft(next, 'workEdit', { delivered: true });
  assert.equal(f.stores.A.get('workEdit:source').title, '다른 탭의 새 입력');
});

test('a delivered older job does not clean the source of a replacement draft', async () => {
  const f = await fixture(), draft = f.seed();
  draft.pending = 'older-job'; draft.recoverySource = { id: 'source', revision: 2 };
  f.stores.A.set('workEdit:w', { pending: 'newer-job', draftRevision: 2 });
  f.stores.A.set('workEdit:source', { title: '새 초안이 참조하는 이전 입력', draftRevision: 2 });
  await f.ui.clearWorkDraft(draft, 'workEdit', { delivered: true });
  assert.equal(f.stores.A.get('workEdit:w').pending, 'newer-job');
  assert.equal(f.stores.A.has('workEdit:source'), true);
});
