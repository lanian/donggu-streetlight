const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '../..');
const C = require(path.join(root, 'app/operations-core.js'));
const W = require(path.join(root, 'app/work-commands.js'));
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) { for (let n = 0; n < 300; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 1)); } assert.fail('Expected UI state was not reached'); }
async function fixture(shared) {
  let fields = {}, closes = 0, dbJSON = '{}', html = '';
  const events = {}, messages = [], control = { failDraft: false, photo: null };
  const document = { querySelector: s => fields[s] || null, querySelectorAll: s => s === '[data-work-report]:checked' ? (ctx.DGOperations.state.draft?.reportIds || []).map(id => ({ dataset: { workReport: id } })) : [], addEventListener: (name, fn) => (events[name] ||= []).push(fn) };
  const ctx = vm.createContext({ console, Date, Math, TextEncoder, structuredClone, crypto: webcrypto, document, navigator: { onLine: true, locks: { request: async (_, fn) => fn() } }, setTimeout, clearTimeout, confirm: () => true, DGOperationsCore: C, DGWorkCommands: W, DGSecurity: { safeImageSrc: s => s } });
  vm.runInContext(source('app/data.js'), ctx);
  const db = ctx.DGData.createLocalDB({ storage: { getItem: () => dbJSON, setItem: (_, value) => { dbJSON = value; } }, indexedDB: null });
  vm.runInContext(source('app/offline.js'), ctx);
  const offline = ctx.DGOffline, adapter = shared || offline.memoryStore();
  if (!shared) { const cas = adapter.compareAndSet; adapter.compareAndSet = (...args) => { if (control.failDraft) throw new Error('draft quota failure'); return cas(...args); }; }
  await offline.configure({ namespace: 'local/work-ui', durable: true, networkRequired: false, adapter });
  vm.runInContext(source('app/operations.js'), ctx);
  const lights = [{ id: 'a', code: 'A', dong: '동명동' }, { id: 'b', code: 'B', dong: '산수동' }];
  function close() { closes++; for (const value of Object.values(fields)) value.isConnected = false; fields = {}; }
  function mount(markup) {
    for (const value of Object.values(fields)) value.isConnected = false;
    fields = {}; html = markup;
    const create = markup.includes('id="woNewForm"'), d = create ? ctx.DGOperations.state.draft : ctx.DGOperations.state.completion;
    const id = create ? 'woNewForm' : 'woDetail', token = /data-editor-token="([^"]+)"/.exec(markup)?.[1];
    const fieldset = { disabled: !!d.pending };
    const form = { id, dataset: { editorToken: token, draftId: d.storageId }, isConnected: true, querySelector: s => s === 'fieldset' ? fieldset : fields[s] || null };
    fields['#' + id] = form; fields.fieldset = fieldset;
    const input = (name, value) => fields['#' + name] = { id: name, value: String(value ?? ''), isConnected: true, closest: s => s === '#' + id ? form : null, dataset: {} };
    if (create) {
      for (const [name, key] of Object.entries({ woTitle: 'title', woDescription: 'description', woType: 'type', woPriority: 'priority', woAssignee: 'assignedTo' })) input(name, d[key]);
      input('woDue', ''); input('woLight', d.lightId); input('woBefore', '');
      fields['#woBeforePreview'] = { innerHTML: '' }; fields['#woLightChoices'] = { innerHTML: '' };
    } else {
      if (markup.includes('id="woCompletionNote"')) input('woCompletionNote', d.note);
      fields['#woEvidence'] = { innerHTML: '' }; fields['#woEvents'] = { innerHTML: '' };
    }
    fields['#woPhotoNotice'] = { textContent: '' };
  }
  const api = { state: () => ({ me: 'local', names: {}, roles: [], lights }), can: () => true, dongOptions: () => '', firebase: () => null, database: () => db, esc: v => String(v ?? ''), fmtDT: String, render() {}, toast: m => messages.push(m), byId: id => lights.find(l => l.id === id), readAll: (name, options) => db.readAll(name, options), navigate: mount, closeSheet: close, getPhoto: async id => (await db.doc('photos/' + id).get()).data(), processPhoto: async () => { if (control.photo) await control.photo.promise; return { data: 'data:image/png;base64,AA==', w: 1, h: 1 }; } };
  ctx.DGOperations.attach(api);
  const emit = (name, target) => { for (const fn of events[name] || []) fn({ target }); };
  return { ctx, api, ui: ctx.DGOperations, offline, adapter, control, messages, db, field: id => fields[id], closed: () => closes, html: () => html,
    async open(lightId = 'a', reportId, resumeId) { await ctx.DGOperations.newWork(lightId, reportId, resumeId); return ctx.DGOperations.state.draft; },
    input(id, value) { fields[id].value = value; emit('input', fields[id]); },
    fireInput(target) { emit('input', target); },
    addPhoto() { const element = fields['#woBefore']; element.files = [{ type: 'image/png', size: 1 }]; emit('change', element); },
    click(action, extra = {}) { const button = { dataset: { dg: action, ...extra }, disabled: false, isConnected: true }; emit('click', { closest: () => button }); return button; }
  };
}

test('facility A and B work drafts survive independent autosaves and reload', async () => {
  const f = await fixture(), a = await f.open('a'); f.input('#woTitle', 'A 보수 초안'); await f.ui.persistNew();
  const b = await f.open('b'); f.input('#woTitle', 'B 보수 초안'); await f.ui.persistNew();
  assert.notEqual(a.storageId, b.storageId); assert.equal((await f.offline.list('workDraft')).length, 2);
  const reloaded = await fixture(f.adapter); await reloaded.open(null, null, a.storageId);
  assert.equal(reloaded.field('#woTitle').value, 'A 보수 초안');
  await reloaded.open(null, null, b.storageId); assert.equal(reloaded.field('#woTitle').value, 'B 보수 초안');
});

test('two tabs editing the same draft preserve a recovery copy instead of overwriting', async () => {
  const a = await fixture(), d = await a.open(); a.input('#woTitle', '처음'); await a.ui.persistNew();
  const b = await fixture(a.adapter); await b.open(null, null, d.storageId);
  a.input('#woTitle', '첫 탭 수정'); await a.ui.persistNew();
  b.input('#woTitle', '다른 탭 수정'); await b.ui.persistNew();
  const records = await a.offline.list('workDraft');
  assert.equal(records.length, 2); assert.deepEqual(Array.from(records, r => r.value.title).sort(), ['다른 탭 수정', '첫 탭 수정']);
  assert.equal(records.find(r => r.value.title === '다른 탭 수정').value.recoveryOf, d.id);
});

test('draft quota failure unlocks pending state and retries after storage recovers', async () => {
  const f = await fixture(), d = await f.open(); f.input('#woTitle', '저장 공간 복구'); await f.ui.persistNew();
  f.control.failDraft = true; f.click('create-work'); await until(() => f.messages.includes('draft quota failure'));
  assert.equal(d.pending, null); assert.equal(f.field('fieldset').disabled, false); assert.equal((await f.offline.jobs()).length, 0);
  f.control.failDraft = false; f.click('create-work'); await until(async () => (await f.db.doc('workOrders/' + d.id).get()).exists);
  await until(async () => !(await f.offline.get('workDraft', d.storageId)));
});

test('older save completion cannot close or delete a newer work editor', async () => {
  const f = await fixture(), gate = deferred(); let started = false;
  f.offline.register('work', async () => { started = true; await gate.promise; });
  const old = await f.open(); f.input('#woTitle', '먼저 전송'); f.click('create-work'); await until(() => started);
  const newer = await f.open('b'); f.input('#woTitle', '다음 작업'); await f.ui.persistNew(); const form = f.field('#woNewForm');
  gate.resolve(); await until(async () => !(await f.offline.get('workDraft', old.storageId)));
  assert.equal(f.ui.state.draft, newer); assert.equal(f.field('#woNewForm'), form); assert.equal(f.closed(), 0);
  assert.equal((await f.offline.get('workDraft', newer.storageId)).title, '다음 작업');
});

test('late photo processing stays with its captured work and blocks premature submission', async () => {
  const f = await fixture(), gate = deferred(), a = await f.open(); f.input('#woTitle', 'A 사진'); await f.ui.persistNew();
  f.control.photo = gate; f.addPhoto(); await until(() => a.photoTasks === 1);
  f.click('create-work'); await until(() => f.messages.includes('첨부 사진을 처리한 뒤 저장해 주세요.')); assert.equal((await f.offline.jobs()).length, 0);
  const b = await f.open('b'); f.input('#woTitle', 'B 사진 없음'); await f.ui.persistNew(); gate.resolve();
  await until(async () => (await f.offline.get('workDraft', a.storageId)).photos.length === 1);
  assert.equal((await f.offline.get('workDraft', b.storageId)).photos.length, 0); assert.equal(f.ui.state.draft, b);
});

test('ready clears completed payload-free jobs and releases orphan pending drafts', async () => {
  const f = await fixture();
  f.offline.register('work', async () => {}); await f.offline.submit('work', { id: 'delivered' }, { id: 'delivered' });
  assert.equal((await f.offline.jobs())[0].payload, undefined);
  await f.offline.putIfCurrent('workDraft', 'done', { id: 'done', storageId: 'done', pending: 'delivered' });
  await f.offline.putIfCurrent('workDraft', 'orphan', { id: 'orphan', storageId: 'orphan', pending: 'never-queued' });
  await f.ui.ready(); assert.equal(await f.offline.get('workDraft', 'done'), null); assert.equal((await f.offline.get('workDraft', 'orphan')).pending, null);
});

test('conditional draft removal preserves a newer revision and account-scoped values', async () => {
  const f = await fixture(), first = await f.offline.putIfCurrent('workDraft', 'cas', { memo: 'first' });
  const second = await f.offline.putIfCurrent('workDraft', 'cas', { memo: 'second' }, first.draftRevision);
  await assert.rejects(f.offline.removeIfCurrent('workDraft', 'cas', first.draftRevision), { code: 'conflict' });
  assert.equal((await f.offline.get('workDraft', 'cas')).memo, 'second');
  await f.offline.removeIfCurrent('workDraft', 'cas', second.draftRevision); assert.equal(await f.offline.get('workDraft', 'cas'), null);
});


test('client-side district filters keep paging until all matching work is accounted for', async () => {
  const f = await fixture();
  const records = Array.from({ length: 185 }, (_, i) => ({ id: 'w-' + i, status: 'assigned', title: '작업 ' + i, lightId: 'unknown-' + i, dong: i < 145 ? '동명동' : '산수동', updatedAt: 1000 - i, assignedTo: 'local', priority: '보통' }));
  await f.db.commitMany(records.map(({ id, ...data }) => ({ path: 'workOrders/' + id, data })));
  let calls = 0; f.api.readPage = async (name, options) => { calls++; return f.ctx.DGData.readPage(f.db, name, options); };
  f.ui.state.workDong = '산수동'; await f.ui.load(true);
  assert.equal(calls, 4); assert.equal(f.ui.selectedOrders().length, 40); assert.equal(f.ui.state.hasMore, false);
  assert.equal(f.ui.state.workMeta.source, 'local');
  const exported = await f.ui.fullSelectedOrders(); assert.equal(exported.rows.length, 40);
});
