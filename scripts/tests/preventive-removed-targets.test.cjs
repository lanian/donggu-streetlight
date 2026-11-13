const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const C = require('../../app/operations-core');
const D = require('../../app/data');
const P = require('../../app/preventive-core');
const Commands = require('../../app/preventive-commands');

// The plan screen runs against the real command executor and local DB, so a removed facility is
// exercised through the same save → generate → advance path an administrator uses.
const planData = { title: '분기 점검', description: '설비 확인', type: '재점검', priority: '보통', assignedTo: 'local', intervalDays: 90, completionDays: 3, startAt: 1000, lightIds: ['p', 'q', 'r'], enabled: true };
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };
async function fixture(lights, answer = true) {
  let json = '{}', sequence = 0;
  const db = D.createLocalDB({ storage: { getItem: () => json, setItem: (_, value) => { json = value; } }, indexedDB: null, locks: { request: (_, fn) => Promise.resolve().then(fn) } });
  const context = { db, user: 'local', admin: true }, dump = () => JSON.parse(json), asked = [], messages = [], listeners = {};
  await Commands.execute({ id: 'plan-create', kind: 'save', planId: 'plan', actor: 'local', at: 1000, expectedRevision: 0, data: planData }, context);
  const offline = { ready: true, namespace: 'one', register() {}, get: async () => null, putIfCurrent: async () => ({ draftRevision: 1 }), removeIfCurrent: async () => true, jobs: async () => [], discard: async () => {},
    submit: async (kind, job) => { try { await Commands.execute(job, context); return { state: 'synced' }; } catch (error) { return { state: error.code === 'conflict' ? 'conflict' : 'failed', error: error.message }; } } };
  const vmContext = vm.createContext({ console, Date, Promise, setTimeout() {}, document: { querySelector: () => null, addEventListener: (name, fn) => { listeners[name] = fn; } },
    DGOperationsCore: C, DGPreventiveCore: P, DGPreventiveCommands: Commands, DGOffline: offline,
    DGOperations: { uuid: prefix => prefix + '-' + (++sequence), load: async () => {} },
    DGDialog: { confirm: async message => { asked.push(message); return answer; } } });
  vm.runInContext(fs.readFileSync('app/preventive.js', 'utf8'), vmContext);
  const byId = new Map(lights.map(light => [light.id, light]));
  const api = { esc: value => String(value), firebase: () => null, database: () => db, state: () => ({ me: 'local', names: {}, roles: [], lights }), can: () => true,
    readAll: async collection => Object.entries(dump()[collection] || {}).map(([id, value]) => ({ id, ...value })),
    byId: id => byId.get(id), render() {}, inDong: () => true, dongOptions: () => '', toast: message => messages.push(message), navGen: () => 0, navAlive: () => true, navigate() {} };
  vmContext.DGPreventive.attach(api); await vmContext.DGPreventive.load();
  // Press the plan's "이번 회차 생성" button through the same delegated click handler the page uses.
  const button = { disabled: false, isConnected: true, dataset: { pm: 'generate', id: 'plan' } };
  return { dump, asked, messages, generate: async () => { listeners.click({ target: { closest: () => button } }); await settle(); } };
}
const light = (id, extra = {}) => ({ id, code: 'C-' + id, dong: '동명동', ...extra });

test('a removed facility is dropped from the plan after confirmation and the round still completes', async () => {
  const f = await fixture([light('p'), light('q', { removed: true }), light('r')]);
  await f.generate();
  assert.equal(f.asked.length, 1); assert.match(f.asked[0], /C-q/);
  const saved = f.dump();
  assert.deepEqual(saved.preventivePlans.plan.lightIds, ['p', 'r']);
  assert.equal(saved.preventivePlans.plan.nextAt, 1000 + 90 * 86400000, 'the round advances to the next scheduled date');
  assert.deepEqual(Object.values(saved.preventiveRuns).map(run => run.lightId).sort(), ['p', 'r']);
  assert.equal(Object.keys(saved.workOrders).length, 2);
  assert.ok(Object.values(saved.preventiveOperations).some(op => op.action === 'save' && op.revision === 2), 'the removal is recorded as an auditable plan save');
});

test('a facility missing from the registry is treated the same as a removed one and named by its ID', async () => {
  const f = await fixture([light('p'), light('r')]);
  await f.generate();
  assert.match(f.asked[0], /q/);
  assert.deepEqual(f.dump().preventivePlans.plan.lightIds, ['p', 'r']);
});

test('declining the removal leaves the plan and the round untouched', async () => {
  const f = await fixture([light('p'), light('q', { removed: true }), light('r')], false);
  await f.generate();
  const saved = f.dump();
  assert.deepEqual(saved.preventivePlans.plan.lightIds, ['p', 'q', 'r']); assert.equal(saved.preventivePlans.plan.revision, 1);
  assert.equal(saved.preventiveRuns, undefined); assert.equal(saved.workOrders, undefined);
});

test('a plan whose every facility is gone is not emptied and asks the administrator to stop it', async () => {
  const f = await fixture([light('p', { removed: true }), light('q', { removed: true })]);
  await f.generate();
  assert.equal(f.asked.length, 0);
  assert.deepEqual(f.dump().preventivePlans.plan.lightIds, ['p', 'q', 'r']);
  assert.ok(f.messages.some(message => /계획을 중지/.test(message)));
});
