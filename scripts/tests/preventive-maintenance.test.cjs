const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const C = require('../../app/operations-core');
const D = require('../../app/data');
const P = fs.existsSync('app/preventive-core.js') ? require('../../app/preventive-core') : {};
const Commands = fs.existsSync('app/preventive-commands.js') ? require('../../app/preventive-commands') : {};
const planData = { title: '분기 점검', description: '설비 확인', type: '재점검', priority: '보통', assignedTo: 'local', intervalDays: 90, completionDays: 3, startAt: 1000, lightIds: ['p', 'q'], enabled: true };
const save = { id: 'plan-create', kind: 'save', planId: 'plan', actor: 'local', at: 1000, expectedRevision: 0, data: planData };
const target = id => ({ light: { id, code: id, dong: '동명동' }, candidateWorkId: '' });
function local(initial = {}) { let json = JSON.stringify(initial); const db = D.createLocalDB({ storage: { getItem: () => json, setItem: (_, value) => { json = value; } }, indexedDB: null, locks: { request: (_, fn) => Promise.resolve().then(fn) } }); return { db, context: { db, user: 'local', admin: true }, dump: () => JSON.parse(json) }; }
test('preventive plans normalize bounded targets and validate independent interval and completion days', () => {
  const p = P.normalize(planData); assert.deepEqual(p.lightIds, ['p', 'q']);
  for (const bad of [{ intervalDays: 0 }, { completionDays: 0 }, { lightIds: [] }, { lightIds: Array.from({ length: 201 }, (_, i) => 'x' + i) }, { assignedTo: '' }]) assert.throws(() => P.normalize({ ...planData, ...bad }));
});
test('create plan preserves author and changed retry IDs cannot overwrite its receipt', async () => {
  const l = local(); await Commands.execute(save, l.context); await Commands.execute(save, l.context);
  assert.equal(l.dump().preventivePlans.plan.revision, 1); assert.equal(l.dump().preventivePlans.plan.nextAt, 1000);
  await assert.rejects(Commands.execute({ ...save, data: { ...planData, title: '다른 요청' } }, l.context), { code: 'conflict' });
  await assert.rejects(Commands.execute({ ...save, id: 'not-admin' }, { ...l.context, admin: false }), { code: 'permission-denied' });
});
test('generation creates exactly one work per cycle target and preserves per-work event history on repeat', async () => {
  const l = local(); await Commands.execute(save, l.context);
  const job = { id: 'cycle', kind: 'generate', planId: 'plan', actor: 'local', at: 2000, expectedRevision: 1, scheduledAt: 1000, targets: [target('p'), target('q')] };
  await Commands.execute(job, l.context); await Commands.execute(job, l.context);
  await Commands.execute({ ...job, id: 'other-click', at: 2100 }, l.context);
  const saved = l.dump(); assert.equal(Object.keys(saved.workOrders).length, 2); assert.equal(Object.keys(saved.workEvents).length, 2); assert.equal(Object.keys(saved.preventiveRuns).length, 2);
  for (const work of Object.values(saved.workOrders)) { assert.equal(work.type, '재점검'); assert.equal(work.workflowVersion, 2); assert.equal(work.dueAt, 1000 + 3 * 86400000 - 1); }
});
test('an existing unfinished target is carried without altering its revision, stock or events', async () => {
  const original = C.createOrder({ title: '진행 중 정기점검', type: '재점검', assignedTo: 'local' }, { id: 'p', code: 'p' }, 'local', 1);
  const l = local({ workOrders: { existing: original } }); await Commands.execute(save, l.context);
  await Commands.execute({ id: 'carry', kind: 'generate', planId: 'plan', actor: 'local', at: 2000, expectedRevision: 1, scheduledAt: 1000, targets: [{ ...target('p'), candidateWorkId: 'existing' }] }, l.context);
  assert.deepEqual(l.dump().workOrders.existing, original); assert.equal(l.dump().workEvents, undefined);
  assert.equal(Object.values(l.dump().preventiveRuns)[0].carried, true); assert.equal(Object.values(l.dump().preventiveRuns)[0].workId, 'existing');
});
test('advance requires the entire cycle and future/backlog rounds retain their original scheduled time', async () => {
  const l = local(); await Commands.execute(save, l.context);
  const advance = { id: 'advance', kind: 'advance', planId: 'plan', actor: 'local', at: 2000, expectedRevision: 1, scheduledAt: 1000 };
  await assert.rejects(Commands.execute(advance, l.context));
  await Commands.execute({ ...advance, id: 'g', kind: 'generate', targets: [target('p'), target('q')] }, l.context);
  await Commands.execute(advance, l.context); await Commands.execute(advance, l.context);
  assert.equal(l.dump().preventivePlans.plan.nextAt, 1000 + 90 * 86400000); assert.equal(l.dump().preventivePlans.plan.revision, 2);
});
test('generation rejects oversized groups, wrong target, stale plan and cross-facility carryover atomically', async () => {
  const l = local({ workOrders: { wrong: C.createOrder({ title: '다른 시설', type: '재점검' }, { id: 'x' }, 'local', 1) } }); await Commands.execute(save, l.context);
  const job = { id: 'invalid', kind: 'generate', planId: 'plan', actor: 'local', at: 2000, expectedRevision: 1, scheduledAt: 1000, targets: [target('p')] };
  const before = l.dump();
  for (const patch of [{ targets: [target('x')] }, { targets: Array.from({ length: 5 }, () => target('p')) }, { expectedRevision: 0 }, { targets: [{ ...target('p'), candidateWorkId: 'wrong' }] }]) await assert.rejects(Commands.execute({ ...job, ...patch }, l.context));
  assert.deepEqual(l.dump(), before);
});
