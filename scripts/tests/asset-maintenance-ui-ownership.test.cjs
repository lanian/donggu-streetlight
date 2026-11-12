const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Core = require('../../app/asset-maintenance-core.js');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
function fixture() {
  let actor = 'A', namespace = 'A', db = {}, fb = {}, count = 0, nav = 0;
  const stores = { A: new Map(), B: new Map() }, listeners = {}, controls = {}, fields = {}, messages = [], navigations = [];
  const currentStore = () => stores[namespace], key = (kind, id) => kind + '/' + id;
  const offline = { ready: true, get namespace() { return namespace; }, register() {}, subscribe() {},
    list: async kind => [...currentStore()].filter(([k]) => k.startsWith(kind + '/')).map(([k, value]) => ({ kind, id: k.slice(kind.length + 1), value: clone(value) })),
    get: async (kind, id) => { const value = clone(currentStore().get(key(kind, id))); if (controls.get) { controls.get.entered.resolve(); await controls.get.gate.promise; } return value; },
    putIfCurrent: async (kind, id, value, expected) => { const store = currentStore(), old = store.get(key(kind, id)); if (old ? old.draftRevision !== expected : expected !== null) throw Object.assign(new Error('초안 충돌'), { code: 'conflict' }); const saved = { ...clone(value), draftRevision: (expected || 0) + 1 }; store.set(key(kind, id), saved); return clone(saved); },
    removeIfCurrent: async (kind, id, revision) => { const old = currentStore().get(key(kind, id)); if (old && old.draftRevision !== revision) throw Object.assign(new Error('초안 충돌'), { code: 'conflict' }); currentStore().delete(key(kind, id)); },
    jobs: async () => [], discard: async () => {}, submit: async () => { controls.submit.entered.resolve(); await controls.submit.gate.promise; return { state: 'synced' }; }
  };
  const document = { querySelector: selector => fields[selector] || null, querySelectorAll: () => [], addEventListener: (type, fn) => { listeners[type] = fn; } };
  const context = vm.createContext({ console, Date, Promise, queueMicrotask, setTimeout, clearTimeout, document, DGAssetMaintenanceCore: Core, DGAssetMaintenanceCommands: {}, DGData: { newId: prefix => prefix + '-' + (++count) }, DGOffline: offline, DGOperationsCore: { STATES: {} }, DGDialog: { confirm: async () => true } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/asset-maintenance.js'), 'utf8'), context);
  const api = { esc: String, fmtDT: String, can: () => true, state: () => ({ me: actor, names: {}, lights: [{ id: 'p1', code: 'P1' }] }), database: () => db, firebase: () => fb, byId: id => id === 'p1' ? { id, code: 'P1' } : null, render() {}, toast: m => messages.push(m), navGen: () => nav, navAlive: token => token === nav,
    navigate: (html, route) => {
      navigations.push({ html, route });
      for (const name of Object.keys(fields)) delete fields[name];
      const token = /id="amForm" data-token="([^"]+)"/.exec(html)?.[1];
      if (token) fields['#amForm'] = { dataset: { token }, querySelector: () => ({ disabled: false }) };
      for (const m of html.matchAll(/<input\b[^>]*id="([^"]+)"[^>]*value="([^"]*)"/g)) fields['#' + m[1]] = { value: m[2] };
      for (const m of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) { const options=[...m[2].matchAll(/<option value="([^"]*)"([^>]*)>/g)]; fields['#'+m[1]]={value:(options.find(o=>/selected/.test(o[2]))||options[0])?.[1]||'',innerHTML:m[2]}; }
      for (const m of html.matchAll(/<textarea\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields['#'+m[1]]={value:m[2]};
      fields['#amDisabled'] = { checked: false };
    },
    readAll: async collection => { if (collection === 'cabinets' && controls.load) { controls.load.entered.resolve(); await controls.load.gate.promise; } if(collection==='workOrders'&&controls.references){controls.references.entered.resolve();await controls.references.gate.promise;return[{id:'linked-work',lightId:'p1',title:'연결된 작업'}];} return []; }
  };
  context.DGAssetMaintenance.attach(api);
  const input = () => listeners.input({ target: { id: 'amLabel', closest: () => fields['#amForm'] } });
  const values = () => { fields['#amCode'].value = 'CAB'; fields['#amLabel'].value = '내가 수정한 분전함'; };
  const change = value => { actor = value; namespace = value; db = {}; fb = {}; nav++; };
  return { M: context.DGAssetMaintenance, context, api, offline, stores, fields, controls, listeners, messages, navigations, input, values, change, externalNavigate: () => { nav++; delete fields['#amForm']; navigations.push({ html: '다른 화면' }); } };
}

test('a restored replacement keeps its selected work while delayed reference options load',async()=>{
  const f=fixture(),gate=f.controls.references={entered:defer(),gate:defer()};
  const saved={actor:'A',entity:'replacement',recordId:'replacement-new',storageId:'replacement-replacement-new',expectedRevision:0,data:{lightId:'p1',component:'lamp',replacedAt:Date.now()-86400000,manufacturer:'m',model:'x',warrantyEnd:0,workId:'linked-work',note:'kept'},baseline:'{}',pending:''};
  await f.M.edit('replacement','replacement-new',{lightId:'p1'},saved);await gate.entered.promise;
  await f.M.persistActive();assert.equal(f.M.state.draft.data.workId,'linked-work');
  gate.gate.resolve();await settle();assert.equal(f.M.state.draft.data.workId,'linked-work');
});

test('queued topology draft writes cannot land in a newly selected account namespace', async () => {
  const f = fixture(); await f.M.edit('cabinet'); f.values(); f.input(); f.change('B'); await settle();
  assert.equal(f.stores.B.size, 0); assert.equal(f.stores.A.size, 0);
});

test('a late topology load does not publish rows or reopen after account change', async () => {
  const f = fixture(), gate = f.controls.load = { entered: defer(), gate: defer() };
  const pending = f.M.open(); await gate.entered.promise; f.change('B'); gate.gate.resolve(); await pending;
  assert.equal(f.M.state.loaded, false); assert.equal(f.navigations.length, 0);
});

test('late save completion preserves another account draft and leaves its new screen alone', async () => {
  const f = fixture(); await f.M.edit('cabinet'); f.values(); await f.M.persistActive();
  const storageId = f.M.state.draft.storageId; f.stores.B.set('assetDraft/' + storageId, { actor: 'B', draftRevision: 1, label: 'B 초안' });
  const gate = f.controls.submit = { entered: defer(), gate: defer() };
  f.listeners.click({ target: { closest: () => ({ dataset: { am: 'save' }, disabled: false }) } });
  await gate.entered.promise; f.change('B'); f.externalNavigate(); const before = f.navigations.length; gate.gate.resolve(); await settle();
  assert.equal(f.stores.B.get('assetDraft/' + storageId).label, 'B 초안'); assert.equal(f.navigations.length, before);
  assert.ok(f.stores.A.has('assetDraft/' + storageId));
});

test('a conflicting tab keeps its draft while current topology inputs become a recovery copy', async () => {
  const f = fixture(); await f.M.edit('cabinet'); f.values(); await f.M.persistActive();
  const id = f.M.state.draft.storageId, old = f.stores.A.get('assetDraft/' + id);
  f.stores.A.set('assetDraft/' + id, { ...old, draftRevision: old.draftRevision + 1, data: { ...old.data, label: '다른 탭 내용' } });
  f.fields['#amLabel'].value = '현재 탭 내용'; await f.M.persistActive();
  assert.equal(f.stores.A.get('assetDraft/' + id).data.label, '다른 탭 내용');
  assert.notEqual(f.M.state.draft.storageId, id); assert.equal(f.stores.A.get('assetDraft/' + f.M.state.draft.storageId).data.label, '현재 탭 내용');
});

test('discard delayed on draft read cannot remove a matching draft in another account', async () => {
  const f = fixture(); await f.M.edit('cabinet'); f.values(); await f.M.persistActive();
  const id = f.M.state.draft.storageId; f.stores.B.set('assetDraft/' + id, { actor: 'B', draftRevision: 1 });
  f.M.state.draft = null; const gate = f.controls.get = { entered: defer(), gate: defer() };
  const pending = f.M.discardDraft(id, { confirmed: true }); await gate.entered.promise; f.change('B'); gate.gate.resolve();
  await assert.rejects(pending, { code: 'account-changed' }); assert.ok(f.stores.B.has('assetDraft/' + id));
});
