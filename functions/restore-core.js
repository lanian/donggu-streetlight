'use strict';
const crypto = require('node:crypto');
const { InputError } = require('./core');
const MAX_DOCUMENTS = 200, MAX_BYTES = 4 * 1024 * 1024;
const PRIMARY = ['workOrders', 'workEvents', 'inventory', 'inventoryMoves', 'reportEvents', 'lightingTasks', 'lightingRuns'];
const DEPENDENCIES = ['photos', 'reports', 'inspections', 'lightingContext'];
const IMMUTABLE = new Set(['workEvents', 'inventoryMoves', 'reportEvents', 'lightingRuns']);
const STATES = ['draft', 'assigned', 'in_progress', 'completed', 'verified', 'cancelled'];
const fail = (message, code = 'invalid-argument') => { throw new InputError(message, code); };
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (value && typeof value.toMillis === 'function') return canonical({ __timestamp: value.toMillis() });
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  fail('복원 자료에 지원하지 않는 값이 있어요.');
}
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
function text(value, max, required = false) { if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('복원 문자열 형식이나 길이를 확인해 주세요.'); return value; }
function id(value) { text(value, 180, true); if (value.includes('/') || value === '.' || value === '..' || /[\u0000-\u001f]/.test(value)) fail('복원 문서 ID를 확인해 주세요.'); return value; }
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('복원 정수 값이 범위를 벗어났어요.'); return value; }
function number(value, min, max) { if (!Number.isFinite(value) || value < min || value > max) fail('복원 수치가 범위를 벗어났어요.'); return value; }
function choice(value, values) { if (!values.includes(value)) fail('복원 상태 또는 종류가 올바르지 않아요.'); return value; }
function ids(values, max) { if (!Array.isArray(values) || values.length > max || new Set(values).size !== values.length) fail('복원 연결 목록을 확인해 주세요.'); values.forEach(id); return values; }
function keys(value, allowed, required = []) { if (!plain(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !(k in value))) fail('복원 문서 필드가 올바르지 않아요.'); }
function optionalText(d, k, max) { if (d[k] !== undefined) text(d[k], max); }
function digest(value) { if (!/^[a-f0-9]{64}$/.test(value)) fail('복원 자료 해시가 올바르지 않아요.'); }
function meta(d, run = false) {
  if (d.schemaVersion !== 1) fail('지원하지 않는 복원 스키마입니다.');
  integer(d.createdAt, 1); integer(d.updatedAt, d.createdAt); text(d.createdBy, 128, true); text(d.updatedBy, 128, true);
  integer(d.revision, 1); id(d.operationId);
  if (run && (d.revision !== 1 || d.updatedAt !== d.createdAt || d.updatedBy !== d.createdBy)) fail('검토 실행 이력은 최초 기록만 복원할 수 있어요.');
}
function validate(collection, d) {
  if (!plain(d)) fail('복원 문서는 객체여야 해요.');
  // Restrict nested objects too: no functions, undefined, non-finite numbers or prototype keys.
  const inspect = (v, depth = 0) => { if (depth > 20) fail('복원 자료가 너무 깊어요.'); if (v && typeof v === 'object') { if (!Array.isArray(v) && !plain(v)) fail('복원 객체 형식을 확인해 주세요.'); for (const k of Object.keys(v)) { if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('허용되지 않은 복원 필드입니다.'); inspect(v[k], depth + 1); } } else canonical(v); };
  inspect(d);
  if (Buffer.byteLength(canonical(d)) > 950000) fail('개별 복원 문서가 너무 커요.');
  if (collection === 'workOrders') {
    keys(d, ['schemaVersion','lightId','code','dong','title','description','type','priority','status','assignedTo','dueAt','createdAt','createdBy','updatedAt','updatedBy','revision','reportIds','inspectionIds','beforePhotos','afterPhotos','completionNote','completedAt','completedBy','verificationNote','verifiedAt','verifiedBy','parts','costTotal','measurements','stockApplied','accountedCost'], ['schemaVersion','lightId','title','type','priority','status','assignedTo','createdAt','createdBy','updatedAt','updatedBy','revision','reportIds','inspectionIds','beforePhotos','afterPhotos','parts','costTotal','measurements']);
    if (d.schemaVersion !== 1) fail('작업 스키마를 확인해 주세요.'); id(d.lightId); text(d.title, 200, true); text(d.createdBy, 128, true); text(d.updatedBy, 128, true); text(d.assignedTo, 128);
    integer(d.createdAt, 1); integer(d.updatedAt, d.createdAt); integer(d.revision, 1); integer(d.dueAt);
    choice(d.status, STATES); choice(d.type, ['수리','재점검','신설검토','철거','기타']); choice(d.priority, ['긴급','높음','보통','낮음']);
    ids(d.reportIds, 20); ids(d.inspectionIds, 50); ids(d.beforePhotos, 6); ids(d.afterPhotos, 6);
    for (const k of ['description','completionNote','verificationNote']) optionalText(d, k, 2000);
    optionalText(d, 'code', 200); optionalText(d, 'dong', 80);
    number(d.costTotal, 0, 1000000000000000); number(d.accountedCost || 0, 0, 1000000000000000);
    if (!Array.isArray(d.parts) || d.parts.length > 30 || !Array.isArray(d.measurements) || d.measurements.length > 100) fail('자재·실측 목록을 확인해 주세요.');
    d.parts.forEach(p => { keys(p, ['name','qty','unitCost','inventoryId'], ['name','qty','unitCost']); text(p.name, 120, true); number(p.qty, 0.001, 100000000); number(p.unitCost, 0, 1000000000); if (p.inventoryId) id(p.inventoryId); });
    if (Math.round(d.parts.reduce((s,p) => s + p.qty * p.unitCost, 0)) !== d.costTotal) fail('작업 자재비가 자재 내역과 일치하지 않아요.');
    d.measurements.forEach(m => { keys(m, ['lux','at','by','note'], ['lux','at','by','note']); number(m.lux, 0, 200000); integer(m.at, 1); text(m.by, 128, true); text(m.note, 500); });
    if (!plain(d.stockApplied || {}) || Object.keys(d.stockApplied || {}).length > 30) fail('작업 재고 반영 내역을 확인해 주세요.');
    for (const [k,v] of Object.entries(d.stockApplied || {})) { id(k); number(v, 0, 100000000); }
    for (const k of ['completedAt','verifiedAt']) if (d[k] !== undefined) integer(d[k]);
    for (const k of ['completedBy','verifiedBy']) optionalText(d, k, 128);
    if (['completed','verified'].includes(d.status) && (!d.afterPhotos.length || !d.completedBy || !d.completedAt)) fail('완료 작업의 사진과 처리자를 확인해 주세요.');
    if (d.status === 'verified' && (!d.verifiedBy || !d.verifiedAt || Math.abs((d.accountedCost || 0) - d.costTotal) > 0.01)) fail('검수 완료 작업의 인정 비용과 검수자를 확인해 주세요.');
  } else if (collection === 'workEvents') {
    keys(d, ['workId','lightId','fromStatus','toStatus','type','note','at','by','revision','createdAt','costTotal','costDelta','requestHash'], ['workId','lightId','fromStatus','toStatus','type','note','at','by','revision']);
    id(d.workId); id(d.lightId); choice(d.fromStatus, ['', ...STATES]); choice(d.toStatus, STATES); text(d.type, 80, true); text(d.note, 2000); text(d.by, 128, true); integer(d.at, 1); integer(d.revision, 1);
    if (d.createdAt !== undefined) integer(d.createdAt, 1); if (d.costTotal !== undefined) number(d.costTotal, 0, 1000000000000000); if (d.costDelta !== undefined) number(d.costDelta, -1000000000000000, 1000000000000000); if (d.requestHash !== undefined) digest(d.requestHash);
  } else if (collection === 'inventory') {
    keys(d, ['name','unit','quantity','unitCost','revision','updatedAt','updatedBy'], ['name','unit','quantity','unitCost','revision','updatedAt','updatedBy']);
    text(d.name, 120, true); text(d.unit, 40, true); number(d.quantity, 0, 100000000); number(d.unitCost, 0, 1000000000); integer(d.revision, 1); integer(d.updatedAt, 1); text(d.updatedBy, 128, true);
  } else if (collection === 'inventoryMoves') {
    keys(d, ['itemId','delta','reason','at','by','revision','workId'], ['itemId','delta','reason','at','by','revision']);
    id(d.itemId); number(d.delta, -100000000, 100000000); text(d.reason, 500); integer(d.at, 1); text(d.by, 128, true); integer(d.revision, 1); if (d.workId) id(d.workId);
  } else if (collection === 'reportEvents') {
    keys(d, ['schemaVersion','type','reportId','fromLightId','toLightId','reason','by','at','revision','requestHash'], ['schemaVersion','type','reportId','fromLightId','toLightId','reason','by','at','revision','requestHash']);
    if (d.schemaVersion !== 1 || d.type !== 'facility-linked') fail('신고 연결 이력 형식을 확인해 주세요.'); id(d.reportId); if (d.fromLightId) id(d.fromLightId); id(d.toLightId); text(d.reason, 500, true); text(d.by, 128, true); integer(d.at, 1); integer(d.revision, 1); digest(d.requestHash);
  } else if (collection === 'photos') {
    id(d.lightId); text(d.by, 128, true); text(d.data, 900000, true); if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d.data)) fail('복원 사진 데이터가 올바르지 않아요.'); if (d.workId) id(d.workId); integer(d.at, 1);
  } else if (collection === 'reports') {
    choice(d.status, ['접수','처리중','완료']); if (d.lightId) id(d.lightId); if (d.workId) id(d.workId); integer(d.createdAt, 1); if (d.updatedAt !== undefined) integer(d.updatedAt, 1); if (d.linkRevision !== undefined) integer(d.linkRevision, 1); if (d.linkEventId) id(d.linkEventId);
  } else if (collection === 'inspections') {
    id(d.lightId); text(d.inspector,128,true); integer(d.date,1); choice(d.result,['정상','점검필요','고장','수리중']);
    if (d.thumbs !== undefined) { if (!Array.isArray(d.thumbs)||d.thumbs.length>6) fail('점검 사진 목록을 확인해 주세요.'); for(const t of d.thumbs){id(t.id);text(t.t,900000,true);if(!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(t.t))fail('점검 썸네일이 올바르지 않아요.');} }
  } else if (collection === 'lightingContext') {
    keys(d,['schemaVersion','kind','label','category','operator','lat','lng','radius','strength','status','level','schedule','startMinute','endMinute','observedAt','validDays','nightConfirmed','lux','instrument','note','linkedLightId','distinct','removed','createdAt','createdBy','updatedAt','updatedBy','revision','operationId','sourceAgency','sourceRecordId','sourceDataset','sourceUpdatedAt','importedAt','importBatchId','originKind','originId','originPointId','positionAccuracy']);
    meta(d);choice(d.kind,['source','observation']);text(d.label,100,true);text(d.operator,100);choice(d.category,['other_public','private','shop','building','unknown','field']);number(d.lat,-90,90);number(d.lng,-180,180);number(d.radius,5,d.kind==='source'?80:30);choice(d.strength,['low','medium','high']);choice(d.status,['on','off','unknown']);choice(d.level,['bright','adequate','dark','unknown']);choice(d.schedule,['always','hours','unknown']);integer(d.startMinute,0,1439);integer(d.endMinute,0,1439);if(d.schedule==='hours'&&d.startMinute===d.endMinute)fail('관찰 시간대를 확인해 주세요.');integer(d.observedAt,1);integer(d.validDays,1,365);for(const k of ['nightConfirmed','distinct','removed'])if(typeof d[k]!=='boolean')fail('관찰 확인 상태를 확인해 주세요.');if(d.lux!==null)number(d.lux,0,200000);text(d.instrument,100,d.lux!==null);text(d.note,1000);text(d.linkedLightId,180);
    const provenance=['sourceAgency','sourceRecordId','sourceDataset','sourceUpdatedAt','importedAt','importBatchId'];if(provenance.some(k=>k in d)){if(d.kind!=='source'||provenance.some(k=>!(k in d)))fail('외부 자료 출처 필드를 확인해 주세요.');text(d.sourceAgency,100,true);text(d.sourceRecordId,180,true);text(d.sourceDataset,300,true);integer(d.sourceUpdatedAt);integer(d.importedAt,1);id(d.importBatchId);}
    const origins=['originKind','originId','originPointId','positionAccuracy'];if(origins.some(k=>k in d)){if(d.kind!=='observation'||origins.some(k=>!(k in d)))fail('관찰 원본 연결을 확인해 주세요.');choice(d.originKind,['patrol','task']);text(d.originId,180,true);text(d.originPointId,180);number(d.positionAccuracy,0,10000);}
  } else if (collection === 'lightingTasks') {
    keys(d, ['schemaVersion','title','lat','lng','radius','note','originKind','originId','evidenceIds','assignedTo','dueAt','reviewMinute','status','observationId','completionNote','completedAt','completedBy','createdAt','createdBy','updatedAt','updatedBy','revision','operationId']);
    meta(d); text(d.title, 120, true); number(d.lat, -90, 90); number(d.lng, -180, 180); number(d.radius, 5, 80); text(d.note, 1500); choice(d.originKind, ['candidate','record','patrol','manual']); text(d.originId, 180); ids(d.evidenceIds, 20); text(d.assignedTo, 128, true); integer(d.dueAt, 1); integer(d.reviewMinute, 0, 1439); choice(d.status, ['open','completed','cancelled']); text(d.observationId, 180); text(d.completionNote, 1000); integer(d.completedAt); text(d.completedBy, 128);
    if (d.status === 'completed' ? !d.observationId || !d.completionNote.trim() || !d.completedAt || !d.completedBy : d.observationId || d.completedAt || d.completedBy) fail('재확인 업무의 완료 근거를 확인해 주세요.');
  } else if (collection === 'lightingRuns') {
    keys(d, ['schemaVersion','modelVersion','reviewedAt','minute','mode','dong','facilityKind','registryCount','contextCount','roadCount','candidateCount','inputDigest','inputVersionsJson','settingsJson','candidatesJson','evaluationJson','payloadBytes','createdAt','createdBy','updatedAt','updatedBy','revision','operationId']);
    meta(d, true); text(d.modelVersion, 64, true); integer(d.reviewedAt, 1); integer(d.minute, 0, 1439); choice(d.mode, ['roads','pairs']); text(d.dong, 80); text(d.facilityKind, 30); for (const k of ['registryCount','contextCount','roadCount','candidateCount']) integer(d[k], 0, 100000); digest(d.inputDigest);
    const parsed={};for (const [k,n] of [['inputVersionsJson',300000],['settingsJson',12000],['candidatesJson',300000],['evaluationJson',180000]]) { text(d[k],n,true); try { parsed[k]=JSON.parse(d[k]); } catch { fail('검토 이력의 JSON 근거가 올바르지 않아요.'); } }
    const versions=parsed.inputVersionsJson,candidates=parsed.candidatesJson,evaluation=parsed.evaluationJson;
    if(!plain(versions)||!plain(parsed.settingsJson)||!Array.isArray(versions.registry)||!Array.isArray(versions.context)||versions.registry.length!==d.registryCount||versions.context.length!==d.contextCount||!Array.isArray(candidates)||candidates.length!==d.candidateCount)fail('검토 실행의 전체 자료·후보 건수가 일치하지 않아요.');
    for(const tuple of [...versions.registry,...versions.context]){if(!Array.isArray(tuple)||typeof tuple[0]!=='string'||!tuple[0]||tuple[0].length>180)fail('검토 자료 버전을 확인해 주세요.');integer(tuple[1]);}
    for(const row of candidates){if(!plain(row)||typeof row.title!=='string')fail('검토 후보 형식을 확인해 주세요.');number(row.lat,-90,90);number(row.lng,-180,180);number(row.base,0,Number.MAX_VALUE);number(row.adjusted,row.base,Number.MAX_VALUE);}
    if(!plain(evaluation)||!Array.isArray(evaluation.rows)||!Array.isArray(evaluation.excluded)||!plain(evaluation.counts)||evaluation.rows.length!==evaluation.counts.compared)fail('현장 관찰 비교 결과가 완전하지 않아요.');
    const counts=evaluation.counts;for(const k of ['compared','baseMatched','adjustedMatched','baseMissedDark','adjustedMissedDark','baseWeakButBright','adjustedWeakButBright'])integer(counts[k]);
    if(counts.baseMatched+counts.baseMissedDark+counts.baseWeakButBright!==counts.compared||counts.adjustedMatched+counts.adjustedMissedDark+counts.adjustedWeakButBright!==counts.compared)fail('현장 비교 집계가 일치하지 않아요.');
    for(const row of evaluation.rows){if(!plain(row)||typeof row.id!=='string'||typeof row.label!=='string'||typeof row.baseMatch!=='boolean'||typeof row.adjustedMatch!=='boolean')fail('현장 비교 기록 형식을 확인해 주세요.');choice(row.level,['bright','adequate','dark']);number(row.base,0,Number.MAX_VALUE);number(row.adjusted,row.base,Number.MAX_VALUE);}
    for(const row of evaluation.excluded)if(!plain(row)||typeof row.id!=='string'||typeof row.label!=='string'||typeof row.reason!=='string')fail('현장 비교 제외 사유 형식을 확인해 주세요.');
    integer(d.payloadBytes, 1, 600000);
    const domain = Object.fromEntries(Object.entries(d).filter(([k]) => !['schemaVersion','payloadBytes','createdAt','createdBy','updatedAt','updatedBy','revision','operationId'].includes(k)));
    if (Buffer.byteLength(JSON.stringify(domain)) !== d.payloadBytes) fail('검토 이력의 기록 크기가 일치하지 않아요.');
  } else fail('지원하지 않는 복원 컬렉션입니다.');
  return d;
}
function normalize(input, bulk = false) {
  keys(input, ['operationId','collections','overwrite','source'], ['operationId','collections','overwrite']); id(input.operationId);
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(input.operationId) || typeof input.overwrite !== 'boolean' || !plain(input.collections)) fail('복원 계획 형식을 확인해 주세요.');
  const entries = [], seen = new Set();
  for (const [collection, rows] of Object.entries(input.collections)) {
    if (![...PRIMARY,...DEPENDENCIES].includes(collection) || !Array.isArray(rows)) fail('서버 복원 대상이 아닌 컬렉션입니다.');
    for (const row of rows) { if (!plain(row)) fail('복원 항목 형식을 확인해 주세요.'); const {id: recordId,...data} = row; const path = collection + '/' + id(recordId); if (seen.has(path)) fail('복원 문서 ID가 중복됐어요.'); seen.add(path); validate(collection, data); entries.push({path,collection,id:recordId,data}); }
  }
  entries.sort((a,b) => a.path.localeCompare(b.path));
  if (!entries.some(e => PRIMARY.includes(e.collection))) fail('복원할 업무 기록이 없어요.');
  if (!bulk && (entries.length > MAX_DOCUMENTS || Buffer.byteLength(canonical(input)) > MAX_BYTES)) fail('한 번의 원자 복원은 200문서·4MB까지입니다. 대량 이전 도구로 빈 업무 저장소에 복원해 주세요.', 'resource-exhausted');
  if (bulk && entries.length > 100000) fail('대량 이전은 100,000문서까지 지원합니다.', 'resource-exhausted');
  const source = input.source || {}; keys(source, ['app','version','at','mode']); if (source.app !== undefined) text(source.app,80); if (source.version !== undefined) integer(source.version,1,100); if (source.at !== undefined) integer(source.at); if (source.mode !== undefined) text(source.mode,40);
  return { operationId:input.operationId, entries, overwrite:input.overwrite, source, payloadHash:hash(input) };
}
function references(entries) {
  const paths = new Set();
  const add = (c,v) => { if (v) paths.add(c + '/' + id(v)); };
  for (const e of entries) { const d=e.data;
    if (e.collection === 'workOrders') { [...(d.beforePhotos||[]),...(d.afterPhotos||[])].forEach(v=>add('photos',v)); (d.reportIds||[]).forEach(v=>add('reports',v)); (d.inspectionIds||[]).forEach(v=>add('inspections',v)); Object.keys(d.stockApplied||{}).forEach(v=>add('inventory',v)); (d.parts||[]).forEach(p=>add('inventory',p.inventoryId)); }
    if (e.collection === 'workEvents' || e.collection === 'inventoryMoves' || e.collection === 'reports') add('workOrders',d.workId);
    if (e.collection === 'inventoryMoves') add('inventory',d.itemId);
    if (e.collection === 'reportEvents') add('reports',d.reportId);
    if (e.collection === 'inspections') for(const t of d.thumbs||[])add('photos',t.id);
    if (e.collection === 'lightingTasks' && d.status === 'completed') add('lightingContext',d.observationId);
  }
  return [...paths];
}
function materialize(plan, current) {
  const result = new Map(current), writes = [], counts = { restored:0, added:0, replaced:0, skipped:0 };
  for (const e of plan.entries) {
    const old=current.get(e.path);
    if (old && hash(old) === hash(e.data)) { counts.skipped++; continue; }
    if (old && IMMUTABLE.has(e.collection)) fail('기존 불변 이력과 복원 내용이 다릅니다: ' + e.path, 'already-exists');
    if (old && !plan.overwrite) { counts.skipped++; continue; }
    if (old && ['workOrders','inventory','lightingTasks'].includes(e.collection) && e.data.revision <= old.revision) fail('기존 문서와 같거나 이전 revision으로 덮어쓸 수 없어요: ' + e.path, 'failed-precondition');
    result.set(e.path,e.data); writes.push(e); counts.restored++; counts[old?'replaced':'added']++;
  }
  return { result, writes, counts };
}
function validateGraph(plan, current) {
  const prepared=materialize(plan,current), data=prepared.result;
  const workHistory=new Map(),inventoryHistory=new Map();
  for(const[path,row]of data){if(!row)continue;const target=path.startsWith('workEvents/')?workHistory:path.startsWith('inventoryMoves/')?inventoryHistory:null;if(target){const key=target===workHistory?row.workId:row.itemId;if(!target.has(key))target.set(key,[]);target.get(key).push(row);}}
  for(const rows of [...workHistory.values(),...inventoryHistory.values()])rows.sort((a,b)=>a.revision-b.revision);
  const need=(path,message)=>{const value=data.get(path);if(!value)fail(message+' ('+path+')','failed-precondition');return value;};
  // Validate the effective graph even for skipped existing documents. Mixing an old
  // snapshot with different target history must not quietly create inconsistent stock.
  for (const entry of plan.entries) { const e={...entry,data:data.get(entry.path)},d=e.data;validate(e.collection,d);
    if (e.collection==='workOrders') {
      for(const p of [...d.beforePhotos,...d.afterPhotos]) { const photo=need('photos/'+p,'연결 사진이 빠졌어요'); if(photo.workId!==e.id||photo.lightId!==d.lightId||photo.kind!=='work')fail('작업 사진의 시설·작업 연결이 다릅니다.','failed-precondition'); }
      for(const r of d.reportIds){const report=need('reports/'+r,'연결 신고가 빠졌어요');if(report.lightId!==d.lightId)fail('작업과 신고의 시설이 다릅니다.','failed-precondition');}
      for(const i of d.inspectionIds){const inspection=need('inspections/'+i,'연결 점검이 빠졌어요');if(inspection.lightId!==d.lightId)fail('작업과 점검의 시설이 다릅니다.','failed-precondition');}
      for(const k of Object.keys(d.stockApplied||{}))need('inventory/'+k,'반영한 자재가 빠졌어요');
      const events=workHistory.get(e.id)||[];
      if(events.length!==d.revision||events.some((v,i)=>v.revision!==i+1||v.lightId!==d.lightId))fail('작업의 전체 revision 이력이 필요해요: '+e.id,'failed-precondition');
      const last=events.at(-1);if(last.toStatus!==d.status||last.at!==d.updatedAt||last.by!==d.updatedBy)fail('작업 최종 상태와 이력이 일치하지 않아요.','failed-precondition');
      const cost=events.filter(v=>v.toStatus==='verified').reduce((s,v)=>s+Number(v.costDelta==null?v.costTotal:v.costDelta||0),0);
      if(Math.abs(cost-(d.accountedCost||0))>0.01)fail('작업 검수 이력과 인정 비용이 일치하지 않아요.','failed-precondition');
    }
    if(e.collection==='workEvents'){const w=need('workOrders/'+d.workId,'처리 이력의 작업이 빠졌어요');if(w.lightId!==d.lightId||d.revision>w.revision)fail('처리 이력과 작업이 일치하지 않아요.','failed-precondition');}
    if(e.collection==='inventory'){
      const moves=inventoryHistory.get(e.id)||[];
      const quantity=moves.reduce((s,v,i)=>i?Math.round((s+v.delta)*1000)/1000:v.delta,0);
      if(moves.length!==d.revision||moves.some((v,i)=>v.revision!==i+1)||Math.abs(quantity-d.quantity)>0.000001)fail('재고 수량과 전체 입출고 이력이 일치하지 않아요: '+e.id,'failed-precondition');
    }
    if(e.collection==='inventoryMoves'){const item=need('inventory/'+d.itemId,'입출고 대상 자재가 빠졌어요');if(d.revision>item.revision)fail('입출고 revision이 재고보다 큽니다.','failed-precondition');if(d.workId)need('workOrders/'+d.workId,'입출고 작업이 빠졌어요');}
    if(e.collection==='reportEvents'){const report=need('reports/'+d.reportId,'연결 이력의 신고가 빠졌어요');if(d.revision>(report.linkRevision||0))fail('신고 연결 이력 revision이 올바르지 않아요.','failed-precondition');}
    if(e.collection==='reports'&&d.workId){const w=need('workOrders/'+d.workId,'신고의 연결 작업이 빠졌어요');if(w.lightId!==d.lightId||!w.reportIds.includes(e.id))fail('신고와 작업 연결이 일치하지 않아요.','failed-precondition');}
    if(e.collection==='inspections')for(const t of d.thumbs||[]){const p=need('photos/'+t.id,'점검 원본 사진이 빠졌어요');if(p.inspectionId!==e.id||p.lightId!==d.lightId||p.by!==d.inspector||p.kind!=='inspection')fail('점검 사진의 시설·작성자 연결이 다릅니다.','failed-precondition');}
    if(e.collection==='lightingTasks'&&d.status==='completed'){
      const o=need('lightingContext/'+d.observationId,'재확인 업무의 현장 관찰이 빠졌어요');
      const active=o.schedule==='always'||o.schedule==='hours'&&(o.startMinute<o.endMinute?d.reviewMinute>=o.startMinute&&d.reviewMinute<o.endMinute:d.reviewMinute>=o.startMinute||d.reviewMinute<o.endMinute);
      const rad=Math.PI/180,x=Math.sin((o.lat-d.lat)*rad/2)**2+Math.cos(d.lat*rad)*Math.cos(o.lat*rad)*Math.sin((o.lng-d.lng)*rad/2)**2,distance=12742000*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));
      if(o.kind!=='observation'||o.removed||!o.nightConfirmed||!['bright','adequate','dark'].includes(o.level)||o.observedAt<d.createdAt-300000||o.observedAt+o.validDays*86400000<d.completedAt||distance>d.radius+o.radius||!active)fail('재확인 완료의 관찰 근거가 유효하지 않아요.','failed-precondition');
    }
  }
  return prepared;
}
module.exports={MAX_DOCUMENTS,MAX_BYTES,PRIMARY,DEPENDENCIES,IMMUTABLE,fail,plain,canonical,hash,id,normalize,validate,references,materialize,validateGraph};
