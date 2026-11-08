const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../../app/operations-core.js');
const root = path.resolve(__dirname, '../..');
const adapterPath = path.join(root, 'app/roadlighting-registry.js');
const R = fs.existsSync(adapterPath) ? require(adapterPath) : null;
const p1 = { id: 'p101', lampId: '101', label: '동명동 12', code: '동명동 12', kind: '보안등', dong: '동명동', num: '12', lat: 35.15, lng: 126.92, addr: '보존할 주소', mgmt: '동구', posApprox: true };
const p2 = { id: 'p102', lampId: '102', code: '동명동 13', lat: 35.16, lng: 126.93 };
const publicLight = { id: 'public-A', code: '도로 20', lat: 35.17, lng: 126.94, addr: '공개대장 주소' };
const nativeRow = { lamp_id: '101', label_no: '동명동 12', latitude: '35.15001', longitude: '126.92', facility_class: '보안등', lampName: 'LED' };

test('partial registry rows preserve unprovided fields and prior registry baseline values', () => {
  const rows = C.normalizeRegistry([{ id: p1.id, code: p1.code, lat: 35.15001, lng: p1.lng }]);
  const overrides = { p101: { note: '현장 메모', registryValues: { ...p1, sw: '이전 수신 점멸기' } } };
  const frozen = JSON.stringify({ p1, rows, overrides });
  const diff = C.registryDiff([p1], rows, overrides);
  assert.deepEqual(Object.keys(diff.changed[0].changes), ['lat']);
  assert.equal(diff.changed[0].registryValues.addr, p1.addr);
  assert.equal(diff.changed[0].registryValues.posApprox, true);
  assert.equal(diff.changed[0].registryValues.sw, '이전 수신 점멸기');
  assert.equal(JSON.stringify({ p1, rows, overrides }), frozen);
});

test('an explicit null clears a field while an absent field remains unowned by that import', () => {
  const rows = C.normalizeRegistry([{ id: p1.id, code: p1.code, lat: p1.lat, lng: p1.lng, addr: null, posApprox: null }]);
  assert.equal(Object.hasOwn(rows[0], 'addr'), true);
  assert.equal(rows[0].addr, null);
  assert.equal(Object.hasOwn(rows[0], 'mgmt'), false);
  const diff = C.registryDiff([p1], rows, {});
  assert.deepEqual(diff.changed[0].changes, { addr: null, posApprox: null });
  assert.equal(diff.changed[0].registryValues.mgmt, '동구');
});

test('native getPoint and array conversion keep exact stable lamp IDs and only provided attributes', () => {
  assert.ok(R, 'The browser native registry adapter must exist.');
  assert.equal(R.isNative({ DATA: [nativeRow] }), true);
  assert.equal(R.isNative([nativeRow]), true);
  const a = R.normalize({ DATA: [nativeRow] });
  const b = R.normalize([nativeRow]);
  assert.deepEqual(a, b); assert.equal(a[0].id, 'p101'); assert.equal(a[0].lampId, '101');
  assert.equal(a[0].code, '동명동 12'); assert.equal(a[0].lampType, 'LED');
  assert.equal(Object.hasOwn(a[0], 'addr'), false);
  assert.equal(Object.hasOwn(a[0], 'posApprox'), false);
  assert.equal(Object.hasOwn(a[0], 'sw'), false);
});

test('roadlighting comparison excludes the other provider and never permits missing removal', () => {
  assert.ok(R, 'The browser native registry adapter must exist.');
  const impostor = { id: 'unrelated', lampId: '888', code: '표시용 번호', lat: 35, lng: 126 };
  const rows = C.normalizeRegistry(R.normalize({ DATA: [nativeRow] }));
  const diff = R.scopedDiff([p1, p2, publicLight, impostor], rows, {}, C);
  assert.equal(diff.scope, 'roadlighting-gjd'); assert.equal(diff.allowRemoveMissing, false);
  assert.equal(diff.retainedOtherCount, 2); assert.deepEqual(diff.missing.map(x => x.id), ['p102']);
  assert.deepEqual(Object.keys(diff.changed[0].changes).sort(), ['lampType', 'lat']);
  assert.equal(diff.changed[0].registryValues.addr, p1.addr);
});

test('native adapter rejects invalid IDs, malformed coordinates, mixed and incomplete payloads without truncation', () => {
  assert.ok(R, 'The browser native registry adapter must exist.');
  for (const value of [
    { DATA: [] }, { DATA: [nativeRow, nativeRow] },
    { DATA: [{ ...nativeRow, lamp_id: '../101' }] }, { DATA: [{ ...nativeRow, lamp_id: '101\u0000' }] },
    { DATA: [{ ...nativeRow, latitude: '' }] }, { DATA: [{ ...nativeRow, longitude: 'Infinity' }] },
    { DATA: [{ ...nativeRow, label_no: '' }] }, { DATA: [nativeRow], hasMore: true },
    { DATA: [nativeRow], truncated: true }, { DATA: [nativeRow], totalCount: 2 },
    [nativeRow, { id: 'other', code: 'X', lat: 35, lng: 126 }]
  ]) assert.throws(() => R.normalize(value));
});

test('a native identity colliding with an unrelated existing facility cannot be treated as a new row', () => {
  assert.ok(R, 'The browser native registry adapter must exist.');
  const incoming = C.normalizeRegistry(R.normalize({ DATA: [nativeRow] }));
  assert.throws(() => R.scopedDiff([{ ...publicLight, id: 'p101' }], incoming, {}, C), /ID|식별/);
  assert.throws(() => R.scopedDiff([{ ...p1, lampId: 'DIFFERENT' }], incoming, {}, C), /ID|식별/);
});

test('native scalar fields reject objects, arrays, booleans and unsafe numeric IDs instead of coercing them', () => {
  assert.ok(R);
  for (const value of [{}, [], true, Number.MAX_SAFE_INTEGER + 1, Infinity]) assert.throws(() => R.normalize({ DATA: [{ ...nativeRow, lamp_id: value }] }));
  for (const value of [{}, [], false, Infinity]) assert.throws(() => R.normalize({ DATA: [{ ...nativeRow, label_no: value }] }));
  for (const field of ['facility_class', 'lampName', 'poleName', 'jumName', 'addr', 'jibun', 'mgmt']) {
    for (const value of [{}, [], false]) assert.throws(() => R.normalize({ DATA: [{ ...nativeRow, [field]: value }] }));
  }
  for (const value of [{}, [], false, '0x23']) assert.throws(() => R.normalize({ DATA: [{ ...nativeRow, latitude: value }] }));
  for (const value of ['0', '1', {}, [], 2]) assert.throws(() => R.normalize({ DATA: [{ ...nativeRow, posApprox: value }] }));
  for (const [input, expected] of [[false, false], [true, true], [0, false], [1, true], [null, null]]) assert.equal(R.normalize({ DATA: [{ ...nativeRow, posApprox: input }] })[0].posApprox, expected);
  assert.equal(R.normalize({ DATA: [{ ...nativeRow, lamp_id: 101 }] })[0].lampId, '101');
  assert.throws(() => R.normalize({ DATA: [nativeRow], metadata: { complete: false } }));
  assert.throws(() => R.normalize({ DATA: [nativeRow], metadata: { has_more: true } }));
});

test('a new native facility needs a class while an existing facility may omit it without clearing the prior class', () => {
  assert.ok(R);
  for (const kind of [undefined, null, '']) {
    const row = { ...nativeRow, lamp_id: '999', ...(kind === undefined ? {} : { facility_class: kind }) }; if (kind === undefined) delete row.facility_class;
    const incoming = C.normalizeRegistry(R.normalize({ DATA: [row] }));
    assert.throws(() => R.scopedDiff([p1], incoming, {}, C), /종류/);
  }
  const partial = { ...nativeRow }; delete partial.facility_class;
  const diff = R.scopedDiff([p1], C.normalizeRegistry(R.normalize({ DATA: [partial] })), {}, C);
  assert.equal(Object.hasOwn(diff.changed[0].changes, 'kind'), false);
  assert.equal(diff.changed[0].registryValues.kind, p1.kind);
});

function management() {
  let actor = 'local', database = { mode: 'local' }, generation = 1, admin = true, confirm = async () => true;
  const jobs = [], executors = {}, fields = { '#dgKeepOverrides': { checked: true }, '#dgRemoveMissing': { checked: true }, '#dgRegistryFile': { value: 'selected' } };
  const listeners = {};
  const context = vm.createContext({ console, Date, Promise, Set, Map, navigator: { onLine: true }, setTimeout,
    document: { querySelector: key => fields[key] || null, addEventListener: (event, listener) => listeners[event] = listener },
    DGOperationsCore: C, DGRoadlightingRegistry: R, DGDialog: { confirm: (...args) => confirm(...args) },
    DGOperations: { uuid: () => 'registry-job', download() {} },
    DGRegistryCommands: { execute: async (job, context) => { context.progress(1, 9); return {}; } },
    DGOffline: { namespace: 'test-scope', register: (kind, executor) => { executors[kind] = executor; }, submit: async (kind, job) => { jobs.push(job); return { state: 'synced' }; } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'app/management.js'), 'utf8'), context);
  const api = { esc: value => String(value ?? ''), fmtDT: String, can: () => admin,
    state: () => ({ me: actor, lights: [p1, p2, publicLight], allLights: [p1, p2, publicLight] }),
    database: () => database, firebase: () => null, navGen: () => generation, navAlive: g => g === generation,
    registry: () => [p1, p2, publicLight], overrides: () => ({}), render() {}, toast() {} };
  context.DGManagement.attach(api);
  const clickApply = async () => { const button = { dataset: { mgmt: 'registry-apply' }, disabled: false }; listeners.click({ target: { closest: () => button } }); await new Promise(resolve => setImmediate(resolve)); };
  return { manager: context.DGManagement, jobs, executors, clickApply, switchDB: () => { database = { mode: 'local' }; }, navigate: () => generation++, revoke: () => { admin = false; }, switchActor: () => { actor = 'other'; }, confirm: fn => { confirm = fn; } };
}

test('browser registry importer accepts raw getPoint and refuses a manipulated remove-missing checkbox', async () => {
  const f = management(); assert.equal(typeof f.manager.registryFile, 'function');
  await f.manager.registryFile({ size: 300, name: 'getPoint.json', text: async () => JSON.stringify({ DATA: [nativeRow] }) });
  assert.equal(f.manager.state.registry.scope, 'roadlighting-gjd');
  assert.match(f.manager.registryView(), /다른 출처.*1개/);
  assert.match(f.manager.registryView(), /dgRemoveMissing[^>]*disabled/);
  await f.clickApply();
  assert.equal(f.jobs.length, 1); assert.equal(f.jobs[0].markMissingRemoved, false);
  assert.equal(f.jobs[0].entries.some(row => row.id === 'p102' || row.id === 'public-A'), false);
});

test('a delayed file read cannot publish after navigation, account, DB or role changes', async () => {
  for (const change of ['navigate', 'switchDB', 'switchActor', 'revoke']) {
    const f = management(); assert.equal(typeof f.manager.registryFile, 'function');
    let finish; const pending = f.manager.registryFile({ size: 300, name: 'delayed.json', text: () => new Promise(resolve => { finish = resolve; }) });
    f[change](); finish(JSON.stringify({ DATA: [nativeRow] })); await pending;
    assert.equal(f.manager.state.registry, null, change);
  }
});

test('confirmation cannot submit an old comparison after changing database or replacing the preview', async () => {
  const f = management(); assert.equal(typeof f.manager.registryFile, 'function');
  await f.manager.registryFile({ size: 300, name: 'native.json', text: async () => JSON.stringify({ DATA: [nativeRow] }) });
  let finish; f.confirm(() => new Promise(resolve => { finish = resolve; }));
  await f.clickApply(); assert.equal(typeof finish, 'function');
  f.switchDB(); finish(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.jobs.length, 0);
});

test('an old queued registry job cannot replace the current comparison progress', async () => {
  const f = management();
  await f.manager.registryFile({ size: 300, name: 'current.json', text: async () => JSON.stringify({ DATA: [nativeRow] }) });
  await f.executors.registry({ id: 'old-job', actor: 'local' });
  assert.equal(f.manager.state.registryProgress, '');
});
