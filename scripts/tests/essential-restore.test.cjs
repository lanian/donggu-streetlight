const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../functions/restore-core');
const meta = { schemaVersion: 1, createdAt: 1000, createdBy: 'admin', updatedAt: 1000, updatedBy: 'admin', revision: 1, operationId: 'op' };
const cabinet = { ...meta, code: 'C1', label: '1분전함', dong: '동명동', lat: null, lng: null, note: '', disabled: false };
const circuit = { ...meta, cabinetId: 'cab', code: 'L1', label: '1회로', note: '', disabled: false };
const link = { ...meta, lightId: 'p1', cabinetId: 'cab', circuitId: 'circuit', confirmationNote: '대장 확인' };
const replacement = { ...meta, lightId: 'p1', component: 'lamp', replacedAt: 900, manufacturer: '제조사', model: '모델', warrantyEnd: 2000, workId: '', note: '' };
const incident = { ...meta, title: '구간 소등', cabinetId: 'cab', circuitId: 'circuit', lightIds: ['p1'], reportIds: [], workIds: [], confirmedLightIds: [], status: 'open', note: '', resolutionNote: '' };
const plan = { schemaVersion: 1, title: '월간 확인', description: '', type: '재점검', priority: '보통', assignedTo: 'admin', intervalDays: 30, completionDays:1, startAt: 1000, nextAt: 1000, lightIds: ['p1'], enabled: true, createdAt: 1000, createdBy: 'admin', updatedAt: 1000, updatedBy: 'admin', revision: 1 };
const fixtures = { cabinets: cabinet, circuits: circuit, assetLinks: link, outageIncidents: incident, assetReplacements: replacement, preventivePlans: plan,
  preventiveRuns: { schemaVersion: 1, planId: 'plan', scheduledAt: 1000, lightId: 'p1', workId: 'work', carried: false, createdAt: 1000, createdBy: 'admin', operationId: 'p-op' },
  preventiveOperations: { schemaVersion: 1, planId: 'plan', by: 'admin', at: 1000, action: 'generate', recordIds: ['run'], revision:1, requestHash: 'a'.repeat(64) },
  assetOperations: { schemaVersion: 1, entity: 'cabinet', recordId: 'cab', by: 'admin', at: 1000, revision: 1, requestHash: 'a'.repeat(64), snapshot: cabinet } };

for (const [collection, record] of Object.entries(fixtures)) test(collection + ' is included in operational backup and validated without weakening unknown-field checks', () => {
  assert.ok(R.PRIMARY.includes(collection)); assert.doesNotThrow(() => R.validate(collection, record));
  assert.throws(() => R.validate(collection, { ...record, injected: true }));
});
test('topology restore rejects invalid parent relations and preserves immutable replacement history', () => {
  const cb={...cabinet,operationId:'cab-op'},cc={...circuit,operationId:'circuit-op'},cl={...link,operationId:'link-op'};
  const receipt=(id,entity,recordId,snapshot)=>({id,schemaVersion:1,entity,recordId,by:'admin',at:1000,revision:1,requestHash:'a'.repeat(64),snapshot});
  const collections = { cabinets: [{ id: 'cab', ...cb }], circuits: [{ id: 'circuit', ...cc }], assetLinks: [{ id: 'p1', ...cl }], assetOperations:[receipt('cab-op','cabinet','cab',cb),receipt('circuit-op','circuit','circuit',cc),receipt('link-op','link','p1',cl)] };
  const payload = { operationId: 'restore-essential', overwrite: false, collections };
  assert.doesNotThrow(() => R.validateGraph(R.normalize(payload), new Map()));
  const bad = structuredClone(payload); bad.collections.assetLinks[0].cabinetId = 'other';
  assert.throws(() => R.validateGraph(R.normalize(bad), new Map()), { code: 'failed-precondition' });
  assert.ok(R.IMMUTABLE.has('assetReplacements')); assert.ok(R.IMMUTABLE.has('preventiveRuns'));
});
test('replacement and recurrence payloads reject malformed values', () => {
  for (const patch of [{ replacedAt: 0 }, { warrantyEnd: 1 }, { component: 'invented' }]) assert.throws(() => R.validate('assetReplacements', { ...replacement, ...patch }));
  assert.throws(() => R.validate('preventivePlans', { ...plan, intervalDays: 0 }));
  assert.throws(() => R.validate('preventivePlans', { ...plan, lightIds: ['p1', 'p1'] }));
  assert.throws(() => R.validate('preventiveRuns', { ...fixtures.preventiveRuns, carried: 'yes' }));
});

test('asset restore enforces the same editable text limits and dates as the client records', () => {
  const cases = [
    ['cabinets', cabinet, 'label', 100], ['cabinets', cabinet, 'note', 1000],
    ['circuits', circuit, 'label', 100], ['circuits', circuit, 'note', 1000],
    ['outageIncidents', incident, 'title', 120], ['outageIncidents', incident, 'note', 1500],
    ['outageIncidents', { ...incident, status: 'resolved', confirmedLightIds: ['p1'], resolutionNote: '완료' }, 'resolutionNote', 1000],
    ['assetReplacements', replacement, 'manufacturer', 100], ['assetReplacements', replacement, 'model', 100], ['assetReplacements', replacement, 'note', 1000]
  ];
  for (const [collection, record, field, max] of cases) {
    assert.doesNotThrow(() => R.validate(collection, { ...record, [field]: '가'.repeat(max) }), collection + '/' + field + ' boundary');
    assert.throws(() => R.validate(collection, { ...record, [field]: '가'.repeat(max + 1) }), collection + '/' + field + ' overflow');
  }
  assert.throws(() => R.validate('cabinets', { ...cabinet, createdAt: 8640000000000001, updatedAt: 8640000000000001 }));
  assert.throws(() => R.validate('assetReplacements', { ...replacement, warrantyEnd: 8640000000000001 }));
});

test('asset restore rejects client-invalid parent pairs, open resolutions, other components and identifiers', () => {
  for (const patch of [{ cabinetId: 'cab', circuitId: '' }, { cabinetId: '', circuitId: 'circuit' }, { cabinetId: null, circuitId: null }, { resolutionNote: '아직 완료하지 않음' }]) {
    assert.throws(() => R.validate('outageIncidents', { ...incident, ...patch }));
  }
  assert.throws(() => R.validate('assetLinks', { ...link, cabinetId: null, circuitId: null }));
  assert.throws(() => R.validate('assetReplacements', { ...replacement, component: 'other', note: ' ' }));
  assert.throws(() => R.validate('assetReplacements', { ...replacement, workId: null }));
  for (const value of ['__proto__', 'p.with.dot', 'p 한글']) assert.throws(() => R.validate('assetLinks', { ...link, lightId: value }));
  assert.throws(() => R.validate('cabinets', { ...cabinet, note: '숨은\u0000문자' }));
  assert.throws(() => R.validate('assetOperations', { ...fixtures.assetOperations, snapshot: { ...cabinet, label: '가'.repeat(101) } }));
});

test('historical asset receipts retain their own operation ID and immutable circuit parent', () => {
  const latest = { ...circuit, revision: 2, operationId: 'latest-op', updatedAt: 2000 };
  const receipt = (operationId, snapshot) => ({ id: operationId, schemaVersion: 1, entity: 'circuit', recordId: 'circuit', by: snapshot.updatedBy, at: snapshot.updatedAt, revision: snapshot.revision, requestHash: 'a'.repeat(64), snapshot });
  const collections = { circuits: [{ id: 'circuit', ...latest }], assetOperations: [receipt('latest-op', latest), receipt('old-op', { ...circuit, operationId: 'wrong-op' })] };
  const current = new Map([['cabinets/cab', cabinet]]);
  const restore = () => R.validateGraph(R.normalize({ operationId: 'restore-receipts', overwrite: false, collections }), current);
  assert.throws(restore, { code: 'failed-precondition' });
  collections.assetOperations[1].snapshot.operationId = 'old-op';
  assert.doesNotThrow(restore);
  collections.assetOperations[1].snapshot.cabinetId = 'different-cabinet';
  assert.throws(restore, { code: 'failed-precondition' });
});

test('preventive restore retains client target and assignee bounds and command receipt shapes', () => {
  assert.doesNotThrow(() => R.validate('preventivePlans', { ...plan, assignedTo: 'a'.repeat(180) }));
  assert.throws(() => R.validate('preventivePlans', { ...plan, assignedTo: 'a'.repeat(181) }));
  assert.throws(() => R.validate('preventivePlans', { ...plan, lightIds: ['__proto__'] }));
  for (const patch of [{ action: 'generate', recordIds: [] }, { action: 'advance', recordIds: ['run'] }, { action: 'save', recordIds: [] }, { action: 'save', recordIds: ['different-plan'] }]) {
    assert.throws(() => R.validate('preventiveOperations', { ...fixtures.preventiveOperations, ...patch }));
  }
  assert.doesNotThrow(() => R.validate('preventiveOperations', { ...fixtures.preventiveOperations, action: 'save', recordIds: ['plan'] }));
  assert.doesNotThrow(() => R.validate('preventiveOperations', { ...fixtures.preventiveOperations, action: 'advance', recordIds: [] }));
  assert.throws(() => R.validate('preventiveRuns', { ...fixtures.preventiveRuns, scheduledAt: 1001 }));
});
module.exports = { fixtures };

test('work acknowledgement and hold metadata survive restore with invalid values rejected', () => {
  const C=require('../../app/operations-core');
  const work=C.createOrder({title:'수리',workflowVersion:2,assignedTo:'admin'},{id:'p1',code:'1'},'admin',1000);
  assert.doesNotThrow(()=>R.validate('workOrders',work));
  assert.throws(()=>R.validate('workOrders',{...work,acknowledgedAt:-1}));
  assert.throws(()=>R.validate('workOrders',{...work,hold:{reason:'madeup',note:'대기',nextAt:2000,nextAction:'확인',since:1000,by:'admin'}}));
});

test('restore roundtrips client-produced holds and rejects contradictory acknowledgement metadata', () => {
  const C = require('../../app/operations-core');
  const work = C.createOrder({ title: '수리', workflowVersion: 2, assignedTo: 'admin' }, { id: 'p1', code: '1' }, 'admin', 1000);
  const held = C.workProcess(work, 'hold', { expectedRevision: 1, reason: 'material', note: '', nextAt: 3000, nextAction: '자재 확인' }, 'admin', true, 2000);
  assert.doesNotThrow(() => R.validate('workOrders', held));
  assert.throws(() => R.validate('workOrders', { ...held, hold: { ...held.hold, reason: 'other' } }));
  assert.throws(() => R.validate('workOrders', { ...held, hold: { ...held.hold, nextAt: held.hold.since } }));
  for (const patch of [{ acknowledgedAt: 0, acknowledgedBy: 'admin' }, { acknowledgedAt: undefined, acknowledgedBy: 'admin' }, { acknowledgedAt: 1001, acknowledgedBy: 'other' }, { acknowledgedAt: 3000, acknowledgedBy: 'admin' }]) {
    const malformed = { ...work, ...patch }; if (malformed.acknowledgedAt === undefined) delete malformed.acknowledgedAt;
    assert.throws(() => R.validate('workOrders', malformed));
  }
});
test('typed inspection measurements and complete response claims are verified during restore', () => {
  const record={lightId:'p1',inspector:'admin',date:1000,checks:{lamp:'uninspected',flicker:'ok',fixture:'ok',pole:'ok',base:'ok',cabinet:'ok',leak:'ok',tree:'ok'},checkReasons:{lamp:'주간'},result:'점검필요',inspectionComplete:false,readings:[{kind:'leakageCurrent',value:1,unit:'mA',at:1000,by:'admin'}]};
  assert.doesNotThrow(()=>R.validate('inspections',record));
  assert.throws(()=>R.validate('inspections',{...record,inspectionComplete:true}));
  assert.throws(()=>R.validate('inspections',{...record,readings:[{...record.readings[0],unit:'MΩ'}]}));
});

test('typed inspection restore preserves core verdicts and rejects incompatible fault severity claims', () => {
  const I = require('../../app/inspection-core'), codes = ['lamp', 'flicker', 'fixture', 'pole', 'base', 'cabinet', 'leak', 'tree'];
  const source = { checks: Object.fromEntries(codes.map(key => [key, 'ok'])), result: '정상', readings: [] };
  const record = { lightId: 'p1', inspector: 'admin', date: 1000, ...I.prepare(source, codes, 'admin', 1000) };
  assert.doesNotThrow(() => R.validate('inspections', record));
  for (const [key, result] of [['flicker', '정상'], ['lamp', '점검필요'], ['leak', '수리중']]) {
    assert.throws(() => R.validate('inspections', { ...record, checks: { ...record.checks, [key]: 'bad' }, result }));
  }
  const legacy = { lightId: 'p1', inspector: 'admin', date: 1000, checks: { lamp: 'bad' }, result: '정상' };
  assert.doesNotThrow(() => R.validate('inspections', legacy));
});

test('real topology, replacement and recurring work commands produce a restorable complete graph', async () => {
  const D=require('../../app/data'),A=require('../../app/asset-maintenance-commands'),P=require('../../app/preventive-commands');let json='{}';
  const db=D.createLocalDB({storage:{getItem:()=>json,setItem:(_,value)=>json=value},indexedDB:null,locks:{request:(_,fn)=>Promise.resolve().then(fn)}});
  const context={db,user:'local',admin:true,byId:id=>({id,code:id})};
  for(const [entity,recordId,data] of [['cabinet','cab',cabinet],['circuit','circuit',circuit],['link','p1',link],['replacement','replacement',replacement]]){
    const input={...data};for(const key of Object.keys(meta))delete input[key];
    await A.execute({id:'asset-'+entity,entity,recordId,expectedRevision:0,data:input,actor:'local',at:1000},context);
  }
  const input={...plan};for(const key of ['schemaVersion','nextAt','createdAt','createdBy','updatedAt','updatedBy','revision'])delete input[key];
  await P.execute({id:'plan-create',kind:'save',planId:'monthly',expectedRevision:0,data:input,actor:'local',at:1000},context);
  await P.execute({id:'plan-cycle',kind:'generate',planId:'monthly',expectedRevision:1,scheduledAt:1000,targets:[{light:{id:'p1',code:'1'}}],actor:'local',at:2000},context);
  const collections=Object.fromEntries(Object.entries(JSON.parse(json)).map(([name,rows])=>[name,Object.entries(rows).map(([id,data])=>({id,...data}))]));
  const normalized=R.normalize({operationId:'restore-real-essential',overwrite:false,collections});
  assert.doesNotThrow(()=>R.validateGraph(normalized,new Map()));
  const malformed=structuredClone(collections);malformed.assetReplacements[0].workId=malformed.workOrders[0].id;malformed.assetReplacements[0].lightId='another';
  assert.throws(()=>R.validateGraph(R.normalize({operationId:'restore-bad',overwrite:false,collections:malformed}),new Map()),{code:'failed-precondition'});
});

function inspectionProofFixture() {
  const I = require('../../app/inspection-core'), codes = ['lamp','flicker','fixture','pole','base','cabinet','leak','tree'];
  const readings = Array.from({ length: 10 }, (_, index) => ({ kind: index % 2 ? 'leakageCurrent' : 'insulationResistance', value: index + 1, unit: index % 2 ? 'mA' : 'MΩ', at: 1000, by: 'admin' }));
  const parent = { lightId: 'p1', inspector: 'admin', date: 1000, ...I.prepare({ checks: Object.fromEntries(codes.map(key => [key, 'ok'])), result: '정상', readings }, codes, 'admin', 1000), thumbs: [{ id: 'inspection-photo', t: 'data:image/jpeg;base64,dGVzdA==' }] };
  const proof = I.proof('inspection-1', parent);
  const photo = { lightId: 'p1', inspId: 'inspection-1', kind: 'inspection', by: 'admin', at: 1000, data: 'data:image/jpeg;base64,dGVzdA==' };
  const measurement = Object.fromEntries(['schemaVersion','inspectionId','lightId','date','inspector','readings'].map(key => [key, structuredClone(proof[key])]));
  return { parent, proof, photo, measurement };
}

test('inspection detail proofs are immutable primary records with an exact typed schema', () => {
  const { proof } = inspectionProofFixture();
  assert.ok(R.PRIMARY.includes('inspectionDetails')); assert.ok(R.IMMUTABLE.has('inspectionDetails'));
  assert.doesNotThrow(() => R.validate('inspectionDetails', proof));
  for (const mutate of [
    value => { value.injected = true; }, value => { value.schemaVersion = 2; }, value => { delete value.checkReasons; }, value => { value.checkReasons = null; },
    value => { value.readings[9].by = 'other'; }, value => { value.readings[9].unit = 'wrong'; }, value => { value.readings[9].value = -1; },
    value => { value.readings[9].injected = true; }, value => { value.readings[9].at = value.date + 300001; },
    value => { value.readings.push(value.readings[0]); }, value => { value.inspectionId = 'wrong/id'; }
  ]) { const malformed = structuredClone(proof); mutate(malformed); assert.throws(() => R.validate('inspectionDetails', malformed)); }
});

test('client restore includes standalone proof parents and their original photos in the atomic payload', () => {
  const client = require('../../app/restore'), { parent, proof, photo } = inspectionProofFixture();
  const backup = { app: 'donggu-streetlight', version: 2, collections: { inspectionDetails: [{ id: 'inspection-1', ...proof }], inspections: [{ id: 'inspection-1', ...parent }], photos: [{ id: 'inspection-photo', ...photo }] } };
  const payload = client.buildPayload(backup, { operationId: 'restore-proof' });
  assert.ok(payload); assert.equal(payload.collections.inspectionDetails.length, 1); assert.equal(payload.collections.inspections.length, 1); assert.equal(payload.collections.photos.length, 1);
  const normalized = R.normalize(payload);
  assert.ok(R.references(normalized.entries).includes('inspections/inspection-1'));
  assert.ok(R.references(normalized.entries).includes('photos/inspection-photo'));
  assert.doesNotThrow(() => R.validateGraph(normalized, new Map()));
  const missing = structuredClone(payload); missing.collections.photos = [];
  assert.throws(() => R.validateGraph(R.normalize(missing), new Map()), { code: 'failed-precondition' });
  const current = new Map([['inspectionDetails/inspection-1', { ...proof, result: '점검필요' }]]);
  assert.throws(() => R.validateGraph(normalized, current), { code: 'already-exists' });
});

test('standalone inspection proofs require the exact parent identity, extensions and photo graph', () => {
  const { parent, proof, photo } = inspectionProofFixture();
  const current = new Map([['inspections/inspection-1', parent], ['photos/inspection-photo', photo]]);
  const restore = (value = proof, id = 'inspection-1', data = current) => R.validateGraph(R.normalize({ operationId: 'restore-standalone-proof', overwrite: false, collections: { inspectionDetails: [{ id, ...value }] } }), data);
  assert.doesNotThrow(() => restore());
  assert.throws(() => restore(proof, 'different-id'), { code: 'failed-precondition' });
  for (const patch of [{ lightId: 'p2' }, { date: 1001 }, { inspector: 'other', readings: proof.readings.map(row => ({ ...row, by: 'other' })) }, { readings: proof.readings.map(row => ({ ...row, value: row.value + 1 })) },
    { checkReasons: { fixture: '다른 상세 사유' } }, { checks: { ...proof.checks, fixture: 'na' }, checkReasons: { fixture: '해당 없음' } },
    { checks: { ...proof.checks, fixture: 'uninspected' }, checkReasons: { fixture: '미실시' }, inspectionComplete: false, result: '점검필요' }, { result: '점검필요' }]) {
    assert.throws(() => restore({ ...proof, ...patch }), { code: 'failed-precondition' });
  }
  assert.throws(() => restore(proof, 'inspection-1', new Map()), { code: 'failed-precondition' });
  assert.throws(() => restore(proof, 'inspection-1', new Map([['inspections/inspection-1', parent]])), { code: 'failed-precondition' });
  assert.throws(() => restore(proof, 'inspection-1', new Map([['inspections/inspection-1', parent], ['photos/inspection-photo', { ...photo, inspId: 'another' }]])), { code: 'failed-precondition' });
});

test('typed main inspections remain restorable without a proof but an existing proof must match', () => {
  const { parent, proof, photo } = inspectionProofFixture();
  const payload = { operationId: 'restore-compatible-inspection', overwrite: false, collections: { preventivePlans: [{ id: 'plan', ...plan }], inspections: [{ id: 'inspection-1', ...parent }], photos: [{ id: 'inspection-photo', ...photo }] } };
  const normalized = R.normalize(payload);
  assert.doesNotThrow(() => R.validateGraph(normalized, new Map()));
  assert.ok(R.references(normalized.entries).includes('inspectionDetails/inspection-1'));
  assert.doesNotThrow(() => R.validateGraph(normalized, new Map([['inspectionDetails/inspection-1', proof]])));
  assert.throws(() => R.validateGraph(normalized, new Map([['inspectionDetails/inspection-1', { ...proof, result: '점검필요' }]])), { code: 'failed-precondition' });
});

test('inspection measurement receipts are immutable exact six-field records with one to ten typed readings', () => {
  const { measurement } = inspectionProofFixture();
  assert.ok(R.PRIMARY.includes('inspectionMeasurements')); assert.ok(R.IMMUTABLE.has('inspectionMeasurements'));
  assert.doesNotThrow(() => R.validate('inspectionMeasurements', measurement));
  assert.doesNotThrow(() => R.validate('inspectionMeasurements', { ...measurement, readings: measurement.readings.slice(0, 1) }));
  for (const mutate of [
    value => { value.injected = true; }, value => { delete value.inspectionId; }, value => { value.schemaVersion = 2; },
    value => { value.readings = []; }, value => { value.readings.push(value.readings[0]); }, value => { value.readings[9].by = 'other'; },
    value => { value.readings[9].unit = 'wrong'; }, value => { value.readings[9].at = value.date + 300001; }, value => { value.readings[9].injected = true; }
  ]) { const malformed = structuredClone(measurement); mutate(malformed); assert.throws(() => R.validate('inspectionMeasurements', malformed)); }
});

test('client restore carries measurement receipts through detail, main and original-photo dependencies', () => {
  const client = require('../../app/restore'), { parent, proof, photo, measurement } = inspectionProofFixture();
  const payload = client.buildPayload({ collections: { inspectionMeasurements: [{ id: 'inspection-1', ...measurement }], inspectionDetails: [{ id: 'inspection-1', ...proof }], inspections: [{ id: 'inspection-1', ...parent }], photos: [{ id: 'inspection-photo', ...photo }] } }, { operationId: 'restore-measurements' });
  assert.ok(payload.collections.inspectionMeasurements); assert.ok(payload.collections.inspectionDetails); assert.ok(payload.collections.inspections); assert.ok(payload.collections.photos);
  const normalized = R.normalize(payload);
  assert.ok(R.references(normalized.entries).includes('inspectionDetails/inspection-1'));
  assert.doesNotThrow(() => R.validateGraph(normalized, new Map()));
  const againstExistingProof = structuredClone(payload); delete againstExistingProof.collections.inspectionDetails;
  const childPayload = client.buildPayload(againstExistingProof, { operationId: 'restore-existing-proof-measurement' });
  assert.ok(childPayload.collections.inspections); assert.ok(childPayload.collections.photos);
  assert.doesNotThrow(() => R.validateGraph(R.normalize(childPayload), new Map([['inspectionDetails/inspection-1', proof]])));
  const current = new Map([['inspectionMeasurements/inspection-1', { ...measurement, readings: measurement.readings.slice(0, 1) }]]);
  assert.throws(() => R.validateGraph(normalized, current), { code: 'already-exists' });
});

test('standalone measurement receipts require the same detail identity, readings and complete parent photo graph', () => {
  const { parent, proof, photo, measurement } = inspectionProofFixture();
  const current = new Map([['inspectionDetails/inspection-1', proof], ['inspections/inspection-1', parent], ['photos/inspection-photo', photo]]);
  const restore = (value = measurement, id = 'inspection-1', data = current) => R.validateGraph(R.normalize({ operationId: 'restore-measurement-only', overwrite: false, collections: { inspectionMeasurements: [{ id, ...value }] } }), data);
  assert.doesNotThrow(() => restore());
  assert.throws(() => restore(measurement, 'different-id'), { code: 'failed-precondition' });
  for (const patch of [{ lightId: 'p2' }, { date: 1001 }, { inspector: 'other', readings: measurement.readings.map(row => ({ ...row, by: 'other' })) }, { readings: measurement.readings.map(row => ({ ...row, value: row.value + 1 })) }]) {
    assert.throws(() => restore({ ...measurement, ...patch }), { code: 'failed-precondition' });
  }
  for (const missing of ['inspectionDetails/inspection-1', 'inspections/inspection-1', 'photos/inspection-photo']) {
    const incomplete = new Map(current); incomplete.delete(missing); assert.throws(() => restore(measurement, 'inspection-1', incomplete), { code: 'failed-precondition' });
  }
  const proofPlan = R.normalize({ operationId: 'restore-proof-with-existing-measurement', overwrite: false, collections: { inspectionDetails: [{ id: 'inspection-1', ...proof }] } });
  assert.ok(R.references(proofPlan.entries).includes('inspectionMeasurements/inspection-1'));
  assert.doesNotThrow(() => R.validateGraph(proofPlan, current));
  const contradictory = new Map(current); contradictory.set('inspectionMeasurements/inspection-1', { ...measurement, readings: measurement.readings.slice(0, 1) });
  assert.throws(() => R.validateGraph(proofPlan, contradictory), { code: 'failed-precondition' });
});
