const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../app/asset-maintenance-core.js');
const Commands = require('../../app/asset-maintenance-commands.js');
const Data = require('../../app/data.js');
const clone = value => JSON.parse(JSON.stringify(value));
const now = 10000;
const cabinet = extra => ({ code: 'CAB-1', label: '동명 분전함', dong: '동명동', lat: null, lng: null, note: '', disabled: false, ...extra });
const circuit = extra => ({ cabinetId: 'cab', code: 'C-1', label: '북측 회로', note: '', disabled: false, ...extra });
const link = extra => ({ lightId: 'p1', cabinetId: 'cab', circuitId: 'cir', confirmationNote: '현장 대장으로 연결 확인', ...extra });
const incident = extra => ({ title: '북측 동시 소등', cabinetId: 'cab', circuitId: 'cir', lightIds: ['p1', 'p2'], reportIds: ['r1'], workIds: ['w1'], confirmedLightIds: [], status: 'open', note: '', resolutionNote: '', ...extra });
const replacement = extra => ({ lightId: 'p1', component: 'lamp', replacedAt: 9000, manufacturer: '제조사', model: 'LED-A', warrantyEnd: 30000, workId: 'w1', note: '램프 교체', ...extra });
const meta = (data, extra = {}) => ({ schemaVersion: 1, ...data, createdAt: 1000, createdBy: 'local', updatedAt: 1000, updatedBy: 'local', revision: 1, operationId: 'old-op', ...extra });
const job = (entity, recordId, data, extra = {}) => ({ id: 'op-' + entity, entity, recordId, expectedRevision: 0, data, actor: 'local', at: now, ...extra });
function fixture(initial = {}) {
  let json = JSON.stringify(initial);
  const db = Data.createLocalDB({ indexedDB: null, locks: { request: (_key, action) => Promise.resolve().then(action) }, storage: { getItem: () => json, setItem: (_key, value) => { json = value; } } });
  return { db, dump: () => JSON.parse(json), context: { db, user: 'local', admin: true, byId: id => ['p1', 'p2', 'p3'].includes(id) ? { id, code: id, sw: '전자식' } : null } };
}
function linked(extra = {}) {
  return { cabinets: { cab: meta(cabinet()) }, circuits: { cir: meta(circuit()) }, assetLinks: { p1: meta(link()), p2: meta(link({ lightId: 'p2' })) }, reports: { r1: { lightId: 'p1', status: '접수' } }, workOrders: { w1: { lightId: 'p1', status: 'verified' } }, ...extra };
}

test('physical cabinet/circuit IDs are explicit and never inferred from a switch type', () => {
  assert.deepEqual(C.normalize('cabinet', cabinet()), cabinet());
  assert.throws(() => C.normalize('cabinet', cabinet({ lat: 35, lng: null })));
  assert.throws(() => C.normalize('link', link({ circuitId: '' })));
  assert.throws(() => C.normalize('incident', incident({ confirmedLightIds: ['p3'] })));
  const disconnected = C.normalize('link', link({ cabinetId: '', circuitId: '', confirmationNote: '잘못된 연결 해제' }));
  assert.equal(disconnected.circuitId, '');
});

test('administrator cabinet creation and same-command retry retain immutable result after later edits', async () => {
  const f = fixture(), first = job('cabinet', 'cab', cabinet());
  await Commands.execute(first, f.context); await Commands.execute(first, f.context);
  assert.equal(f.dump().cabinets.cab.revision, 1); assert.equal(Object.keys(f.dump().assetOperations).length, 1);
  await Commands.execute(job('cabinet', 'cab', cabinet({ label: '새 이름' }), { id: 'cab-edit', expectedRevision: 1, at: 11000 }), f.context);
  const retried = await Commands.execute(first, f.context);
  assert.equal(retried.alreadyApplied, true); assert.equal(retried.record.label, '동명 분전함'); assert.equal(f.dump().cabinets.cab.label, '새 이름');
  await assert.rejects(Commands.execute({ ...first, data: cabinet({ label: '다른 요청' }) }, f.context), { code: 'conflict' });
});

test('wrong parent, unknown facility, non-admin and stale revision reject without partial records', async () => {
  const f = fixture(linked()); const before = clone(f.dump());
  for (const bad of [job('circuit', 'wrong', circuit({ cabinetId: 'missing' })), job('link', 'p1', link({ cabinetId: 'missing' }), { expectedRevision: 1 }), job('link', 'unknown', link({ lightId: 'unknown' })), job('link', 'p1', link(), { expectedRevision: 0 })]) await assert.rejects(Commands.execute(bad, f.context));
  await assert.rejects(Commands.execute(job('cabinet', 'other', cabinet()), { ...f.context, admin: false }), { code: 'permission-denied' });
  await assert.rejects(Commands.execute(job('cabinet', 'other', cabinet(), { actor: 'other' }), f.context), { code: 'permission-denied' });
  assert.deepEqual(f.dump(), before);
});

test('a stray override cannot manufacture an unknown registry facility and admin context must be boolean', async () => {
  const f = fixture(linked({ lights: { unknown: { status: '고장' } } }));
  await assert.rejects(Commands.execute(job('link', 'unknown', link({ lightId: 'unknown' })), f.context));
  await assert.rejects(Commands.execute(job('cabinet', 'other', cabinet()), { ...f.context, admin: 'yes' }), { code: 'permission-denied' });
});

test('circuit parent is stable and link updates preserve previous snapshots', async () => {
  const f = fixture(linked({ cabinets: { cab: meta(cabinet()), second: meta(cabinet({ code: 'CAB-2' })) } }));
  await assert.rejects(Commands.execute(job('circuit', 'cir', circuit({ cabinetId: 'second' }), { expectedRevision: 1 }), f.context));
  await Commands.execute(job('link', 'p1', link({ cabinetId: '', circuitId: '', confirmationNote: '대장 오연결 해제' }), { expectedRevision: 1 }), f.context);
  assert.equal(f.dump().assetLinks.p1.circuitId, ''); assert.equal(f.dump().assetOperations['op-link'].snapshot.confirmationNote, '대장 오연결 해제');
  assert.equal(f.dump().circuits.cir.cabinetId, 'cab');
});

test('a grouped outage preserves each child state and requires all facilities restored and linked work closed', async () => {
  const f = fixture(linked()); await Commands.execute(job('incident', 'outage', incident()), f.context);
  const created = clone(f.dump()); assert.equal(created.workOrders.w1.status, 'verified'); assert.equal(created.lights, undefined); assert.equal(created.inventory, undefined);
  await assert.rejects(Commands.execute(job('incident', 'outage', incident({ status: 'resolved', resolutionNote: '복구', confirmedLightIds: ['p1'] }), { expectedRevision: 1 }), f.context));
  await f.db.doc('workOrders/w1').update({ status: 'in_progress' });
  await assert.rejects(Commands.execute(job('incident', 'outage', incident({ status: 'resolved', resolutionNote: '복구', confirmedLightIds: ['p1', 'p2'] }), { expectedRevision: 1 }), f.context));
  await f.db.doc('workOrders/w1').update({ status: 'verified' });
  await Commands.execute(job('incident', 'outage', incident({ status: 'resolved', resolutionNote: '현장 복구 확인', confirmedLightIds: ['p1', 'p2'] }), { id: 'outage-resolve', expectedRevision: 1, at: 11000 }), f.context);
  assert.equal(f.dump().outageIncidents.outage.status, 'resolved'); assert.equal(f.dump().reports.r1.status, '접수');
});

test('incident references must belong to its target facilities and physical circuit', async () => {
  const f = fixture(linked({ workOrders: { w1: { lightId: 'p3', status: 'verified' } } }));
  await assert.rejects(Commands.execute(job('incident', 'outage', incident()), f.context));
  const g = fixture(linked({ assetLinks: { p1: meta(link()), p2: meta(link({ lightId: 'p2', circuitId: 'other' })) } }));
  await assert.rejects(Commands.execute(job('incident', 'outage', incident()), g.context));
});

test('replacement records keep independent component dates and warranty and never change stock or past work', async () => {
  const f = fixture(linked({ inventory: { lamp: { quantity: 5 } } }));
  await Commands.execute(job('replacement', 'replacement-a', replacement()), f.context);
  await Commands.execute(job('replacement', 'replacement-b', replacement({ component: 'driver', replacedAt: 9500, model: 'DR-B', warrantyEnd: 40000 }), { id: 'op-replace-b' }), f.context);
  const saved = f.dump(); assert.equal(saved.inventory.lamp.quantity, 5); assert.equal(saved.workOrders.w1.status, 'verified'); assert.equal(Object.keys(saved.assetReplacements).length, 2);
  await assert.rejects(Commands.execute(job('replacement', 'replacement-a', replacement(), { id: 'replace-edit', expectedRevision: 1, at: 11000 }), f.context));
  await assert.rejects(Commands.execute(job('replacement', 'bad', replacement({ warrantyEnd: 1000 })), f.context));
});

test('a raced reference or record aborts the whole local CAS transaction', async () => {
  const f = fixture(linked()), original = f.db.commitMany.bind(f.db); let raced = false;
  f.db.commitMany = async (ops, options) => { if (!raced) { raced = true; await f.db.doc('circuits/cir').update({ disabled: true, revision: 2 }); } return original(ops, options); };
  await assert.rejects(Commands.execute(job('incident', 'outage', incident()), f.context), { code: 'conflict' });
  assert.equal(f.dump().outageIncidents, undefined); assert.equal(f.dump().assetOperations, undefined);
});

test('Firestore preparation completes every reference read before writes and supports missing exists() snapshots', async () => {
  const f = fixture(linked()); const records = new Map(); for (const [col, rows] of Object.entries(f.dump())) for (const [id, data] of Object.entries(rows)) records.set(col + '/' + id, clone(data));
  const fb = { doc: path => ({ path }), runTransaction: async run => { let wrote = false; const staged = new Map(records); const out = await run({ get: async ref => { assert.equal(wrote, false); const val = staged.get(ref.path); return { exists: () => !!val, data: () => val }; }, set: (ref, data) => { wrote = true; staged.set(ref.path, clone(data)); } }); records.clear(); for (const entry of staged) records.set(...entry); return out; } };
  await Commands.execute(job('incident', 'outage', incident()), { ...f.context, user: 'local', fb });
  assert.equal(records.get('outageIncidents/outage').status, 'open'); assert.equal(records.has('assetOperations/op-incident'), true);
});
// Rules and commands require an open outage's cabinet and circuit to be in use, so retiring one under an
// open outage would leave that outage impossible to resolve. Disabling is refused while any outage is open.
test('open outages on a cabinet or circuit are reported before it is retired', () => {
  const Core = require('../../app/asset-maintenance-core.js');
  const incidents = [
    { id: 'open-cab', title: '분전함 전체 소등', status: 'open', cabinetId: 'cab', circuitId: '' },
    { id: 'open-cir', title: '1회로 소등', status: 'open', cabinetId: 'cab', circuitId: 'cir' },
    { id: 'closed', title: '복구한 장애', status: 'resolved', cabinetId: 'cab', circuitId: 'cir' },
    { id: 'other', title: '다른 분전함', status: 'open', cabinetId: 'other', circuitId: 'x' }
  ];
  assert.deepEqual(Core.openIncidentsOn('cabinet', 'cab', incidents).map(row => row.id), ['open-cab', 'open-cir']);
  assert.deepEqual(Core.openIncidentsOn('circuit', 'cir', incidents).map(row => row.id), ['open-cir']);
  assert.deepEqual(Core.openIncidentsOn('cabinet', 'none', incidents), []);
});
