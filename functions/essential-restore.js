'use strict';
const COLLECTIONS = ['cabinets','circuits','assetLinks','outageIncidents','assetReplacements','assetOperations','preventivePlans','preventiveRuns','preventiveOperations','inspectionDetails','inspectionMeasurements'];
const IMMUTABLE = ['assetReplacements','assetOperations','preventiveRuns','preventiveOperations','inspectionDetails','inspectionMeasurements'];
const ENTITIES = { cabinet:'cabinets', circuit:'circuits', link:'assetLinks', incident:'outageIncidents', replacement:'assetReplacements' };
const META = ['schemaVersion','createdAt','createdBy','updatedAt','updatedBy','revision','operationId'];
const MAX_ASSET_TIME = 8640000000000000;
const RESERVED_IDS = ['__proto__','prototype','constructor'];
const INSPECTION_DETAIL_FIELDS = ['schemaVersion','inspectionId','lightId','date','inspector','checks','checkReasons','inspectionComplete','readings','result'];
const INSPECTION_PROOF_FIELDS = ['lightId','date','inspector','checks','checkReasons','inspectionComplete','readings','result'];
const INSPECTION_MEASUREMENT_FIELDS = ['schemaVersion','inspectionId','lightId','date','inspector','readings'];
const INSPECTION_MEASUREMENT_PROJECTION = ['lightId','date','inspector','readings'];
function validate(c, d, h) {
  const {keys,text,id,integer,number,choice,ids,meta,fail,digest} = h;
  const bool = v => { if (typeof v !== 'boolean') fail('복원 여부 값이 올바르지 않아요.'); };
  const fields = names => keys(d, [...META,...names], [...META,...names]);
  // Keep this self-contained: Firebase Functions does not deploy the app/ source tree.
  const assetId = value => { id(value); if(!/^[A-Za-z0-9_-]{1,180}$/.test(value)||RESERVED_IDS.includes(value))fail('시설 자료 식별자를 확인해 주세요.'); };
  const assetText = (value,max,required=false) => { text(value,max,required); if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail('시설 자료 문자열을 확인해 주세요.'); };
  const assetMeta = (immutable=false) => { meta(d,immutable);integer(d.createdAt,1,MAX_ASSET_TIME);integer(d.updatedAt,d.createdAt,MAX_ASSET_TIME);assetId(d.operationId);assetText(d.createdBy,128,true);assetText(d.updatedBy,128,true); };
  const assetIds = (values,max) => { ids(values,max);values.forEach(assetId); };
  const parents = () => { if(d.cabinetId!=='')assetId(d.cabinetId);if(d.circuitId!=='')assetId(d.circuitId);if(!!d.cabinetId!==!!d.circuitId)fail('분전함과 회로를 함께 지정해 주세요.'); };
  const preventiveId = value => { id(value);if(RESERVED_IDS.includes(value))fail('정기점검 식별자를 확인해 주세요.'); };
  const preventiveIds = (values,max) => { ids(values,max);values.forEach(preventiveId); };
  if (c === 'cabinets') {
    fields(['code','label','dong','lat','lng','note','disabled']); assetMeta(); assetText(d.code,100,true); assetText(d.label,100,true); assetText(d.dong,80); assetText(d.note,1000); bool(d.disabled);
    if (d.lat !== null || d.lng !== null) { number(d.lat,-90,90); number(d.lng,-180,180); }
  } else if (c === 'circuits') {
    fields(['cabinetId','code','label','note','disabled']); assetMeta(); assetId(d.cabinetId); assetText(d.code,100,true); assetText(d.label,100,true); assetText(d.note,1000); bool(d.disabled);
  } else if (c === 'assetLinks') {
    fields(['lightId','cabinetId','circuitId','confirmationNote']); assetMeta(); assetId(d.lightId); parents();assetText(d.confirmationNote,1000,true);
  } else if (c === 'outageIncidents') {
    fields(['title','cabinetId','circuitId','lightIds','reportIds','workIds','confirmedLightIds','status','note','resolutionNote']); assetMeta(); assetText(d.title,120,true); parents();
    assetIds(d.lightIds,100); if(!d.lightIds.length)fail('공동 고장 대상이 없어요.'); assetIds(d.reportIds,20); assetIds(d.workIds,20); assetIds(d.confirmedLightIds,100);
    if(d.confirmedLightIds.some(v=>!d.lightIds.includes(v)))fail('복구 확인 시설이 고장 대상과 달라요.');
    choice(d.status,['open','resolved']); assetText(d.note,1500);assetText(d.resolutionNote,1000);
    if(d.status==='resolved'&&(d.confirmedLightIds.length!==d.lightIds.length||!d.resolutionNote.trim()))fail('공동 고장의 전체 복구 확인과 사유가 필요해요.');
    if(d.status==='open'&&d.resolutionNote!=='')fail('복구 완료 내용은 전체 복구를 확인한 뒤 기록해 주세요.');
  } else if(c === 'assetReplacements') {
    fields(['lightId','component','replacedAt','manufacturer','model','warrantyEnd','workId','note']);assetMeta(true);assetId(d.lightId);choice(d.component,['lamp','fixture','driver','pole','cabinet','other']);integer(d.replacedAt,1,MAX_ASSET_TIME);integer(d.warrantyEnd,0,MAX_ASSET_TIME);
    if(d.replacedAt>d.createdAt||d.warrantyEnd&&d.warrantyEnd<d.replacedAt)fail('교체일과 보증 종료일을 확인해 주세요.');assetText(d.manufacturer,100);assetText(d.model,100);if(d.workId!=='')assetId(d.workId);assetText(d.note,1000,d.component==='other');
  } else if(c === 'assetOperations') {
    keys(d,['schemaVersion','entity','recordId','by','at','revision','requestHash','snapshot'],['schemaVersion','entity','recordId','by','at','revision','requestHash','snapshot']);if(d.schemaVersion!==1)fail('시설 이력 버전을 확인해 주세요.');choice(d.entity,Object.keys(ENTITIES));assetId(d.recordId);assetText(d.by,128,true);integer(d.at,1,MAX_ASSET_TIME);integer(d.revision,1);digest(d.requestHash);
    validate(ENTITIES[d.entity],d.snapshot,h);if(d.snapshot.updatedBy!==d.by||d.snapshot.updatedAt!==d.at||d.snapshot.revision!==d.revision)fail('시설 이력과 변경 내용이 일치하지 않아요.');
  } else if(c === 'preventivePlans') {
    keys(d,['schemaVersion','title','description','type','priority','assignedTo','intervalDays','completionDays','startAt','nextAt','lightIds','enabled','createdAt','createdBy','updatedAt','updatedBy','revision'],['schemaVersion','title','description','type','priority','assignedTo','intervalDays','completionDays','startAt','nextAt','lightIds','enabled','createdAt','createdBy','updatedAt','updatedBy','revision']);
    if(d.schemaVersion!==1)fail('정기 계획 버전을 확인해 주세요.');text(d.title,120,true);text(d.description,2000);choice(d.type,['수리','재점검','신설검토','철거','기타']);choice(d.priority,['긴급','높음','보통','낮음']);text(d.assignedTo,180,true);integer(d.intervalDays,1,3650);integer(d.completionDays,1,3650);integer(d.startAt,1);integer(d.nextAt,d.startAt);preventiveIds(d.lightIds,200);if(!d.lightIds.length)fail('정기 점검 대상이 없어요.');bool(d.enabled);integer(d.createdAt,1);integer(d.updatedAt,d.createdAt);preventiveId(d.createdBy);preventiveId(d.updatedBy);integer(d.revision,1);
  } else if(c === 'preventiveRuns') {
    keys(d,['schemaVersion','planId','scheduledAt','lightId','workId','carried','createdAt','createdBy','operationId'],['schemaVersion','planId','scheduledAt','lightId','workId','carried','createdAt','createdBy','operationId']);if(d.schemaVersion!==1)fail('정기 회차 버전을 확인해 주세요.');preventiveId(d.planId);integer(d.scheduledAt,1);preventiveId(d.lightId);preventiveId(d.workId);bool(d.carried);integer(d.createdAt,d.scheduledAt);preventiveId(d.createdBy);preventiveId(d.operationId);
  } else if(c === 'preventiveOperations') {
    keys(d,['schemaVersion','planId','by','at','action','recordIds','revision','requestHash'],['schemaVersion','planId','by','at','action','recordIds','revision','requestHash']);if(d.schemaVersion!==1)fail('정기 처리 이력 버전을 확인해 주세요.');preventiveId(d.planId);text(d.by,128,true);integer(d.at,1);integer(d.revision,1);choice(d.action,['save','generate','advance']);preventiveIds(d.recordIds,4);digest(d.requestHash);
    if(d.action==='generate'&&!d.recordIds.length||d.action==='advance'&&d.recordIds.length||d.action==='save'&&(d.recordIds.length!==1||d.recordIds[0]!==d.planId))fail('정기 처리 이력과 작업 대상이 다릅니다.');
  } else if(c === 'inspectionDetails') {
    keys(d,INSPECTION_DETAIL_FIELDS,INSPECTION_DETAIL_FIELDS);
    if(d.schemaVersion!==1)fail('점검 상세 증빙 버전을 확인해 주세요.');
    id(d.inspectionId);id(d.lightId);integer(d.date,1);text(d.inspector,128,true);
    inspection(d,h);
  } else if(c === 'inspectionMeasurements') {
    keys(d,INSPECTION_MEASUREMENT_FIELDS,INSPECTION_MEASUREMENT_FIELDS);
    if(d.schemaVersion!==1)fail('점검 측정 증빙 버전을 확인해 주세요.');
    id(d.inspectionId);id(d.lightId);integer(d.date,1);text(d.inspector,128,true);
    inspectionReadings(d,h);
    if(!d.readings.length)fail('점검 측정 증빙에는 실제 측정값이 필요해요.');
  }
}
function references(entries) {
  const paths = new Set(), add=(c,id)=>{if(id)paths.add(c+'/'+id);};
  for(const {collection:c,data:d,id:recordId} of entries){
    if(['circuits','assetLinks','outageIncidents'].includes(c))add('cabinets',d.cabinetId);
    if(['assetLinks','outageIncidents'].includes(c))add('circuits',d.circuitId);
    if(c==='outageIncidents'){d.reportIds.forEach(id=>add('reports',id));d.workIds.forEach(id=>add('workOrders',id));}
    if(c==='assetReplacements')add('workOrders',d.workId);
    if(c==='assetOperations')add(ENTITIES[d.entity],d.recordId);
    if(c==='preventiveRuns'){add('preventivePlans',d.planId);add('workOrders',d.workId);add('preventiveOperations',d.operationId);}
    if(c==='preventiveOperations'){add('preventivePlans',d.planId);if(d.action==='generate')d.recordIds.forEach(id=>add('preventiveRuns',id));}
    if(['cabinets','circuits','assetLinks','outageIncidents','assetReplacements'].includes(c))add('assetOperations',d.operationId);
    if(c==='inspectionDetails')add('inspections',d.inspectionId);
    if(c==='inspectionDetails')add('inspectionMeasurements',recordId);
    if(c==='inspectionMeasurements')add('inspectionDetails',d.inspectionId);
    // Older typed backups may have no proof. Read an existing proof, when present,
    // so a parent-only restore cannot diverge from immutable evidence.
    if(c==='inspections')add('inspectionDetails',recordId);
  }
  return [...paths];
}
function graph(entries,data,h){
  const need=(c,id)=>{const record=data.get(c+'/'+id);if(!record)h.fail('연결된 업무 자료가 빠졌어요: '+c+'/'+id,'failed-precondition');return record;};
  const measurementProof=(id,measurement,proof)=>{
    if(measurement.schemaVersion!==1||measurement.inspectionId!==id||proof.inspectionId!==id
      ||Object.keys(measurement).length!==INSPECTION_MEASUREMENT_FIELDS.length
      ||INSPECTION_MEASUREMENT_FIELDS.some(key=>!Object.hasOwn(measurement,key))
      ||!Array.isArray(measurement.readings)||!measurement.readings.length
      ||INSPECTION_MEASUREMENT_PROJECTION.some(key=>!Object.hasOwn(proof,key)||h.canonical(measurement[key])!==h.canonical(proof[key])))h.fail('점검 측정 증빙과 상세 증빙의 내용이 다릅니다.','failed-precondition');
  };
  const inspectionProof=(id,proof,parent)=>{
    if(proof.schemaVersion!==1||proof.inspectionId!==id||Object.keys(proof).length!==INSPECTION_DETAIL_FIELDS.length
      ||INSPECTION_DETAIL_FIELDS.some(key=>!Object.hasOwn(proof,key))
      ||INSPECTION_PROOF_FIELDS.some(key=>!Object.hasOwn(parent,key)||h.canonical(proof[key])!==h.canonical(parent[key])))h.fail('점검 상세 증빙과 원본 점검의 내용이 다릅니다.','failed-precondition');
    const measurement=data.get('inspectionMeasurements/'+id);if(measurement)measurementProof(id,measurement,proof);
    // A proof may be the only incoming record. Its existing parent and originals
    // still form one complete graph and must be checked in that case too.
    for(const thumb of parent.thumbs||[]){const photo=need('photos',thumb.id);if((photo.inspId??photo.inspectionId)!==id
      ||photo.inspId!==undefined&&photo.inspectionId!==undefined&&photo.inspId!==photo.inspectionId
      ||photo.lightId!==parent.lightId||photo.by!==parent.inspector||photo.kind!=='inspection')h.fail('점검 상세 증빙의 원본 사진 연결이 다릅니다.','failed-precondition');}
  };
  for(const e of entries){const c=e.collection,d=data.get(e.path)||e.data;
    if(['circuits','assetLinks','outageIncidents'].includes(c)&&d.cabinetId)need('cabinets',d.cabinetId);
    if(['assetLinks','outageIncidents'].includes(c)&&d.circuitId){const circuit=need('circuits',d.circuitId);if(circuit.cabinetId!==d.cabinetId)h.fail('분전함과 회로의 연결이 다릅니다.','failed-precondition');}
    if(c==='assetLinks'&&e.id!==d.lightId)h.fail('시설 연결 ID가 다릅니다.','failed-precondition');
    if(c==='outageIncidents'){for(const id of d.reportIds)if(!d.lightIds.includes(need('reports',id).lightId))h.fail('공동 고장의 신고 시설이 다릅니다.','failed-precondition');for(const id of d.workIds)if(!d.lightIds.includes(need('workOrders',id).lightId))h.fail('공동 고장의 작업 시설이 다릅니다.','failed-precondition');}
    if(c==='assetReplacements'&&d.workId&&need('workOrders',d.workId).lightId!==d.lightId)h.fail('부품 교체 작업의 시설이 다릅니다.','failed-precondition');
    if(['cabinets','circuits','assetLinks','outageIncidents','assetReplacements'].includes(c)){const op=need('assetOperations',d.operationId);if(ENTITIES[op.entity]!==c||op.recordId!==e.id||h.canonical(op.snapshot)!==h.canonical(d))h.fail('시설의 최신 변경 이력이 일치하지 않습니다.','failed-precondition');}
    if(c==='assetOperations'){const target=need(ENTITIES[d.entity],d.recordId);if(d.revision>target.revision||d.snapshot.operationId!==e.id||d.snapshot.createdAt!==target.createdAt||d.snapshot.createdBy!==target.createdBy||d.entity==='circuit'&&d.snapshot.cabinetId!==target.cabinetId||d.entity==='link'&&d.snapshot.lightId!==d.recordId)h.fail('시설 변경 이력이 현재 자료와 다릅니다.','failed-precondition');}
    if(c==='preventiveRuns'){need('preventivePlans',d.planId);if(need('workOrders',d.workId).lightId!==d.lightId)h.fail('정기 점검 회차의 작업 시설이 다릅니다.','failed-precondition');const op=need('preventiveOperations',d.operationId);if(op.planId!==d.planId||op.action!=='generate'||!op.recordIds.includes(e.id)||op.by!==d.createdBy||op.at!==d.createdAt)h.fail('정기 점검 회차의 처리 이력이 다릅니다.','failed-precondition');}
    if(c==='preventiveOperations'){need('preventivePlans',d.planId);if(d.action==='generate')for(const id of d.recordIds)if(need('preventiveRuns',id).planId!==d.planId)h.fail('정기 처리 이력의 계획이 다릅니다.','failed-precondition');}
    if(c==='inspectionDetails')inspectionProof(e.id,d,need('inspections',d.inspectionId));
    if(c==='inspectionMeasurements'){const proof=need('inspectionDetails',d.inspectionId);measurementProof(e.id,d,proof);inspectionProof(e.id,proof,need('inspections',d.inspectionId));}
    if(c==='inspections'){const proof=data.get('inspectionDetails/'+e.id);if(proof)inspectionProof(e.id,proof,d);}
  }
}
function work(d,h){
  if(d.workflowVersion!==undefined&&d.workflowVersion!==2)h.fail('업무 처리 버전이 올바르지 않아요.');
  if(d.acknowledgedAt!==undefined)h.integer(d.acknowledgedAt);
  if(d.acknowledgedBy!==undefined)h.text(d.acknowledgedBy,128);
  if(d.acknowledgedAt?(!d.acknowledgedBy||d.acknowledgedBy!==d.assignedTo||d.acknowledgedAt>d.updatedAt):!!d.acknowledgedBy)h.fail('작업 배정 확인자가 올바르지 않아요.');
  if(d.hold!=null){const v=d.hold;h.keys(v,['reason','note','nextAt','nextAction','since','by'],['reason','note','nextAt','nextAction','since','by']);h.choice(v.reason,['material','external','equipment','weather','other']);h.text(v.note,500,v.reason==='other');h.integer(v.nextAt,v.since+1);h.text(v.nextAction,500,true);h.integer(v.since,1,d.updatedAt);h.text(v.by,128,true);if(['verified','cancelled'].includes(d.status))h.fail('종료 작업은 보류할 수 없어요.');}
  if(d.diagnosis!==undefined)h.choice(d.diagnosis,['','lamp','power','controller','fixture','pole','wiring','external','unknown']);
  if(d.repairAction!==undefined)h.choice(d.repairAction,['','replace','repair','adjust','restore_power','inspect','refer','none']);
  if(d.workflowVersion===2&&['completed','verified'].includes(d.status)&&(!d.diagnosis||!d.repairAction))h.fail('완료 작업의 고장 원인과 조치 유형이 필요해요.');
}
function inspection(d,h){
  if(d.inspectionComplete===undefined&&d.checkReasons===undefined&&d.readings===undefined)return;
  if(typeof d.inspectionComplete!=='boolean')h.fail('점검 완료 여부를 확인해 주세요.');
  const codes=['lamp','flicker','fixture','pole','base','cabinet','leak','tree'];h.keys(d.checks,codes,codes);h.keys(d.checkReasons===undefined?{}:d.checkReasons,codes);
  for(const key of codes){h.choice(d.checks[key],['ok','bad','uninspected','na']);if(d.checkReasons?.[key]!==undefined)h.text(d.checkReasons[key],300);if(['uninspected','na'].includes(d.checks[key])&&!d.checkReasons?.[key]?.trim())h.fail('미실시·해당 없음의 사유가 필요해요.');}
  const complete=codes.every(k=>d.checks[k]!=='uninspected')&&codes.some(k=>['ok','bad'].includes(d.checks[k]));
  h.choice(d.result,['정상','점검필요','고장']);
  const bad=codes.filter(k=>d.checks[k]==='bad');
  if(d.inspectionComplete!==complete||(!complete||bad.length)&&d.result==='정상'||bad.some(k=>['lamp','leak','pole'].includes(k))&&d.result!=='고장')h.fail('점검 항목과 완료 판정이 다릅니다.');
  inspectionReadings(d,h);
}
function inspectionReadings(d,h){
  if(!Array.isArray(d.readings)||d.readings.length>10)h.fail('측정값 목록을 확인해 주세요.');
  for(const row of d.readings){h.keys(row,['kind','value','unit','at','by'],['kind','value','unit','at','by']);h.choice(row.kind,['insulationResistance','leakageCurrent']);h.number(row.value,0,1000000000);h.integer(row.at,1,d.date+300000);h.text(row.by,128,true);if(row.by!==d.inspector||row.unit!==(row.kind==='insulationResistance'?'MΩ':'mA'))h.fail('측정값의 작성자와 단위가 다릅니다.');}
}
module.exports={COLLECTIONS,IMMUTABLE,ENTITIES,validate,references,graph,work,inspection};
