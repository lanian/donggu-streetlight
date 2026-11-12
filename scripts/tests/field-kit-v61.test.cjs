const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  let actor = 'local', namespace = 'local:local', online = true, failStorage = false;
  const stores = new Map(), reads = [], toasts = [], listeners = {};
  const records = {
    'workOrders/w': { lightId: 'p', title: '오늘 작업', status: 'assigned', assignedTo: 'local', beforePhotos: ['ph'], afterPhotos: [], reportIds: ['r'], revision: 1, dueAt: 0 },
    'lights/p': { status: '고장', updatedAt: 1 },
    'reports/r': { lightId: 'p', status: '접수', issue: '꺼짐', desc: '관찰 내용', contact: '010-secret', reporterId: 'private', photo: 'private-photo', createdAt: 1 },
    'inspections/i': { lightId: 'p', date: 1, result: '고장', thumbs: [{ id: 'ph', t: 'data:image/png;base64,AA==' }] },
    'photos/ph': { lightId: 'p', workId: 'w', kind: 'work', data: 'data:image/png;base64,AA==', at: 1, by: 'local' }
  };
  let gate = null;
  const db = { doc: key => ({ get: async () => { reads.push(key); if (gate?.key === key) { const g = gate; gate = null; g.entered.resolve(); await g.release.promise; } return { exists: !!records[key], data: () => clone(records[key]) }; } }) };
  const offline = { ready: true, durable: true, namespace, subscribe() {}, get: async (kind, id) => clone(stores.get(namespace + '/' + kind + '/' + id)), put: async (kind, id, value) => { if (failStorage) throw new Error('저장 공간 부족'); stores.set(namespace + '/' + kind + '/' + id, clone(value)); }, remove: async (kind, id) => stores.delete(namespace + '/' + kind + '/' + id) };
  Object.defineProperty(offline, 'namespace', { get: () => namespace });
  const context = vm.createContext({ console, Date, Math, TextEncoder, setTimeout, clearTimeout, navigator: { get onLine() { return online; } }, document: { addEventListener: (type, fn) => (listeners[type] ||= []).push(fn), querySelector: () => null }, DGOffline: offline });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/field-kit.js'), 'utf8'), context);
  const api = { state: () => ({ me: actor }), database: () => db, firebase: () => null, can: () => true, esc: String, fmtDT: String, render() {}, toast: value => toasts.push(value), navigate() {}, byId: id => id === 'p' ? { id, code: '동명 1', dong: '동명동', lat: 35, lng: 127 } : null,
    readAll: async (collection, options) => { const rows = Object.entries(records).filter(([key]) => key.startsWith(collection + '/')).map(([key, value]) => ({ id: key.split('/')[1], ...clone(value) })); options?.onMetadata?.({ source: 'local', complete: true }); return rows; } };
  const kit = context.DGFieldKit; kit.attach(api);
  return { kit, api, records, stores, reads, toasts, offline, context, listeners, account: (next, ns = 'local:' + next) => { actor = next; namespace = ns; }, setOffline: () => { online = false; }, failStorage: () => { failStorage = true; }, delay: key => { const g = { key, entered: deferred(), release: deferred() }; gate = g; return g; } };
}

test('departure preparation stores selected work, facility, reports, recent inspections and original evidence', async () => {
  const f = fixture(); await f.kit.prepare(['w']);
  const saved = await f.offline.get('fieldKit', 'current');
  assert.equal(saved.complete, true); assert.deepEqual(Array.from(saved.scope.workIds), ['w']);
  for (const [collection, id] of [['workOrders', 'w'], ['lights', 'p'], ['reports', 'r'], ['inspections', 'i'], ['photos', 'ph']]) assert.ok(saved.records[collection][id]);
  assert.equal(saved.records.reports.r.contact, undefined); assert.equal(saved.records.reports.r.reporterId, undefined); assert.equal(saved.records.reports.r.photo, undefined);
});
test('missing originals leave previous complete package intact and expose a retryable incomplete attempt', async () => {
  const f = fixture(); await f.kit.prepare(['w']); const previous = clone(await f.offline.get('fieldKit', 'current'));
  delete f.records['photos/ph']; await f.kit.prepare(['w']);
  assert.deepEqual(await f.offline.get('fieldKit', 'current'), previous); assert.equal(f.kit.state.attempt.complete, false);
  assert.ok(f.kit.state.attempt.missing.some(value => String(value).includes('ph')));
});
test('a delayed preparation cannot publish records into a different account scope', async () => {
  const f = fixture(), gate = f.delay('workOrders/w'); const pending = f.kit.prepare(['w']);
  await gate.entered.promise; f.account('other'); gate.release.resolve(); await pending;
  assert.equal(f.stores.size, 0); assert.equal(f.kit.state.packet, null);
});
test('prepared read fallback is available offline but hidden after an account change', async () => {
  const f = fixture(); await f.kit.prepare(['w']); f.setOffline();
  assert.equal((await f.kit.record('workOrders', 'w')).title, '오늘 작업'); assert.equal((await f.kit.getPhoto('ph')).workId, 'w');
  f.account('other'); assert.equal(await f.kit.record('workOrders', 'w'), null); assert.equal(await f.kit.getPhoto('ph'), null);
});
test('storage failure retains the previous complete package and never shows the attempted values as ready', async () => {
  const f = fixture(); await f.kit.prepare(['w']); const previous = clone(await f.offline.get('fieldKit', 'current'));
  f.records['workOrders/w'].title = '새 서버 내용'; f.failStorage(); await f.kit.prepare(['w']);
  assert.deepEqual(await f.offline.get('fieldKit', 'current'), previous); assert.equal((await f.kit.record('workOrders', 'w')).title, '오늘 작업');
  assert.match(f.kit.state.error, /공간/);
});
test('unsupported or oversized selection cannot produce a false ready package', async () => {
  const f = fixture(); await f.kit.prepare(Array.from({ length: 51 }, (_, i) => 'w' + i));
  assert.equal(f.stores.size, 0); assert.equal(f.kit.state.attempt.complete, false); assert.match(f.kit.state.error, /50/);
});
test('once package storage begins cancellation cannot misreport a committed package as cancelled', async () => {
  const f = fixture(); await f.kit.prepare(['w']);
  f.records['workOrders/w'].title = '새로 준비한 작업';
  const entered = deferred(), release = deferred(), put = f.offline.put;
  f.offline.put = async (...args) => { entered.resolve(); await release.promise; return put(...args); };
  const pending = f.kit.prepare(['w']); await entered.promise;
  assert.equal(f.kit.state.committing, true);
  assert.match(f.kit.view(), /자료 보관 중/);
  assert.doesNotMatch(f.kit.view(), /data-fk="cancel"/);
  assert.equal(f.kit.cancel(), false);
  assert.equal(await f.kit.loadWorks(), false, 'a parallel list refresh cannot invalidate the storage phase');
  release.resolve(); assert.equal(await pending, true);
  assert.equal((await f.offline.get('fieldKit', 'current')).records.workOrders.w.title, '새로 준비한 작업');
  assert.equal(f.kit.state.attempt.complete, true); assert.equal(f.kit.state.committing, false);
  assert.equal(f.kit.state.error, '');
});
test('prepared facility reads expose only the selected light with bounded scope and prepared time after restart', async () => {
  const f = fixture();
  f.records['assetLinks/p'] = { lightId: 'p', circuitId: 'ci', cabinetId: 'ca', confirmationNote: '현장 확인' };
  f.records['circuits/ci'] = { cabinetId: 'ca', code: 'C1', label: '골목 회로' };
  f.records['cabinets/ca'] = { code: 'B1', label: '중앙 분전함' };
  await f.kit.prepare(['w']);
  // Simulate a new module mount loading just the durable account package.
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/field-kit.js'), 'utf8'), f.context);
  const kit = f.context.DGFieldKit; kit.attach(f.api); await kit.ready(); f.setOffline();
  const result = await kit.forLight('inspections', 'p');
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].id, 'i');
  assert.equal(result.scope, 'prepared-facility'); assert.equal(result.recentInspections, 3); assert.ok(result.preparedAt > 0);
  const facility = kit.facility('p'); assert.equal(facility.reports[0].issue, '꺼짐');
  assert.equal(facility.circuit.label, '골목 회로'); assert.equal(facility.cabinet.label, '중앙 분전함');
  assert.equal(await kit.forLight('inspections', 'unselected'), null); assert.equal(await kit.forLight('workOrders', 'p'), null);
  f.account('other'); assert.equal(kit.facility('p'), null); assert.equal(await kit.forLight('reports', 'p'), null);
});
test('discard keeps prepared records when the app confirmation dialog is unavailable without a native prompt', async () => {
  const f = fixture(); await f.kit.prepare(['w']); const saved = clone(await f.offline.get('fieldKit', 'current'));
  let native = 0; f.context.confirm = () => { native++; return true; };
  for (const click of f.listeners.click || []) click({ target: { closest: () => ({ dataset: { fk: 'discard' } }) } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(native, 0); assert.deepEqual(await f.offline.get('fieldKit', 'current'), saved);
  assert.ok(f.toasts.some(value => /확인 창/.test(value)));
});
