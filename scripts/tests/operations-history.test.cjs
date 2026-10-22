const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '../..');
const C = require(path.join(root, 'app/operations-core.js'));
const W = require(path.join(root, 'app/work-commands.js'));
const day = 86400000, stamp = (month, date) => Date.UTC(2026, month - 1, date);
const clone = value => JSON.parse(JSON.stringify(value));
const range = month => [stamp(month, 1), stamp(month + 1, 1) - 1];
const analytics = (orders, events, month = 1) => C.analytics([], orders, [], [], ...range(month), events);

function local(initial = {}) {
  let json = JSON.stringify(initial);
  const storage = { fail: false, getItem: () => json, setItem(key, value) { if (this.fail) throw Object.assign(new Error('quota'), { code: 'quota-exceeded' }); json = value; }, dump: () => JSON.parse(json) };
  const context = vm.createContext({ console, Date, Math });
  vm.runInContext(fs.readFileSync(path.join(root, 'app/data.js'), 'utf8'), context);
  return { db: context.DGData.createLocalDB({ storage, indexedDB: null }), storage };
}

function fixture() {
  const order = { ...C.createOrder({ title: '시설 수리', assignedTo: 'local' }, { id: 'p', code: 'P', dong: '동명동' }, 'local', stamp(1, 1)),
    status: 'completed', revision: 3, afterPhotos: ['after'], completionNote: '램프 교체', parts: [{ inventoryId: 'stock', name: '램프', qty: 2, unitCost: 100 }], costTotal: 200 };
  const initial = { workOrders: { w: order }, photos: { after: { workId: 'w', lightId: 'p', kind: 'work', by: 'local', at: stamp(1, 10), data: 'data:image/jpeg;base64,AA==' } }, inventory: { stock: { name: '램프', unit: '개', unitCost: 100, quantity: 10, revision: 1 } } };
  const l = local(initial), context = { db: l.db, user: 'local', admin: true };
  function job(id, target, at, input = {}) { return { id, kind: 'transition', workId: 'w', actor: 'local', target, at, input: { expectedRevision: l.storage.dump().workOrders.w.revision, ...input }, photos: [] }; }
  async function move(id, target, at, input = {}) { const command = job(id, target, at, input); await W.execute(command, context); return command; }
  async function rework(month, quantity) {
    await move('assign-' + month, 'assigned', stamp(month, 1), { assignedTo: 'local' });
    await move('start-' + month, 'in_progress', stamp(month, 2));
    await move('complete-' + month, 'completed', stamp(month, 3), { completionNote: '자재 내역 보정', afterPhotos: ['after'], parts: [{ inventoryId: 'stock', name: '램프', qty: quantity, unitCost: 100 }] });
  }
  return { ...l, context, job, move, rework };
}

test('historical approval counts and cost survive reassignment of the current work order', () => {
  const order = { id: 'w', status: 'assigned', createdAt: stamp(1, 1), updatedAt: stamp(2, 1), dueAt: stamp(2, 20), costTotal: 900 };
  const events = [{ workId: 'w', toStatus: 'verified', at: stamp(1, 15), createdAt: stamp(1, 1), costTotal: 200, costDelta: 200 },
    { workId: 'w', toStatus: 'assigned', at: stamp(2, 1), createdAt: stamp(1, 1), costTotal: 900, costDelta: 0 }];
  const saved = clone({ order, events }), result = analytics([order], events);
  assert.equal(result.verified, 1); assert.equal(result.cost, 200); assert.equal(result.averageDays, 14);
  assert.equal(result.unresolved, 1, 'current workload still follows the current order status');
  assert.deepEqual({ order, events }, saved, 'reporting must not rewrite its sources');
});

test('an explicitly empty event set is authoritative, while omitted events retain the old API behavior', () => {
  const order = { id: 'w', status: 'verified', createdAt: stamp(1, 1), verifiedAt: stamp(1, 3), costTotal: 75 };
  const legacy = C.analytics([], [order], [], [], ...range(1));
  assert.equal(legacy.verified, 1); assert.equal(legacy.cost, 75); assert.equal(legacy.averageDays, 2);
  const explicit = analytics([order], []);
  assert.equal(explicit.verified, 0); assert.equal(explicit.cost, 0); assert.equal(explicit.averageDays, null);
});

test('event periods include both boundaries, preserve zero and negative deltas, and support legacy cost snapshots', () => {
  const from = 10 * day, to = 20 * day;
  const events = [
    { toStatus: 'verified', at: from, createdAt: from - day, costDelta: 0, costTotal: 500 },
    { toStatus: 'verified', at: to, createdAt: to - 3 * day, costDelta: -20, costTotal: 80 },
    { toStatus: 'verified', at: from + day, createdAt: from, costTotal: 50 },
    { toStatus: 'verified', at: from + 2 * day, createdAt: from, costDelta: null, costTotal: 100 },
    { toStatus: 'completed', at: from, createdAt: from - day, costDelta: 999, costTotal: 999 },
    { toStatus: 'verified', at: from - 1, createdAt: 1, costDelta: 999 },
    { toStatus: 'verified', at: to + 1, createdAt: 1, costDelta: 999 }
  ];
  const result = C.analytics([], [], [], [], from, to, events);
  assert.equal(result.verified, 4); assert.equal(result.cost, 130); assert.equal(result.averageDays, 1.75);
});

test('period event history is independent of current backlog and report status', () => {
  const from = stamp(1, 1), to = stamp(2, 1) - 1;
  const orders = [{ status: 'assigned', createdAt: stamp(2, 1), dueAt: stamp(1, 1) }, { status: 'in_progress', createdAt: stamp(1, 3) },
    { status: 'verified', createdAt: stamp(1, 4), verifiedAt: stamp(2, 4), costTotal: 900 }, { status: 'cancelled', createdAt: stamp(1, 2), dueAt: stamp(1, 1) }];
  const events = [{ toStatus: 'verified', at: stamp(1, 5), createdAt: stamp(1, 1), costTotal: 20, costDelta: 20 }];
  const result = C.analytics([], orders, [{ status: '접수' }, { status: '처리중' }, { status: '완료' }], [], from, to, events);
  assert.equal(result.opened, 3); assert.equal(result.unresolved, 2); assert.equal(result.overdue, 1); assert.equal(result.pendingReports, 2);
  assert.equal(result.verified, 1); assert.equal(result.cost, 20); assert.equal(result.averageDays, 4);
});

test('new work orders start with zero recognized cost and every state event snapshots the accounting fields', async () => {
  const l = local(), command = { id: 'created', kind: 'create', actor: 'local', workId: 'w', at: stamp(1, 1), light: { id: 'p', code: 'P' },
    input: { title: '램프 교체', assignedTo: 'local', parts: [{ name: '램프', qty: 2, unitCost: 100 }] }, photos: [] };
  await W.execute(command, { db: l.db, user: 'local', admin: true });
  const result = l.storage.dump(); assert.equal(result.workOrders.w.accountedCost, 0);
  assert.equal(result.workEvents.created.createdAt, stamp(1, 1)); assert.equal(result.workEvents.created.costTotal, 200); assert.equal(result.workEvents.created.costDelta, 0);
});

test('first approval, increased second approval and reduced third approval account only for their deltas', async () => {
  const l = fixture();
  const firstJob = await l.move('verify-1', 'verified', stamp(1, 15));
  assert.equal(l.storage.dump().workOrders.w.accountedCost, 200);
  await l.rework(2, 3);
  assert.equal(l.storage.dump().workOrders.w.accountedCost, 200, 'reopening and editing must preserve the previous recognized cost');
  const firstMonthWhileOpen = analytics(Object.values(l.storage.dump().workOrders), Object.values(l.storage.dump().workEvents));
  assert.equal(firstMonthWhileOpen.verified, 1); assert.equal(firstMonthWhileOpen.cost, 200);
  const secondJob = await l.move('verify-2', 'verified', stamp(2, 5));
  await l.rework(3, 0.5);
  const thirdJob = await l.move('verify-3', 'verified', stamp(3, 5));
  const once = l.storage.dump();
  for (const job of [firstJob, secondJob, thirdJob]) await W.execute(job, l.context);
  assert.deepEqual(l.storage.dump(), once, 'replaying older jobs must not change the ledger, inventory or current order');
  const result = l.storage.dump(), approvals = ['verify-1', 'verify-2', 'verify-3'].map(id => result.workEvents[id]);
  assert.deepEqual(approvals.map(event => event.costDelta), [200, 100, -250]);
  assert.deepEqual(approvals.map(event => event.costTotal), [200, 300, 50]);
  assert.equal(result.workOrders.w.accountedCost, 50); assert.equal(result.inventory.stock.quantity, 9.5);
  const events = Object.values(result.workEvents), orders = Object.values(result.workOrders);
  assert.equal(analytics(orders, events, 1).cost, 200); assert.equal(analytics(orders, events, 2).cost, 100); assert.equal(analytics(orders, events, 3).cost, -250);
  const total = C.analytics([], orders, [], [], stamp(1, 1), stamp(4, 1) - 1, events);
  assert.equal(total.cost, 50); assert.equal(total.verified, 3);
  for (const event of events) { assert.equal(event.createdAt, stamp(1, 1)); if (event.toStatus !== 'verified') assert.equal(event.costDelta, 0); }
});

test('a failed approval does not advance accounted cost or create a cost event before the same job retries', async () => {
  const l = fixture(), job = l.job('verify', 'verified', stamp(1, 15)), before = l.storage.dump();
  l.storage.fail = true; await assert.rejects(W.execute(job, l.context), { code: 'quota-exceeded' }); assert.deepEqual(l.storage.dump(), before);
  l.storage.fail = false; await W.execute(job, l.context); await W.execute(job, l.context);
  const result = l.storage.dump(); assert.equal(result.workOrders.w.accountedCost, 200); assert.equal(result.workEvents.verify.costDelta, 200);
  assert.equal(Object.keys(result.workEvents).length, 1); assert.equal(result.inventory.stock.quantity, 8);
});

test('same-cost reapproval records a real approval with zero additional recognized cost', async () => {
  const l = fixture(); await l.move('verify-1', 'verified', stamp(1, 15)); await l.rework(2, 2); await l.move('verify-2', 'verified', stamp(2, 5));
  const result = l.storage.dump(), february = analytics(Object.values(result.workOrders), Object.values(result.workEvents), 2);
  assert.equal(result.workEvents['verify-2'].costDelta, 0); assert.equal(february.verified, 1); assert.equal(february.cost, 0);
  assert.equal(result.inventory.stock.quantity, 8); assert.equal(Object.keys(result.inventoryMoves).length, 1);
});
