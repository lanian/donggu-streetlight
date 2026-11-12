const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Core = require('../../app/asset-maintenance-core.js');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const cabinet = { id: 'cab', code: 'CAB', label: '확인된 분전함', disabled: false };
  const circuit = { id: 'cir', cabinetId: 'cab', code: 'C1', label: '새 회로', disabled: false };
  const rows = { cabinets: [cabinet], circuits: [], assetLinks: [], outageIncidents: [], assetReplacements: [] };
  let html = '', form = null, gate = null, circuitReads = 0;
  const document = { querySelector: selector => selector === '#amForm' ? form : null, querySelectorAll: () => [], addEventListener() {} };
  const offline = { ready: true, namespace: 'local', register() {}, subscribe() {}, list: async () => [], get: async () => null };
  const context = vm.createContext({ document, Date, Promise, queueMicrotask, DGOffline: offline, DGAssetMaintenanceCore: Core, DGAssetMaintenanceCommands: {}, DGData: { newId: () => 'new-record' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/asset-maintenance.js'), 'utf8'), context);
  const database = {}, light = { id: 'p', code: 'P1' };
  context.DGAssetMaintenance.attach({ esc: String, fmtDT: String, can: () => true, state: () => ({ me: 'local', lights: [light], names: {} }), database: () => database, firebase: () => null, byId: id => id === 'p' ? light : null, render() {}, toast() {}, navGen: () => 0, navAlive: () => true,
    navigate: value => { html = value; form = { dataset: { token: /id="amForm" data-token="([^"]+)"/.exec(value)?.[1] } }; },
    readAll: async collection => {
      const snapshot = clone(rows[collection] || []);
      if (collection === 'circuits') {
        circuitReads++;
        if (gate) { const pending = gate; gate = null; pending.entered.resolve(); await pending.release.promise; }
      }
      return snapshot;
    }
  });
  return { M: context.DGAssetMaintenance, commitCircuit: () => { rows.circuits = [circuit]; }, holdCircuitRead: () => { gate = { entered: deferred(), release: deferred() }; return gate; }, options: () => /<select[^>]*id="amCircuit"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] || '', reads: () => circuitReads };
}
test('opening a link editor reloads committed circuit references instead of the earlier loaded cache', async () => {
  const f = fixture(); await f.M.load(); assert.equal(f.reads(), 1);
  f.commitCircuit();
  await f.M.edit('link', 'p', { lightId: 'p', cabinetId: 'cab' });
  assert.match(f.options(), /value="cir"/, 'A committed circuit must be available when a new link editor opens');
  assert.equal(f.reads(), 2, 'One editor refresh reads the newly committed references');
});
test('an editor joining a pre-commit load waits for a fresh pass rather than publishing its old circuit snapshot', async () => {
  const f = fixture(), pending = f.holdCircuitRead();
  const loading = f.M.load(); await pending.entered.promise;
  f.commitCircuit(); const editing = f.M.edit('link', 'p', { lightId: 'p', cabinetId: 'cab' });
  await new Promise(resolve => setImmediate(resolve)); pending.release.resolve();
  await Promise.all([loading, editing]);
  assert.match(f.options(), /value="cir"/, 'The held old read must not become the editor reference list');
  assert.equal(f.reads(), 2, 'The joined stale load is followed by exactly one current read');
});
