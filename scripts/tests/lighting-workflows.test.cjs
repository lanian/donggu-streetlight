const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../app/lighting-workflow-core.js');
const Commands = require('../../app/lighting-workflow-commands.js');
const Lighting = require('../../app/lighting-commands.js');
const Model = require('../../app/lighting-model.js');
const Data = require('../../app/data.js');
const now = Date.now() - 10000, point = { lat: 35.14, lng: 126.93 };
const observation = patch => ({ id: 'observation-1', kind: 'observation', label: '현장 확인', category: 'field', ...point, radius: 10, level: 'dark', observedAt: now + 1000, validDays: 30, nightConfirmed: true, schedule: 'hours', startMinute: 1080, endMinute: 360, ...patch });
const task = patch => ({ title: '다른 기관 조명 재확인', ...point, radius: 10, note: '', originKind: 'record', originId: 'external-1', evidenceIds: ['external-1'], assignedTo: 'local', dueAt: now + 86400000, reviewMinute: 1260, status: 'open', observationId: '', completionNote: '', completedAt: 0, completedBy: '', ...patch });
const taskJob = patch => ({ id: 'task-op-1', recordId: 'task-1', entity: 'task', actor: 'local', at: now, expectedRevision: 0, data: task(), ...patch });
function local(initial = {}) {
  let raw = JSON.stringify(initial);
  const storage = { getItem: () => raw, setItem: (_, value) => { raw = value; } };
  return { db: Data.createLocalDB({ storage, indexedDB: null }), dump: () => JSON.parse(raw) };
}
function firebase(initial = {}) {
  let records = Data.clone(initial); const control = { loseAcknowledgement: false }, db = { doc: path => ({ path }), runTransaction: async fn => {
    const writes = [], result = await fn({ get: async ref => { assert.equal(writes.length, 0); return { exists: Object.hasOwn(records, ref.path), data: () => Data.clone(records[ref.path]) }; }, set: (ref, data) => writes.push([ref.path, Data.clone(data)]) });
    for (const [path, data] of writes) records[path] = data;
    if (control.loseAcknowledgement && writes.length) { control.loseAcknowledgement = false; throw Object.assign(new Error('ack lost'), { code: 'unavailable' }); } return result;
  } };
  return { db, control, dump: () => Data.clone(records) };
}
async function runData(count = 1) {
  const records = [observation({ level: 'bright', observedAt: now - 1000 })];
  const evidence = Model.evaluate(Model.createContext(records, [], { now, minute: 1260 }), point, .1);
  const cands = Array.from({ length: count }, (_, i) => ({ name: '검토 지점 ' + i, mid: point, context: { ...evidence, coverage: { total: 1, bright: 1, dark: 0, conflict: 0, external: 0, unobserved: 0, supported: 1, unit: 'point' } } }));
  return C.buildRun({ review: { at: now, minute: 1260, mode: 'pairs', dong: '전체', kind: '전체', cands }, lights: [{ id: 'registered-1', ...point, updatedAt: 12 }], records, roads: null, model: { weak: .3 }, calibration: null, baseAt: () => .1 });
}

test('CSV quoted text and Point GeoJSON preserve all records and reject invalid geometry per row', () => {
  const parsed = C.parseImport('\ufeffid,name,lat,lng\r\n1,"학교, 정문",35.14,126.93\r\n2,"두 줄\n이름",35.15,126.94', 'lights.csv');
  assert.equal(parsed.rows.length, 2); assert.equal(parsed.rows[0].name, '학교, 정문'); assert.equal(parsed.rows[1].name, '두 줄\n이름');
  const geo = C.parseImport(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: '1', name: '다른 기관' }, geometry: { type: 'Point', coordinates: [126.93, 35.14] } }, { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } }] }), 'lights.geojson');
  assert.equal(geo.rows[0].latitude, 35.14); assert.equal(geo.rows[0].longitude, 126.93); assert.match(geo.rows[1]._error, /Point/);
  assert.throws(() => C.parseImport('id,id\n1,2', 'a.csv'), /중복/);
  assert.throws(() => C.parseImport('id,name\n1,"unclosed', 'a.csv'), /닫히지/);
});

test('import preview distinguishes new, protected, duplicate, invalid without changing existing evidence', async () => {
  const existing = [{ id: 'field-record', sourceAgency: '다른 기관', sourceRecordId: 'old', note: '현장 수정', nightConfirmed: true, ...point }], original = Data.clone(existing);
  const parsed = C.parseImport('id,name,lat,lng,date\nold,기존,35.14,126.93,2026-01-01\nnew,신규,35.14,126.93,2026-01-01\nnew,중복,35.14,126.93,2026-01-01\nbad,좌표 오류,,126.93,2026-01-01\nbad-date,날짜 오류,35.14,126.93,2026-02-31', 'lights.csv');
  const preview = await C.previewImport(parsed, { sourceRecordId: 'id', label: 'name', lat: 'lat', lng: 'lng', sourceUpdatedAt: 'date' }, { now, agency: '다른 기관', dataset: '공공 대장 1차', batchId: 'batch-1', existing, registry: [] });
  assert.deepEqual(preview.counts, { new: 1, protected: 1, duplicate: 1, invalid: 2 }); assert.equal(preview.rows.length, 5); assert.deepEqual(existing, original);
  const imported = preview.rows.find(r => r.status === 'new');
  assert.equal(imported.data.nightConfirmed, false); assert.equal(imported.data.status, 'unknown'); assert.equal(imported.data.schedule, 'unknown'); assert.equal(imported.data.lux, null);
  assert.equal(imported.data.sourceAgency, '다른 기관'); assert.equal(imported.data.sourceRecordId, 'new');
  assert.equal(Model.evaluate(Model.createContext([imported.data], [], { now, minute: 1260 }), point, 0).external, 0);
  const again = await C.previewImport(parsed, { sourceRecordId: 'id', label: 'name', lat: 'lat', lng: 'lng', sourceUpdatedAt: 'date' }, { now, agency: '다른 기관', dataset: '공공 대장 2차', batchId: 'batch-2', existing: [], registry: [] });
  assert.equal(again.rows.find(r => r.sourceId === 'new').recordId, imported.recordId, 'agency identity creates stable record IDs across batches');
});

test('provenance is optional for legacy queue compatibility and requires complete groups', () => {
  const old = Model.normalizeRecord(observation());
  assert.equal(Object.hasOwn(old, 'sourceAgency'), false); assert.equal(Object.hasOwn(old, 'originKind'), false);
  assert.throws(() => Model.normalizeRecord({ ...observation(), sourceAgency: '기관' }), /출처/);
  assert.throws(() => Model.normalizeRecord({ ...observation(), originKind: 'patrol' }), /원본/);
  const linked = Model.normalizeRecord({ ...observation(), originKind: 'patrol', originId: 'patrol-1', originPointId: '0', positionAccuracy: 20 });
  assert.equal(linked.originId, 'patrol-1'); assert.equal(linked.positionAccuracy, 20);
});

test('bulk import requires administrator, creates only, and rejects fabricated night confirmation', async () => {
  const parsed = C.parseImport('id,name,lat,lng\n1,정문,35.14,126.93', 'a.csv'), p = await C.previewImport(parsed, { sourceRecordId: 'id', label: 'name', lat: 'lat', lng: 'lng' }, { now, agency: '기관', dataset: '대장', batchId: 'batch', existing: [] });
  const row = p.rows[0], l = local(), job = { id: 'import-op', recordId: row.recordId, actor: 'local', at: now, expectedRevision: 0, data: row.data, importSource: true };
  await assert.rejects(Lighting.execute(job, { db: l.db, user: 'local', admin: false }), { code: 'permission-denied' });
  await assert.rejects(Lighting.execute({ ...job, data: { ...job.data, nightConfirmed: true } }, { db: l.db, user: 'local', admin: true }), /확정/);
  await Lighting.execute(job, { db: l.db, user: 'local', admin: true });
  await assert.rejects(Lighting.execute({ ...job, id: 'different-import-op', expectedRevision: 1 }, { db: l.db, user: 'local', admin: true }), { code: 'permission-denied' });
  assert.equal(l.dump().lightingContext[row.recordId].revision, 1);
});

for (const mode of ['local', 'firebase']) test(mode + ': tasks retain completion through replay and runs are immutable', async () => {
  const obs = Model.normalizeRecord(observation()), l = mode === 'local' && local({ lightingContext: { 'observation-1': obs } }), f = mode === 'firebase' && firebase({ 'roles/local': { role: 'inspector' }, 'lightingContext/observation-1': obs });
  const context = { db: l ? l.db : f.db, ...(f ? { fb: f.db } : {}), user: 'local', admin: false }, read = () => l ? Object.fromEntries(Object.entries(l.dump()).flatMap(([col, values]) => Object.entries(values).map(([id, row]) => [col + '/' + id, row]))) : f.dump();
  const first = taskJob(); await Commands.execute(first, context);
  const completion = taskJob({ id: 'complete-op', at: now + 2000, expectedRevision: 1, data: task({ status: 'completed', observationId: 'observation-1', completionNote: '점등 확인·관찰 기록 연결' }) });
  await Commands.execute(completion, context);
  const snapshot = read(); assert.equal((await Commands.execute(first, context)).alreadyApplied, true); assert.equal((await Commands.execute(completion, context)).alreadyApplied, true); assert.deepEqual(read(), snapshot);
  const stored = read()['lightingTasks/task-1']; assert.equal(stored.completedAt, now + 2000); assert.equal(stored.completedBy, 'local'); assert.equal(stored.revision, 2);
  const reopen = taskJob({ id: 'reopen-op', at: now + 3000, expectedRevision: 2 });
  await assert.rejects(Commands.execute(reopen, context), { code: 'permission-denied' }); await Commands.execute(reopen, { ...context, admin: true });
  assert.equal(read()['lightingTasks/task-1'].status, 'open');
  const data = await runData(), run = { entity: 'run', id: 'run-op', recordId: 'run-1', actor: 'local', at: now + 5000, expectedRevision: 0, data };
  await Commands.execute(run, context); assert.equal((await Commands.execute(run, context)).alreadyApplied, true);
  await assert.rejects(Commands.execute({ ...run, id: 'run-edit', expectedRevision: 1 }, context), { code: 'permission-denied' });
});

test('completion rejects old, daytime, stale, distant, unknown and mismatched-time evidence', () => {
  const t = { ...task(), createdAt: now };
  for (const patch of [{ observedAt: now - 300001 }, { nightConfirmed: false }, { observedAt: now - 31 * 86400000 }, { lat: 36 }, { level: 'unknown' }, { startMinute: 600, endMinute: 800 }, { removed: true }]) assert.throws(() => C.checkCompletion(t, observation(patch), now + 5000), { code: 'failed-precondition' });
  assert.doesNotThrow(() => C.checkCompletion(t, observation(), now + 5000));
});

test('CAS rejects a concurrent task change and a changed observation without a false receipt', async () => {
  const l = local({ lightingContext: { 'observation-1': Model.normalizeRecord(observation()) } }), context = { db: l.db, user: 'local', admin: true };
  await Commands.execute(taskJob(), context);
  const write = l.db.commitMany; let race = true;
  l.db.commitMany = async (ops, options) => { if (race) { race = false; await l.db.doc('lightingContext/observation-1').update({ level: 'unknown' }); } return write(ops, options); };
  await assert.rejects(Commands.execute(taskJob({ id: 'raced-complete', at: now + 2000, expectedRevision: 1, data: task({ status: 'completed', observationId: 'observation-1', completionNote: '확인' }) }), context), { code: 'conflict' });
  assert.equal(l.dump().lightingTasks['task-1'].status, 'open'); assert.equal(l.dump().lightingWorkflowOperations['raced-complete'], undefined);
});

test('a lost Firebase acknowledgement is resolved using the immutable receipt', async () => {
  const f = firebase({ 'roles/local': { role: 'inspector' } }); f.control.loseAcknowledgement = true;
  assert.equal((await Commands.execute(taskJob(), { db: f.db, fb: f.db, user: 'local', admin: false })).alreadyApplied, true);
  assert.equal(f.dump()['lightingTasks/task-1'].revision, 1);
});

test('model comparison separates overprediction, underprediction and excluded conflicting observations', () => {
  const records = [observation({ id: 'dark', lat: 35.14, level: 'dark' }), observation({ id: 'bright', lat: 35.15, level: 'bright' }), observation({ id: 'conflict-a', lat: 35.16, level: 'bright' }), observation({ id: 'conflict-b', lat: 35.16, level: 'dark' }), observation({ id: 'unknown', lat: 35.17, level: 'unknown', lux: 0, instrument: '계측기' })];
  const result = C.evaluateObservations(records, [], { now: now + 5000, minute: 1260, weak: .3, baseAt: r => r.id === 'dark' ? .7 : .1 });
  assert.equal(result.counts.compared, 2); assert.equal(result.counts.baseMissedDark, 1); assert.equal(result.counts.baseWeakButBright, 1);
  assert.equal(result.excluded.filter(r => r.reason === 'conflict').length, 2); assert.equal(result.excluded.filter(r => r.reason === 'unknown_observation').length, 1);
});

test('run archive preserves every candidate and record version, rejects truncation and explicit limits', async () => {
  const run = await runData(137), rows = JSON.parse(run.candidatesJson), versions = JSON.parse(run.inputVersionsJson);
  assert.equal(run.candidateCount, 137); assert.equal(rows.length, 137); assert.equal(versions.registry.length, run.registryCount); assert.equal(versions.context.length, run.contextCount);
  assert.equal(run.payloadBytes, C.bytes(Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'payloadBytes'))));
  assert.throws(() => C.normalizeRun({ ...run, candidateCount: 140 }), /일치/);
  assert.throws(() => C.normalizeRun({ ...run, payloadBytes: run.payloadBytes - 1 }), /크기/);
  assert.throws(() => C.normalizeRun({ ...run, candidatesJson: ' '.repeat(300001) }), { code: 'resource-exhausted' });
});

test('UTF-8 archive byte limit is enforced independently from JSON character limits', async () => {
  const run = await runData(); delete run.payloadBytes;
  const c = JSON.parse(run.candidatesJson)[0]; c.title = '한'.repeat(205000);
  assert.throws(() => C.normalizeRun({ ...run, candidatesJson: JSON.stringify([c]) }), { code: 'resource-exhausted' });
});
