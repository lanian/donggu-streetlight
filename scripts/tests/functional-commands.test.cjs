const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../app/operations-core.js');
const W = require('../../app/work-commands.js');
const D = require('../../app/data.js');
const Restore = require('../../functions/restore-core.js');
const copy = value => JSON.parse(JSON.stringify(value));
const light = { id: 'p', code: '동명 1', dong: '동명동' };
const part = (qty, inventoryId = 's') => ({ name: '램프', inventoryId, qty, unitCost: 100 });
const work = input => C.createOrder({ title: '교체', assignedTo: 'local', ...input }, light, 'local', 1000);
const stock = { name: '램프', unit: '개', quantity: 10, unitCost: 100, revision: 1, updatedAt: 1000, updatedBy: 'local' };
function local(initial) {
  let value = JSON.stringify(initial);
  // Memory CAS fixture: avoid depending on the host Node version's experimental Web Locks.
  const db = D.createLocalDB({ storage: { getItem: () => value, setItem: (_, next) => { value = next; } }, indexedDB: null, locks: { request: (_key, action) => Promise.resolve().then(action) } });
  return { db, dump: () => JSON.parse(value), context: { db, user: 'local', admin: true } };
}
const edit = (input = {}, patch = {}) => ({ id: 'edit-1', kind: 'update', workId: 'w', actor: 'local', at: 2000, input: { expectedRevision: 1, title: '새 제목', ...input }, ...patch });
const itemEdit = (patch = {}) => ({ id: 'item-edit-1', kind: 'inventory-update', itemId: 's', actor: 'local', at: 2000, expectedRevision: 1, reason: '이름 오기 정정', input: { name: 'LED 램프', unitCost: 150 }, ...patch });

test('metadata editing changes only requested fields and preserves status, evidence and accounting', () => {
  const before = { ...work({ reportIds: ['r'], parts: [part(2)] }), status: 'in_progress', stockApplied: { s: 1 }, accountedCost: 100 };
  const result = C.updateOrder(before, { expectedRevision: 1, title: '정정', dueAt: 0, priority: '긴급', assignedTo: 'worker', parts: [part(3)] }, 'admin', true, 2000);
  assert.equal(result.status, 'in_progress'); assert.equal(result.assignedTo, 'worker'); assert.equal(result.revision, 2);
  assert.equal(result.costTotal, 300); assert.deepEqual(result.reportIds, ['r']); assert.deepEqual(result.stockApplied, { s: 1 });
  assert.equal(result.accountedCost, 100); assert.equal(result.createdAt, 1000); assert.equal(result.updatedBy, 'admin');
  assert.equal(before.title, '교체'); assert.equal(before.parts[0].qty, 2);
});

test('metadata editing rejects permissions, stale revisions, invalid values and changes to history', () => {
  const before = work();
  assert.throws(() => C.updateOrder(before, { expectedRevision: 1, title: 'x' }, 'worker', false, 2000), { code: 'permission-denied' });
  assert.throws(() => C.updateOrder(before, { expectedRevision: 0, title: 'x' }, 'local', true, 2000), { code: 'conflict' });
  for (const input of [{ title: '' }, { assignedTo: '' }, { priority: '없는 값' }, { type: '없는 값' }, { dueAt: -1 }, { dueAt: 1.5 }, { status: 'verified' }, { stockApplied: {} }, { reportIds: [] }]) {
    assert.throws(() => C.updateOrder(before, { expectedRevision: 1, ...input }, 'local', true, 2000));
  }
  for (const status of ['verified', 'cancelled']) assert.throws(() => C.updateOrder({ ...before, status }, { expectedRevision: 1, title: 'x' }, 'local', true, 2000));
  const completed = { ...before, status: 'completed', completedBy: 'worker', completedAt: 1500, completionNote: '완료', afterPhotos: ['a'] };
  const changed = C.updateOrder(completed, { expectedRevision: 1, dueAt: 3000, title: '검수 대기 정정' }, 'local', true, 2000);
  assert.equal(changed.completedBy, 'worker'); assert.equal(changed.completedAt, 1500); assert.deepEqual(changed.afterPhotos, ['a']);
  assert.throws(() => C.updateOrder(completed, { expectedRevision: 1, parts: [part(1)] }, 'local', true, 2000));
});

test('work update commits an immutable event exactly once and a changed retry cannot reuse its ID', async () => {
  const l = local({ workOrders: { w: work() } });
  await W.execute(edit(), l.context); await W.execute(edit(), l.context);
  const saved = l.dump(); assert.equal(saved.workOrders.w.status, 'assigned'); assert.equal(saved.workOrders.w.revision, 2);
  assert.equal(saved.workOrders.w.title, '새 제목'); assert.equal(saved.workEvents['edit-1'].type, 'updated');
  assert.equal(saved.workEvents['edit-1'].costDelta, 0); assert.equal(Object.keys(saved.workEvents).length, 1);
  await assert.rejects(W.execute(edit({ title: '다른 변경' }), l.context), { code: 'conflict' });
  await assert.rejects(W.execute(edit({}, { id: 'edit-2' }), l.context), { code: 'conflict' });
  assert.deepEqual(l.dump(), saved);
});

test('inventory metadata preserves identity, quantity and unit with descriptive zero-delta history', async () => {
  const l = local({ inventory: { s: stock } }); const job = itemEdit();
  await W.execute(job, l.context); await W.execute(job, l.context);
  const saved = l.dump(), item = saved.inventory.s, receipt = saved.inventoryMoves[job.id];
  assert.equal(item.name, 'LED 램프'); assert.equal(item.unitCost, 150); assert.equal(item.unit, '개'); assert.equal(item.quantity, 10); assert.equal(item.revision, 2);
  assert.equal(receipt.delta, 0); assert.equal(receipt.itemId, 's'); assert.match(receipt.reason, /램프/); assert.match(receipt.reason, /100/); assert.match(receipt.reason, /150/);
  assert.match(receipt.requestHash, /^[a-f0-9]{64}$/); assert.equal(Object.keys(saved.inventoryMoves).length, 1);
  await assert.rejects(W.execute(itemEdit({ input: { name: '다른 이름', unitCost: 150 } }), l.context), { code: 'conflict' });
  await assert.rejects(W.execute(itemEdit({ id: 'new-id' }), l.context), { code: 'conflict' });
  assert.deepEqual(l.dump(), saved);
});

test('inventory metadata invalid input and non-admin cannot mutate stock or its history', async () => {
  for (const patch of [{ input: { name: '', unitCost: 100 } }, { input: { name: '램프', unitCost: -1 } }, { input: { name: '램프', unitCost: 100, quantity: 0 } }, { input: { name: '램프', unitCost: 100, unit: '상자' } }, { reason: ' ' }]) {
    const l = local({ inventory: { s: stock } });
    await assert.rejects(W.execute(itemEdit(patch), l.context)); assert.deepEqual(l.dump(), { inventory: { s: stock } });
  }
  const l = local({ inventory: { s: stock } }); await assert.rejects(W.execute(itemEdit(), { ...l.context, admin: false }), { code: 'permission-denied' });
});

test('forecast totals all active work demand, nets previous deductions and excludes closed work without mutating stock', () => {
  const inventory = [{ id: 's', ...stock }], orders = [
    { id: 'a', ...work({ parts: [part(6)] }) }, { id: 'b', ...work({ parts: [part(6)] }), status: 'completed' },
    { id: 'c', ...work({ parts: [part(3)] }), status: 'verified' }, { id: 'd', ...work({ parts: [part(3)] }), status: 'cancelled' },
    { id: 'e', ...work({ parts: [part(3)] }), stockApplied: { s: 2 } }
  ];
  const snapshot = copy({ inventory, orders }), result = C.inventoryForecast(inventory, orders), row = result.rows[0];
  assert.deepEqual({ planned: row.planned, quantity: row.quantity, available: row.available, shortage: row.shortage }, { planned: 13, quantity: 10, available: -3, shortage: 3 });
  assert.deepEqual(row.workIds.sort(), ['a', 'b', 'e']); assert.deepEqual({ inventory, orders }, snapshot);
  assert.deepEqual(result.unlinked, []);
});

test('forecast aggregates duplicate parts and reports unlinked or missing inventory without inventing stock', () => {
  const result = C.inventoryForecast([{ id: 's', ...stock }], [
    { id: 'a', ...work({ parts: [part(1), part(2), { name: '외부자재', qty: 2, unitCost: 10 }, part(4, 'missing')] }), stockApplied: { s: 2 } },
    { id: 'b', ...work({ parts: [part(1)] }), stockApplied: { s: 5 } }
  ]);
  assert.equal(result.rows[0].planned, 1); assert.equal(result.rows[0].available, 9);
  assert.equal(result.unlinked.length, 2); assert.ok(result.unlinked.some(x => x.workId === 'a' && x.inventoryId === 'missing'));
});

test('inventory upper-bound overflow is rejected before a future movement becomes stuck', () => {
  assert.throws(() => C.inventoryChange({ ...stock, quantity: 100000000 }, 0.001, 1));
  assert.equal(C.inventoryChange({ ...stock, quantity: 99999999 }, 1, 1).quantity, 100000000);
});

test('new metadata inventory receipts remain valid operational restore documents', async () => {
  const l = local({ inventory: { s: stock } }); await W.execute(itemEdit(), l.context);
  assert.doesNotThrow(() => Restore.validate('inventoryMoves', l.dump().inventoryMoves['item-edit-1']));
  assert.throws(() => Restore.validate('inventoryMoves', { ...l.dump().inventoryMoves['item-edit-1'], requestHash: 'invalid' }));
});

test('saving planned work demand never deducts or reserves inventory', async () => {
  const l = local({ inventory: { s: stock }, workOrders: { w: work() } });
  await W.execute(edit({ parts: [part(6)] }), l.context);
  assert.deepEqual(l.dump().inventory.s, stock); assert.equal(l.dump().inventoryMoves, undefined);
  assert.equal(l.dump().workOrders.w.parts[0].qty, 6); assert.equal(l.dump().workOrders.w.costTotal, 600);
  assert.equal(l.dump().workOrders.w.accountedCost, 0);
});

test('bulk assignment makes an unassigned draft actionable in one revision and preserves planning', async () => {
  const l = local({ workOrders: { w: work({ assignedTo: '', parts: [part(2)] }) } });
  const job = edit({ assignedTo: 'worker', priority: '긴급', dueAt: 5000 }); delete job.input.title; job.kind = 'assign';
  await W.execute(job, l.context); await W.execute(job, l.context);
  const saved = l.dump(); assert.equal(saved.workOrders.w.status, 'assigned'); assert.equal(saved.workOrders.w.assignedTo, 'worker');
  assert.equal(saved.workOrders.w.priority, '긴급'); assert.equal(saved.workOrders.w.dueAt, 5000); assert.equal(saved.workOrders.w.revision, 2);
  assert.deepEqual(saved.workOrders.w.parts, [part(2)]); assert.ok(C.actions(saved.workOrders.w, 'worker', false).includes('in_progress'));
  assert.equal(saved.workEvents['edit-1'].fromStatus, 'draft'); assert.equal(saved.workEvents['edit-1'].toStatus, 'assigned');
});

test('explicit draft assignment rejects missing assignee, stale revision or unintended content edits', async () => {
  for (const input of [{ assignedTo: '' }, { assignedTo: 'worker', title: '의도하지 않은 내용 변경' }, { assignedTo: 'worker', expectedRevision: 0 }]) {
    const l = local({ workOrders: { w: work({ assignedTo: '' }) } });
    const job = edit(input, { kind: 'assign' }); if (!Object.hasOwn(input, 'title')) delete job.input.title;
    await assert.rejects(W.execute(job, l.context)); assert.equal(l.dump().workOrders.w.revision, 1);
  }
});

test('a concurrent stock movement aborts a metadata edit with no partial receipt', async () => {
  const l = local({ inventory: { s: stock } }), original = l.db.commitMany.bind(l.db); let raced = false;
  l.db.commitMany = async (ops, options) => {
    if (!raced) { raced = true; await l.db.doc('inventory/s').update({ quantity: 9, revision: 2 }); }
    return original(ops, options);
  };
  await assert.rejects(W.execute(itemEdit(), l.context), { code: 'conflict' });
  assert.equal(l.dump().inventory.s.name, '램프'); assert.equal(l.dump().inventory.s.quantity, 9); assert.equal(l.dump().inventoryMoves, undefined);
});

test('full backup graph with work edits and stock metadata receipts restores without replaying demand', async () => {
  const l = local({});
  await W.execute({ id: 'initial-stock', kind: 'inventory-create', itemId: 's', actor: 'local', at: 1000, input: { name: stock.name, unit: stock.unit, quantity: stock.quantity, unitCost: stock.unitCost } }, l.context);
  await W.execute({ id: 'initial-work', kind: 'create', workId: 'w', actor: 'local', at: 1000, light, input: { title: '교체', assignedTo: 'local', parts: [part(2)] } }, l.context);
  await W.execute(edit({ parts: [part(3)] }), l.context); await W.execute(itemEdit(), l.context);
  const collections = Object.fromEntries(Object.entries(l.dump()).map(([name, values]) => [name, Object.entries(values).map(([id, data]) => ({ id, ...data }))]));
  const restored = Restore.validateGraph(Restore.normalize({ operationId: 'metadata-restore', overwrite: false, collections }), new Map());
  assert.equal(restored.result.get('inventory/s').quantity, 10); assert.equal(restored.result.get('inventory/s').name, 'LED 램프');
  assert.equal(restored.result.get('workOrders/w').parts[0].qty, 3); assert.equal(restored.result.get('workOrders/w').accountedCost, 0);
});
