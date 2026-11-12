const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const C = require('../../app/operations-core');
const P = require('../../app/preventive-core');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const settle = async () => { for (let n = 0; n < 10; n++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  let actor = 'local', namespace = 'one', sequence = 0, nav = 0, confirmation, getHook;
  const storage = new Map(), jobs = [], fields = {}, listeners = {}, messages = [], rendered = [];
  const key = (kind, id) => namespace + '/' + kind + '/' + id;
  const offline = { ready: true, get namespace() { return namespace; }, register() {},
    get: async (kind, id) => { const value = clone(storage.get(key(kind, id))); if (getHook) await getHook(); return value; },
    put: async (kind, id, value) => storage.set(key(kind, id), clone(value)), remove: async (kind, id) => storage.delete(key(kind, id)),
    putIfCurrent: async (kind, id, value, revision = null) => { const k = key(kind, id), old = storage.get(k); if ((old ? old.draftRevision || 0 : null) !== revision) throw Object.assign(new Error('changed'), { code: 'conflict' }); const saved = { ...clone(value), draftRevision: (revision || 0) + 1 }; storage.set(k, saved); return clone(saved); },
    removeIfCurrent: async (kind, id, revision) => { const k = key(kind, id), old = storage.get(k); if (old && (old.draftRevision || 0) !== revision) throw Object.assign(new Error('changed'), { code: 'conflict' }); storage.delete(k); return true; },
    jobs: async () => clone(jobs), discard: async id => { const i = jobs.findIndex(j => j.id === id); if (i >= 0) jobs.splice(i, 1); } };
  const database = {}, context = vm.createContext({ console, Date, Promise, setTimeout() {},
    document: { querySelector: selector => fields[selector] || null, addEventListener: (name, fn) => listeners[name] = fn },
    DGOperationsCore: C, DGPreventiveCore: P, DGOperations: { uuid: prefix => prefix + '-' + (++sequence), load: async () => {} }, DGOffline: offline,
    DGDialog: { confirm: () => new Promise(resolve => { confirmation = resolve; }) } });
  vm.runInContext(fs.readFileSync('app/preventive.js', 'utf8'), context);
  const api = { esc: value => String(value), firebase: () => null, database: () => database, state: () => ({ me: actor, names: {}, roles: [], lights: [] }), can: () => true,
    readAll: async () => [], render() {}, inDong: () => true, dongOptions: () => '', toast: m => messages.push(m), navGen: () => nav, navAlive: gen => gen === nav,
    navigate: html => { rendered.push(html); } };
  context.DGPreventive.attach(api);
  function edit(title) { const d = context.DGPreventive.state.draft; fields['#pmEditor'] = { dataset: { id: d.id, editorToken: rendered[rendered.length - 1]?.match(/data-editor-token="([^"]+)"/)?.[1] } }; fields['#pm_title'] = { value: title }; }
  return { module: context.DGPreventive, context, storage, jobs, fields, messages, rendered, edit, key, offline,
    changeOwner: () => { actor = 'other'; namespace = 'two'; }, hookGet: hook => { getHook = hook; }, confirm: value => confirmation(value), setNamespace: value => { namespace = value; } };
}
test('preventive drafts use serial revision writes and fork conflicting tab input into a resumable recovery draft', async () => {
  const f = fixture(); await f.module.resumeDraft(); f.edit('첫 계획'); await f.module.persistActive();
  const k = f.key('preventiveDraft', 'current'); assert.equal(f.storage.get(k).draftRevision, 1);
  f.edit('두 번째 입력'); const one = f.module.persistActive(); f.edit('세 번째 입력'); const two = f.module.persistActive(); await Promise.all([one, two]);
  assert.equal(f.storage.get(k).title, '세 번째 입력'); assert.equal(f.storage.get(k).draftRevision, 3);
  f.storage.set(k, { ...clone(f.storage.get(k)), title: '다른 탭', draftRevision: 4 }); f.edit('내 입력'); await f.module.persistActive();
  assert.equal(f.storage.get(k).title, '다른 탭'); const d = f.module.state.draft;
  assert.notEqual(d.storageId, 'current'); assert.equal(f.storage.get(f.key('preventiveDraft', d.storageId)).title, '내 입력');
  const id = d.storageId; f.module.state.draft = null; await f.module.resumeDraft(id); assert.equal(f.module.state.draft.title, '내 입력');
});
test('preventive drafts remain bound to the original actor and namespace', async () => {
  const f = fixture(); await f.module.resumeDraft(); f.edit('보관된 입력'); await f.module.persistActive(); const before = f.rendered.length;
  f.changeOwner(); assert.equal(f.module.hasActiveDraft(), false); await f.module.persistActive(); assert.equal(f.storage.has(f.key('preventiveDraft', 'current')), false);
  f.setNamespace('one'); let release; f.hookGet(() => new Promise(resolve => { release = resolve; }));
  const reading = f.module.resumeDraft(); await settle(); f.changeOwner(); release(); await reading; assert.equal(f.rendered.length, before);
});
test('discard confirmation cannot delete a changed draft or a command retried while the dialog was open', async () => {
  const f = fixture(); await f.module.resumeDraft(); f.edit('초안'); await f.module.persistActive();
  const k = f.key('preventiveDraft', 'current'), pending = f.module.discardDraft(); await settle();
  f.storage.set(k, { ...clone(f.storage.get(k)), title: '다른 탭의 수정', draftRevision: 2 }); f.confirm(true);
  assert.equal(await pending, false); assert.equal(f.storage.get(k).title, '다른 탭의 수정');
  await f.module.resumeDraft(); const d = f.module.state.draft; d.pending = 'job'; f.jobs.push({ id: 'job', state: 'failed' }); await f.module.persistActive();
  const retry = f.module.discardDraft(); await settle(); f.jobs[0].state = 'sending'; f.confirm(true);
  assert.equal(await retry, false); assert.equal(f.jobs[0].state, 'sending'); assert.ok(f.storage.get(k));
});
test('outbox discards only the selected preventive recovery draft', async () => {
  const f = fixture(); await f.module.resumeDraft(); f.edit('원본'); await f.module.persistActive();
  const k = f.key('preventiveDraft', 'recovery'); f.storage.set(k, { ...clone(f.module.state.draft), storageId: 'recovery', title: '복구', draftRevision: 1 });
  assert.equal(await f.module.discardDraft('recovery', { confirmed: true }), true);
  assert.equal(f.storage.has(k), false); assert.equal(f.storage.get(f.key('preventiveDraft', 'current')).title, '원본');
});
