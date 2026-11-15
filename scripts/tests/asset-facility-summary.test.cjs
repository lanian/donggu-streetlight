const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Core = require('../../app/asset-maintenance-core.js');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };

// Every staff member opens facilities all day. Their summary must read only that facility's link, its cabinet
// and circuit, and its replacements, never whole collections that grow toward one record per facility.
function fixture() {
  const docs = {
    'assetLinks/p': { lightId: 'p', cabinetId: 'cab', circuitId: 'cir', confirmationNote: '현장 확인' },
    'cabinets/cab': { code: 'CAB', label: '확인된 분전함', disabled: false },
    'circuits/cir': { cabinetId: 'cab', code: 'C1', label: '1회로', disabled: false }
  };
  const replacements = [{ id: 'r1', lightId: 'p', component: 'lamp', replacedAt: Date.parse('2026-10-01T00:00:00+09:00') }, { id: 'r2', lightId: 'q', component: 'ballast', replacedAt: 1 }];
  const fullReads = [], queries = [], docReads = [], control = { fail: false, handler: null };
  let body = '';
  const element = { dataset: { amLight: 'p' }, set innerHTML(value) { body = value; }, get innerHTML() { return body; } };
  const document = { querySelector: () => null, querySelectorAll: selector => selector === '[data-am-light]' ? [element] : [], addEventListener() {} };
  const offline = { ready: true, namespace: 'local', register() {}, subscribe(fn) { control.handler = fn; }, list: async () => [], get: async () => null };
  const context = vm.createContext({ document, Date, Promise, queueMicrotask, DGOffline: offline, DGAssetMaintenanceCore: Core, DGAssetMaintenanceCommands: {}, DGData: { newId: () => 'new-record' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/asset-maintenance.js'), 'utf8'), context);
  const database = { doc: docPath => ({ get: async () => { docReads.push(docPath); if (control.fail) throw new Error('연결할 수 없어요.'); const value = docs[docPath]; return { exists: !!value, data: () => value && clone(value) }; } }) };
  const lights = { p: { id: 'p', code: 'P1' }, q: { id: 'q', code: 'Q1' } };
  context.DGAssetMaintenance.attach({ esc: String, fmtDT: String, can: () => true, state: () => ({ me: 'local', lights: Object.values(lights), names: {} }), database: () => database, firebase: () => null, byId: id => lights[id] || null, render() {}, toast() {}, navGen: () => 0, navAlive: () => true, navigate() {},
    readAll: async (collection, options = {}) => {
      if (options.where) { queries.push([collection, clone(options.where)]); return clone(replacements.filter(row => options.where.every(([field, op, value]) => op === '==' && row[field] === value))); }
      fullReads.push(collection); return [];
    }
  });
  return { M: context.DGAssetMaintenance, element, fullReads, queries, docReads, docs, control };
}

test('a facility summary reads only that facility and shows its cabinet, circuit and latest replacement', async () => {
  const f = fixture();
  f.element.innerHTML = f.M.lightHTML('p'); await settle();
  assert.deepEqual(f.fullReads, [], 'no whole collection is read for one facility');
  assert.deepEqual(f.queries, [['assetReplacements', [['lightId', '==', 'p']]]]);
  assert.deepEqual([...f.docReads].sort(), ['assetLinks/p', 'cabinets/cab', 'circuits/cir']);
  assert.match(f.element.innerHTML, /CAB · 확인된 분전함 \/ C1 · 1회로/);
  assert.match(f.element.innerHTML, /최근 교체: 램프 · 2026-10-01/);
});

test('a facility opened again in the same session reuses its summary instead of reading again', async () => {
  const f = fixture();
  f.element.innerHTML = f.M.lightHTML('p'); await settle();
  const reads = f.docReads.length + f.queries.length;
  f.element.innerHTML = f.M.lightHTML('p'); await settle();
  assert.equal(f.docReads.length + f.queries.length, reads);
  assert.match(f.element.innerHTML, /CAB · 확인된 분전함/);
});

// v80: the reuse above must not pin a failed read or hide changes the app itself knows about.
test('a facility whose summary failed to load reads again the next time it is opened', async () => {
  const f = fixture(); f.control.fail = true;
  f.element.innerHTML = f.M.lightHTML('p'); await settle();
  assert.match(f.element.innerHTML, /연결할 수 없어요/);
  f.control.fail = false;
  f.element.innerHTML = f.M.lightHTML('p'); await settle();
  assert.match(f.element.innerHTML, /CAB · 확인된 분전함/);
});
test('refreshing the asset records or syncing a queued asset save drops the reused facility summaries', async () => {
  const f = fixture();
  f.element.innerHTML = f.M.lightHTML('p'); await settle();
  f.docs['cabinets/cab'].label = '바뀐 분전함';
  await f.M.load(true); await settle();
  f.element.innerHTML = f.M.lightHTML('p'); await settle();
  assert.match(f.element.innerHTML, /CAB · 바뀐 분전함/, 'after 새로고침');
  f.docs['cabinets/cab'].label = '다시 바뀐 분전함';
  f.control.handler({ type: 'synced', job: { kind: 'asset-maintenance' } }); await settle();
  f.element.innerHTML = f.M.lightHTML('p'); await settle();
  assert.match(f.element.innerHTML, /CAB · 다시 바뀐 분전함/, 'after a queued asset save is sent');
});
