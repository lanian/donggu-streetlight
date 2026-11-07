const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const D = require('../../app/data.js');
const source = fs.readFileSync(path.resolve(__dirname, '../../app/staff-app.js'), 'utf8');
function fn(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  if (start < 0) return '';
  const endLine = source.indexOf('\n', start), first = source.slice(start, endLine);
  return first.trimEnd().endsWith('}') ? first : source.slice(start, source.indexOf('\n}', start) + 2);
}
function scope(names, extra = {}) {
  const c = vm.createContext({ console, Date, Map, Set, Math, Number, JSON, DGData: D, S: { me: 'local', lights: [] }, db: null, FB: null, byId: () => null, inDong: () => true, toast() {}, ptSay() {}, ptDraw() {}, navigator: {}, navGen: () => 0, navAlive: g => g === 0, $: () => null, ...extra });
  vm.runInContext('const PATROL_JOBS=new Map(),PATROL_BUSY=new Set(); const PT_DAYS=30; let PT_LAST={};\n' + names.map(fn).join('\n'), c);
  return c;
}
const mark = (result, at = 2000) => ({ id: 'a', code: 'A', result, at });
const patrol = result => ({ sessionId: 'session', start: 1, end: 2000, dist: 0, dong: '전체', track: [], passed: new Map(), marks: [mark(result)], spots: [] });
test('lamp-on observation and its saved job cannot clear a facility fault or formal inspection state', async () => {
  const facility = { id: 'a', code: 'A', status: '고장', redoNote: '전선 노출 재점검', lastInspected: 1000, lastResult: '고장', updatedAt: 1000 };
  const ops = [];
  const c = scope(['patrolDraftKey', 'preparePatrolJob', 'patrolLightPatch', 'commitPatrolJob'], { byId: () => facility, lightState: async () => facility, FB: null, db: { doc: () => ({ get: async () => ({ exists: true, data: () => facility }) }), commitMany: async value => ops.push(...value) } });
  const job = c.preparePatrolJob(patrol('정상')); await c.commitPatrolJob(job);
  assert.equal(ops.some(op => op.path === 'lights/a'), false);
  assert.equal(job.inspections[0].data.patrol, true);
  const legacy = { ...job, patches: [{ id: 'a', data: { status: '정상', lastInspected: 2000, redoNote: null, updatedAt: 2000 } }] };
  ops.length = 0; await c.commitPatrolJob(legacy);
  assert.equal(ops.some(op => op.path === 'lights/a'), false, 'old queued patch is sanitized at commit');
});
test('lamp fault may escalate status while preserving formal inspection date and reinspection reason', async () => {
  const facility = { id: 'a', code: 'A', status: '정상', lastInspected: 1000, redoNote: '전선 확인' }, ops = [];
  const c = scope(['patrolDraftKey', 'preparePatrolJob', 'patrolLightPatch', 'commitPatrolJob'], { byId: () => facility, lightState: async () => facility, FB: null, db: { doc: () => ({ get: async () => ({ exists: true, data: () => facility }) }), commitMany: async value => ops.push(...value) } });
  await c.commitPatrolJob(c.preparePatrolJob(patrol('고장')));
  const patch = ops.find(op => op.path === 'lights/a').data;
  assert.equal(patch.status, '고장'); assert.equal('lastInspected' in patch, false); assert.equal('redoNote' in patch, false);
});
test('a rejected GPS fix prevents dark-spot recording at the previous accepted coordinates', () => {
  const p = { on: true, pos: null, last: null, track: [], spots: [], passed: new Map(), marks: [], spoken: new Set() };
  const grid = { toXY: () => ({ x: 0, y: 0 }), near: () => [] };
  const c = scope(['ptPos', 'ptSpot'], { pt: p, lightGrid: () => grid, ptDraw() {}, distM: () => 100, bearing: () => 0, AR_FOV: 60 });
  const fix = (lat, acc) => ({ timestamp: Date.now(), coords: { latitude: lat, longitude: 126.9, accuracy: acc } });
  c.ptPos(fix(35.1, 5)); c.ptPos(fix(35.2, 120)); c.ptSpot();
  assert.equal(p.spots.length, 0);
});
test('a stale GPS fix cannot be recorded as a fresh dark spot', () => {
  const p = { on: true, pos: { lat: 35.1, lng: 126.9, acc: 5, at: Date.now() - 60000 }, spots: [], undo: [] };
  const c = scope(['ptSpot'], { pt: p, lightGrid: () => ({ toXY: () => ({ x: 0, y: 0 }), near: () => [] }) });
  c.ptSpot(); assert.equal(p.spots.length, 0);
});
test('undo survives JSON restoration and removes the latest spot before an earlier mark', () => {
  const m = mark('고장', 1), sp = { lat: 35, lng: 126, at: 2 }, p = JSON.parse(JSON.stringify({ marks: [m], spots: [sp], undo: [{ type: 'mark', item: m, prev: null }, { type: 'spot', item: sp }] }));
  const c = scope(['ptUndoLast'], { pt: p, ptSay() {}, ptDraw() {} });
  c.ptUndoLast(); assert.equal(p.spots.length, 0); assert.equal(p.marks.length, 1);
  c.ptUndoLast(); assert.equal(p.marks.length, 0);
});
test('legacy undo reconstructs action order from marks and spots', () => {
  const p = { marks: [mark('고장', 1)], spots: [{ lat: 35, lng: 126, at: 2 }], undo: [] };
  const c = scope(['ptUndoLast'], { pt: p, ptSay() {}, ptDraw() {} }); c.ptUndoLast();
  assert.equal(p.spots.length, 0); assert.equal(p.marks.length, 1);
});
test('coverage uses only the same exact-coordinate facilities eligible for automatic passage', () => {
  const c = scope(['ptEligible', 'ptCoverage'], { S: { lights: [{ id: 'precise', lat: 35, lng: 126 }, { id: 'estimated', lat: 35, lng: 126, posApprox: true }, { id: 'invalid', lat: 35, lng: NaN }] } });
  vm.runInContext('PT_LAST={precise:{at:Date.now()},estimated:{at:Date.now()}};', c);
  const result = c.ptCoverage('전체'); assert.equal(result.n, 1); assert.equal(result.cov, 1); assert.equal(result.pct, 100);
});
test('report ranges reject reversed and invalid dates and include the final millisecond', () => {
  const REP = { period: 'custom', from: '2026-11-07', to: '2026-11-01' }, c = scope(['repRange'], { REP });
  assert.equal(!!c.repRange().error, true);
  REP.to = '2026-11-07'; const r = c.repRange(); assert.equal(r.error, undefined); assert.equal(new Date(r.b).getMilliseconds(), 999);
  REP.from = '2026-02-31'; assert.equal(!!c.repRange().error, true);
});
test('a reversed range never queries or exports and recovers when corrected', async () => {
  const REP = { period: 'custom', from: '2026-11-07', to: '2026-11-01', data: null, loading: false, err: '' }, calls = [];
  const c = scope(['repRange', 'reportQueryKey', 'repLoad', 'exportReportCSV'], { REP, db: {}, render() {}, resolveNames() {}, listAllRecords: async () => { calls.push('query'); return []; }, dl: { save: async () => calls.push('export') } });
  await c.repLoad(); assert.equal(calls.length, 0); assert.equal(REP.data, null); assert.match(REP.err, /기간|날짜|시작/);
  await c.exportReportCSV(); assert.equal(calls.length, 0);
  REP.to = '2026-11-07'; await c.repLoad(); assert.equal(calls.length, 2); assert.ok(REP.data);
});
test('plan patrol takes only unvisited eligible targets and GPS passage alone does not confirm them', () => {
  const lights = { a: { id: 'a', code: 'A', lat: 35, lng: 126 }, b: { id: 'b', lat: 35, lng: 126, lastInspected: 3000 }, c: { id: 'c', lat: 35, lng: 126 }, d: { id: 'd', lat: 35, lng: 126, posApprox: true } };
  const c = scope(['ptEligible', 'ptPlanTargets', 'ptMissingTargets'], { byId: id => lights[id] });
  assert.equal(typeof c.ptPlanTargets, 'function');
  const targets = c.ptPlanTargets({ createdAt: 2000, stops: ['a', 'b', 'c', 'd'].map(id => ({ ...lights[id], visited: id === 'c' })) });
  assert.deepEqual(Array.from(targets, t => t.id), ['a']);
  assert.equal(c.ptMissingTargets({ targets, passed: new Map([['a', {}]]), marks: [] }).length, 1);
  assert.equal(c.ptMissingTargets({ targets, marks: [mark('정상')] }).length, 0);
});
test('coordinate correction queue filters by district and circuit without changing registry records', () => {
  const rows = [{ id: 'a', dong: '동명동', sw: '분전함1', posApprox: true }, { id: 'b', dong: '계림동', sw: '분전함1', posApprox: true }, { id: 'c', dong: '동명동', sw: '분전함2', posApprox: true }, { id: 'd', dong: '동명동', sw: '분전함1' }, { id: 'e', dong: '동명동', sw: '분전함1', posApprox: true, removed: true }];
  const c = scope(['coordinateQueueRows'], { S: { lights: rows }, inDong: (l, dong) => dong === '전체' || l.dong === dong });
  assert.equal(typeof c.coordinateQueueRows, 'function');
  assert.deepEqual(Array.from(c.coordinateQueueRows('동명동', '분전함1'), r => r.id), ['a']);
  assert.equal(rows.length, 5);
});
test('a concurrent newer repair causes a local patrol retry to recompute without overwriting the repair', async () => {
  let current = { status: '정상', statusAt: 1000, updatedAt: 1000, lastInspected: 1000 }, writes = 0;
  const repair = { status: '정상', statusAt: 3000, updatedAt: 3000, lastInspected: 3000, lastWorkId: 'new-repair' }, saved = [];
  const c = scope(['patrolLightPatch', 'commitPatrolJob'], { lightState: async () => ({ ...current }), FB: null, db: {
    doc: () => ({ get: async () => ({ exists: true, data: () => ({ ...current }) }) }),
    commitMany: async (ops, options = {}) => {
      if (writes++ === 0) current = { ...repair };
      if (options.expected?.['lights/a'] && !D.equal(current, options.expected['lights/a'].document)) throw Object.assign(Error('changed'), { code: 'conflict' });
      for (const op of ops) { saved.push(op.path); if (op.path === 'lights/a') current = { ...current, ...op.data }; }
    }
  } });
  await c.commitPatrolJob({ id: 'old-patrol', rec: { marks: [mark('고장')] }, inspections: [] });
  assert.deepEqual(current, repair); assert.ok(saved.includes('patrols/old-patrol'));
});
test('Firebase patrol status is read and recomputed inside a transaction before any writes', async () => {
  const current = { status: '정상', statusAt: 3000, updatedAt: 3000, lastInspected: 3000 }, writes = [];
  let read = false, transactions = 0;
  const fs = { doc: path => ({ path }), batch: () => ({ set: (ref, data) => writes.push([ref.path, data]), commit: async () => {} }), runTransaction: async callback => {
    transactions++; await callback({ get: async ref => { assert.equal(writes.length, 0); read = true; return { exists: true, data: () => current }; }, set: (ref, data) => writes.push([ref.path, data]) });
  } };
  const c = scope(['patrolLightPatch', 'commitPatrolJob'], { lightState: async () => ({ status: '정상', statusAt: 1000 }), FB: { fs } });
  await c.commitPatrolJob({ id: 'old-patrol', rec: { marks: [mark('고장')] }, inspections: [] });
  assert.equal(transactions, 1); assert.equal(read, true); assert.equal(writes.some(([p]) => p === 'lights/a'), false); assert.equal(writes.some(([p]) => p === 'patrols/old-patrol'), true);
});
test('a target-only saved patrol is protected before starting a new session', async () => {
  let asks = 0;
  const c = scope(['ptCaptureOwner', 'ptOwnsContext', 'patrolStartOk'], { window: { DGOffline: { ready: true } }, DGOffline: { ready: true, get: async () => ({ sessionId: 'old', start: 1, targets: [{ id: 'a' }], marks: [], spots: [], passed: [] }) }, fmtDT: String, pt: { sessionId: 'new', on: false }, ptHasData: () => false, DGDialog: { choose: async () => { asks++; return null; } } });
  assert.equal(await c.patrolStartOk(), false); assert.equal(asks, 1);
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 60; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('async stage was not reached'); }
function carryHarness() {
  const events = [], target = { id: 'a', code: 'A' }, offline = { ready: true, namespace: 'old:user', get: async () => ({ targets: [target], planId: 'old-plan' }), put: async (...args) => events.push(['put', ...args]), remove: async (...args) => events.push(['remove', ...args]) };
  const plan = { createdAt: 1, stops: [target] }, c = scope(['ptCaptureOwner', 'ptOwnsContext', 'ptCarryTargets', 'ptLaunchCarryover', 'ptLaunchPlan'], {
    S: { me: 'old-user' }, db: {}, FB: {}, DGOffline: offline, DGIntegration: { persistPatrol: async () => events.push(['persist']) },
    pt: { sessionId: 'old-session', targets: [target], planId: 'old-plan' }, window: { DGOperations: { state: { plan } } },
    ptPlanTargets: p => p.stops, ptMissingTargets: () => [target], need: () => true, patrolHere: async () => true, patrolStartOk: async () => true,
    closeSheet: () => events.push(['close']), openPatrol: (...args) => { c.pt.sessionId = 'launched-session'; events.push(['open', ...args]); }, toast: message => events.push(['toast', message])
  });
  return { c, events, offline, target, plan };
}
const ownershipChanges = {
  actor: c => { c.S.me = 'new-user'; }, database: c => { c.db = {}; }, firebase: c => { c.FB = {}; },
  offline: c => { c.DGOffline = { ...c.DGOffline }; }, namespace: c => { c.DGOffline.namespace = 'new:user'; }
};
test('carrying patrol targets refuses late writes after actor, backend or namespace changes during a read', async () => {
  for (const [kind, change] of Object.entries(ownershipChanges)) {
    const h = carryHarness(), gate = deferred(); h.offline.get = () => gate.promise;
    const pending = h.c.ptCarryTargets(); change(h.c); gate.resolve({ targets: [] }); await pending;
    assert.deepEqual(h.events, [], kind + ' change must prevent the late write and success toast');
  }
});
test('carrying targets snapshots plan identity before the storage read and suppresses late success messages', async () => {
  const h = carryHarness(), read = deferred(), write = deferred(); h.offline.get = () => read.promise;
  h.offline.put = async (...args) => { h.events.push(['put', ...args]); await write.promise; };
  const pending = h.c.ptCarryTargets(); h.c.pt.planId = 'new-plan'; h.target.code = 'new target'; read.resolve({ targets: [] });
  await until(() => h.events.length); h.c.S.me = 'new-user'; write.resolve(); await pending;
  assert.equal(h.events[0][3].planId, 'old-plan'); assert.equal(h.events[0][3].targets[0].code, 'A'); assert.equal(h.events.length, 1);
});
test('carryover launch does not reopen a late screen after location, saved-target read or confirmation', async () => {
  for (const stage of ['location', 'read', 'confirm']) {
    const h = carryHarness(), gate = deferred();
    if (stage === 'location') h.c.patrolHere = () => gate.promise;
    if (stage === 'read') h.offline.get = () => gate.promise;
    let asked = false; if (stage === 'confirm') h.c.patrolStartOk = () => { asked = true; return gate.promise; };
    const pending = h.c.ptLaunchCarryover();
    if (stage !== 'location') await until(() => stage === 'read' ? true : asked);
    if (stage === 'read') await new Promise(resolve => setImmediate(resolve));
    h.c.S.me = 'new-user'; h.c.DGOffline.namespace = 'new:user'; gate.resolve(stage === 'read' ? { targets: [{ id: 'late' }] } : true); await pending;
    assert.equal(h.events.some(e => e[0] === 'open' || e[0] === 'remove' || e[0] === 'persist'), false, stage);
  }
});
test('carryover draft persistence cannot delete another account next-target list', async () => {
  const h = carryHarness(), gate = deferred(); let saving = false;
  h.c.DGIntegration.persistPatrol = () => { saving = true; return gate.promise; };
  const pending = h.c.ptLaunchCarryover(); await until(() => saving);
  h.c.S.me = 'new-user'; h.c.DGOffline.namespace = 'new:user'; gate.resolve(); await pending;
  assert.equal(h.events.filter(e => e[0] === 'open').length, 1); assert.equal(h.events.some(e => e[0] === 'remove'), false);
});
test('plan launch does not replace current patrol after a late context or navigation change', async () => {
  for (const stage of ['location', 'confirm']) {
    const h = carryHarness(), gate = deferred(); let confirming = false;
    if (stage === 'location') h.c.patrolHere = () => gate.promise;
    else h.c.patrolStartOk = () => { confirming = true; return gate.promise; };
    const pending = h.c.ptLaunchPlan(); if (stage === 'confirm') await until(() => confirming);
    if (stage === 'location') h.c.db = {}; else h.c.navAlive = () => false;
    gate.resolve(true); await pending; assert.deepEqual(h.events, [], stage);
  }
});
test('saved-patrol preflight cannot remove or reopen an old patrol after account changes in its dialog', async () => {
  const h = carryHarness(), gate = deferred(); let asked = false;
  h.offline.get = async () => ({ sessionId: 'stored', start: 1, targets: [{ id: 'saved' }] });
  h.c.window.DGOffline = h.offline;
  vm.runInContext(fn('patrolStartOk'), h.c); h.c.ptHasData = () => false; h.c.fmtDT = String;
  h.c.DGDialog = { choose: () => { asked = true; return gate.promise; } };
  const pending = h.c.patrolStartOk(); await until(() => asked); h.c.S.me = 'new-user'; h.offline.namespace = 'new:user'; gate.resolve('new');
  assert.equal(await pending, false); assert.deepEqual(h.events, []);
});
