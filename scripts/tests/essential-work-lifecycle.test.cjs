const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../app/operations-core');
const W = require('../../app/work-commands');
const D = require('../../app/data');
const order = input => C.createOrder({ title: '안전 확인', assignedTo: 'local', workflowVersion: 2, ...input }, { id: 'p', code: '동명1', dong: '동명동' }, 'local', 1000);
function local(initial) { let json = JSON.stringify(initial); const db = D.createLocalDB({ storage: { getItem: () => json, setItem: (_, value) => { json = value; } }, indexedDB: null, locks: { request: (_, fn) => Promise.resolve().then(fn) } }); return { db, context: { db, user: 'local', admin: true }, dump: () => JSON.parse(json) }; }
test('only the assignee acknowledges a work and a real reassignment clears acknowledgement', () => {
  const old = order();
  assert.equal(old.workflowVersion, 2);
  assert.throws(() => C.workProcess(old, 'acknowledge', { expectedRevision: 1 }, 'other', true, 2000), { code: 'permission-denied' });
  const next = C.workProcess(old, 'acknowledge', { expectedRevision: 1 }, 'local', false, 2000);
  assert.equal(next.acknowledgedAt, 2000); assert.equal(next.acknowledgedBy, 'local'); assert.equal(next.status, old.status);
  const renamed = C.updateOrder(next, { expectedRevision: 2, title: '제목 정정' }, 'local', true, 3000);
  assert.equal(renamed.acknowledgedAt, 2000);
  const reassigned = C.updateOrder(renamed, { expectedRevision: 3, assignedTo: 'worker' }, 'local', true, 4000);
  assert.equal(reassigned.acknowledgedAt, 0); assert.equal(reassigned.acknowledgedBy, '');
});
test('hold and resume retain original status/deadline and require accountable next action', () => {
  const old = { ...order({ dueAt: 1500 }), status: 'in_progress' };
  for (const input of [{ reason: 'material' }, { reason: 'unknown', nextAt: 4000, nextAction: '구매 확인' }, { reason: 'material', nextAt: 0, nextAction: '구매 확인' }]) assert.throws(() => C.workProcess(old, 'hold', { expectedRevision: 1, ...input }, 'local', false, 2000));
  const held = C.workProcess(old, 'hold', { expectedRevision: 1, reason: 'material', note: '램프 주문', nextAt: 4000, nextAction: '납품 일정 확인' }, 'local', false, 2000);
  assert.equal(held.status, 'in_progress'); assert.equal(held.dueAt, 1500); assert.equal(held.hold.since, 2000);
  assert.ok(C.attentionItems([held], 'local', false, 3000).some(item => item.reasons.includes('기한 초과')));
  assert.throws(() => C.transition(held, 'completed', { expectedRevision: 2, afterPhotos: ['a'], completionNote: '조치' }, 'local', false, 3000));
  const resumed = C.workProcess(held, 'resume', { expectedRevision: 2 }, 'local', false, 3500);
  assert.equal(resumed.hold, null); assert.equal(resumed.dueAt, 1500);
  assert.throws(() => C.workProcess(old, 'hold', { expectedRevision: 0, reason: 'material', nextAt: 4000, nextAction: '확인' }, 'local', false, 2000), { code: 'conflict' });
});
test('new work completions require standard cause/action and old queued completions remain valid', () => {
  const modern = { ...order(), status: 'in_progress' }, input = { expectedRevision: 1, afterPhotos: ['a'], completionNote: '램프 교체' };
  assert.throws(() => C.transition(modern, 'completed', input, 'local', false, 2000));
  const done = C.transition(modern, 'completed', { ...input, diagnosis: 'lamp', repairAction: 'replace' }, 'local', false, 2000);
  assert.equal(done.diagnosis, 'lamp'); assert.equal(done.repairAction, 'replace');
  const legacy = { ...modern }; delete legacy.workflowVersion;
  assert.equal(C.transition(legacy, 'completed', input, 'local', false, 2000).status, 'completed');
});
test('attention list includes all relevant urgent/overdue/hold reminders and respects assignee scope', () => {
  const all = [{ id: 'u', ...order({ priority: '긴급', dueAt: 9000 }) }, { id: 'o', ...order({ assignedTo: 'other', dueAt: 1000 }) }, { id: 'closed', ...order(), status: 'verified' }];
  const mine = C.attentionItems(all, 'local', false, 2000);
  assert.deepEqual(mine.map(row => row.id), ['u']); assert.ok(mine[0].reasons.includes('배정 미확인'));
  assert.equal(C.attentionItems(all, 'local', true, 2000).length, 2);
});
test('process commands commit exactly once with immutable events and revision conflicts are atomic', async () => {
  const l = local({ workOrders: { w: order() } });
  const job = { id: 'ack', kind: 'acknowledge', workId: 'w', actor: 'local', at: 2000, input: { expectedRevision: 1 } };
  await W.execute(job, l.context); await W.execute(job, l.context);
  assert.equal(l.dump().workOrders.w.revision, 2); assert.equal(l.dump().workEvents.ack.type, 'acknowledge');
  const saved = l.dump(); await assert.rejects(W.execute({ ...job, id: 'stale' }, l.context), { code: 'conflict' }); assert.deepEqual(l.dump(), saved);
});
test('actual circuit statistics use confirmed circuit links and never infer a circuit from switch type', () => {
  const visits = [{ lightId: 'p', result: '고장', date: 1000 }, { lightId: 'q', result: '고장', date: 1000 }];
  const lights = [{ id: 'p', sw: 'GPS' }, { id: 'q', sw: 'GPS' }];
  const value = C.analytics(visits, [], [], lights, 0, 2000, [], { links: [{ lightId: 'p', circuitId: 'c' }], circuits: [{ id: 'c', name: '1회로' }] });
  assert.deepEqual(value.circuits, [['1회로', 1], ['회로 미등록', 1]]); assert.deepEqual(value.switchTypes, [['GPS', 2]]);
});
// A work awaiting review records who completed it; the server rules also refuse resetting its
// acknowledgement there. Reassignment goes through "보완 요청" first, like changing its parts.
test('a work awaiting review cannot be reassigned but its other details can still be corrected', () => {
  const completed = { ...C.workProcess(order(), 'acknowledge', { expectedRevision: 1 }, 'local', false, 2000), status: 'completed', completedBy: 'local', completedAt: 2500 };
  assert.throws(() => C.updateOrder(completed, { expectedRevision: 2, assignedTo: 'worker' }, 'admin', true, 3000), { code: 'failed-precondition', message: /보완 요청/ });
  const corrected = C.updateOrder(completed, { expectedRevision: 2, title: '제목 정정', assignedTo: 'local' }, 'admin', true, 3000);
  assert.equal(corrected.title, '제목 정정'); assert.equal(corrected.acknowledgedBy, 'local'); assert.equal(corrected.acknowledgedAt, 2000);
});
// Works assigned before acknowledgement existed (no acknowledgedAt field at all) would otherwise all appear
// as "배정 미확인" right after the upgrade. A legacy work reassigned afterwards records acknowledgedAt: 0 and
// is flagged again, because that assignment really is unacknowledged.
test('works assigned before acknowledgement existed are not reported as unacknowledged', () => {
  const legacy = { id: 'legacy', ...C.createOrder({ title: '이전 작업', assignedTo: 'local' }, { id: 'p', code: 'P' }, 'admin', 1000) };
  assert.equal(Object.hasOwn(legacy, 'acknowledgedAt'), false);
  assert.deepEqual(C.attentionItems([legacy], 'local', false, 2000), []);
  const reassigned = { id: 'legacy', ...C.updateOrder(legacy, { expectedRevision: 1, assignedTo: 'worker' }, 'admin', true, 1500) };
  assert.ok(C.attentionItems([reassigned], 'worker', false, 2000)[0].reasons.includes('배정 미확인'));
});
test('an assignee is not reminded about work already handed in for review, while administrators still are', () => {
  const handedIn = { id: 'done', ...order({ priority: '긴급', dueAt: 1500 }), status: 'completed', completedBy: 'local', completedAt: 1800 };
  assert.deepEqual(C.attentionItems([handedIn], 'local', false, 2000), []);
  assert.deepEqual(C.attentionItems([handedIn], 'admin', true, 2000).map(row => row.id), ['done']);
});
