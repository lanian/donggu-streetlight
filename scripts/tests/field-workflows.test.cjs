const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../app/operations-core.js');
const W = require('../../app/work-commands.js');
const F = require('../../app/workflows.js');
const D = require('../../app/data.js');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(initial = {}) { let data = JSON.stringify(initial); const db = D.createLocalDB({ indexedDB: null, storage: { getItem: () => data, setItem: (_, value) => { data = value; } } }); return { db, context: { db, user: 'local', admin: true }, dump: () => JSON.parse(data) }; }
const light = { id: 'a', code: 'A', dong: '동명동' }, report = { lightId: null, issue: '꺼짐', status: '접수', desc: '원래 신고 내용', receipt: 'R-1', contact: '보존할 연락처', createdAt: 100 };
const reportJob = (id = 'link', extra = {}) => ({ id, kind: 'report-link', actor: 'local', at: 1000, reportId: 'r', expectedRevision: 0, expectedUpdatedAt: 100, light, reason: '현장에서 표찰을 확인함', ...extra });
const createJob = (id, reports = []) => ({ id: 'create-' + id, kind: 'create', workId: id, actor: 'local', at: 2000, light, input: { title: id + ' 수리', reportIds: reports }, photos: [] });

test('facility linking preserves the original report and immutable retries cannot revert later correction', async () => {
  const f = fixture({ reports: { r: report } }), first = reportJob(); await W.execute(first, f.context);
  let saved = f.dump(); assert.equal(saved.reports.r.lightId, 'a'); assert.equal(saved.reports.r.desc, report.desc); assert.equal(saved.reports.r.contact, report.contact); assert.equal(saved.reports.r.receipt, report.receipt); assert.equal(saved.reportEvents.link.reason, first.reason);
  const second = reportJob('correct', { expectedRevision: 1, expectedUpdatedAt: 1000, at: 3000, light: { id: 'b', code: 'B' }, reason: '옆 시설로 잘못 연결되어 정정' });
  await W.execute(second, f.context); const after = f.dump(); await W.execute(first, f.context); assert.deepEqual(f.dump(), after); assert.equal(after.reportEvents.correct.fromLightId, 'a'); assert.equal(after.reports.r.workId, '');
  await assert.rejects(W.execute({ ...first, reason: '동일 ID에 다른 내용' }, f.context), { code: 'conflict' });
});

test('report linking rejects unauthorized actors, stale previews and active-work reassignment', async () => {
  const f = fixture({ reports: { r: report } });
  await assert.rejects(W.execute(reportJob(), { ...f.context, admin: false }), { code: 'permission-denied' });
  await f.db.doc('reports/r').update({ updatedAt: 101 }); await assert.rejects(W.execute(reportJob(), f.context), { code: 'conflict' });
  await f.db.doc('reports/r').update({ lightId: 'b', workId: 'work-b', updatedAt: 100 }); await f.db.doc('workOrders/work-b').set({ status: 'in_progress', revision: 1 });
  await assert.rejects(W.execute(reportJob(), f.context), { code: 'failed-precondition' });
  assert.equal(Object.keys(f.dump().reportEvents || {}).length, 0);
});

test('creating and linking an existing work atomically claims same-facility reports', async () => {
  const f = fixture({ reports: { r: { ...report, lightId: 'a' }, r2: { ...report, lightId: 'a' } } });
  await W.execute(createJob('work-a', ['r']), f.context);
  assert.equal(f.dump().reports.r.workId, 'work-a');
  const job = { id: 'add-report', kind: 'link-reports', workId: 'work-a', actor: 'local', at: 3000, input: { expectedRevision: 1, reportIds: ['r2'] }, reportVersions: { r2: 100 } };
  await W.execute(job, f.context); const saved = f.dump();
  assert.deepEqual(saved.workOrders['work-a'].reportIds, ['r', 'r2']); assert.equal(saved.workOrders['work-a'].status, 'draft'); assert.equal(saved.workOrders['work-a'].revision, 2);
  assert.equal(saved.workEvents['add-report'].type, 'reports-linked'); assert.equal(saved.workEvents['add-report'].costDelta, 0); assert.equal(saved.reports.r2.workId, 'work-a');
  await W.execute(job, f.context); assert.deepEqual(f.dump(), saved);
  await assert.rejects(W.execute(createJob('work-b', ['r']), f.context), { code: 'conflict' });
  assert.equal(f.dump().workOrders['work-b'], undefined);
});

test('work links reject missing, completed, foreign-facility and changed reports without partial writes', async () => {
  const f = fixture({ reports: { r: { ...report, lightId: 'b' }, r2: { ...report, lightId: 'a', status: '완료' } } });
  for (const id of ['r', 'r2', 'missing']) await assert.rejects(W.execute(createJob('bad-' + id, [id]), f.context), { code: 'failed-precondition' });
  assert.equal(Object.keys(f.dump().workOrders || {}).length, 0);
  await f.db.doc('reports/r').update({ lightId: 'a' }); await W.execute(createJob('work'), f.context);
  await assert.rejects(W.execute({ id: 'stale-link', kind: 'link-reports', workId: 'work', actor: 'local', at: 3000, input: { expectedRevision: 1, reportIds: ['r'] }, reportVersions: { r: 99 } }, f.context), { code: 'conflict' });
  assert.deepEqual(f.dump().workOrders.work.reportIds, []);
});

test('same new command ID with different work payload is rejected, including concurrent retry', async () => {
  const f = fixture(), job = createJob('w'); await Promise.all([W.execute(job, f.context), W.execute(copy(job), f.context)]);
  assert.equal(Object.keys(f.dump().workEvents).length, 1);
  await assert.rejects(W.execute({ ...job, input: { title: '다른 내용' } }, f.context), { code: 'conflict' });
});

test('today and overdue filters use KST boundaries with the same rows as their query', () => {
  const now = Date.parse('2026-10-25T00:30:00+09:00'), midnight = Date.parse('2026-10-25T00:00:00+09:00');
  const rows = [{ id: 'today', status: 'assigned', assignedTo: 'u', priority: '긴급', dueAt: midnight + 86399999, dong: '동명동' }, { id: 'yesterday', status: 'assigned', assignedTo: 'u', priority: '긴급', dueAt: midnight - 1, dong: '동명동' }, { id: 'other', status: 'verified', assignedTo: 'u', priority: '긴급', dueAt: midnight + 2000, dong: '동명동' }];
  const filters = { status: 'open', mine: true, urgent: true, deadline: 'today', dong: '동명동' }, query = C.workQuery(filters, 'u', now);
  assert.deepEqual(C.filterOrders(rows, filters, { user: 'u', now }).map(x => x.id), ['today']);
  assert.deepEqual(D.select(rows, query).map(x => x.id), ['today']);
  assert.deepEqual(C.filterOrders(rows, { ...filters, deadline: 'overdue' }, { user: 'u', now }).map(x => x.id), ['yesterday']);
});

test('visit plans deduplicate facilities while retaining the tasks already grouped at each stop', () => {
  const point = { id: 'a', code: 'A', lat: 35.1, lng: 126.9, workIds: ['w1', 'w2'] };
  const plan = C.planVisits([point, point], point); assert.equal(plan.stops.length, 1); assert.deepEqual(plan.stops[0].workIds, ['w1', 'w2']);
});

test('duplicate reports are suggestions scoped by issue, facility and seven-day window', () => {
  const report = { id: 'r', lightId: 'a', issue: '꺼짐', createdAt: 10 * 86400000 };
  const rows = [{ ...report, id: 'yes', createdAt: report.createdAt + 86400000 }, { ...report, id: 'other-light', lightId: 'b' }, { ...report, id: 'other-issue', issue: '깜빡임' }, { ...report, id: 'closed', status: '완료' }, { ...report, id: 'old', createdAt: 1 }];
  assert.deepEqual(F.duplicateCandidates(report, rows).map(x => x.id), ['yes']); assert.equal(rows.length, 5);
});

test('facility history retains receipt, inspection, reassignment, approval cost delta and stock events', () => {
  const data = { light: {}, inspections: [{ id: 'i', date: 2, result: '고장' }], reports: [{ id: 'r', createdAt: 1, issue: '꺼짐', status: '접수' }], orders: [{ id: 'w', title: '수리', createdAt: 3, status: 'assigned' }], events: [{ id: 'e1', workId: 'w', type: 'created', at: 3, toStatus: 'assigned' }, { id: 'e2', workId: 'w', at: 4, toStatus: 'verified', costDelta: 500 }, { id: 'e3', workId: 'w', at: 5, toStatus: 'assigned', costDelta: 0 }], moves: [{ id: 'm', workId: 'w', itemId: 'led', at: 4, delta: -1 }], reportEvents: [{ id: 'r1', reportId: 'r', at: 2, fromLightId: '', toLightId: 'a', reason: '현장 확인' }] };
  const rows = F.timelineItems(data); assert.equal(rows.length, 7); assert.equal(rows[0].id, 'work-event:e3'); assert.equal(rows.find(x => x.kind === '완료 검수').costDelta, 500); assert.equal(rows.some(x => x.kind === '신고 시설 연결'), true); assert.equal(rows.some(x => x.id === 'work:w'), false);
});
