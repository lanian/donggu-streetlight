/* Administrator restore planning. No backend starts until prepareBackup is called. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;root.DGRestore=api;})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';
  const PRIMARY=['workOrders','workEvents','inventory','inventoryMoves','reportEvents','lightingTasks','lightingRuns'];
  const EXCLUDED=['restoreOperations','systemHealth','lightingOperations','lightingWorkflowOperations','lightingAreaOperations','auditEvents'];
  const MAX_DOCUMENTS=200,MAX_BYTES=4*1024*1024;
  const uuid=()=> 'restore-'+(root.crypto?.randomUUID?root.crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
  const fail=message=>{throw new Error(message);};
  function buildPayload(input,options={}){
    const original=input?.collections||{},collections={};
    for(const c of PRIMARY)if(Array.isArray(original[c])&&original[c].length)collections[c]=original[c];
    if(!Object.keys(collections).length)return null;
    const wanted={photos:new Set(),reports:new Set(),lightingContext:new Set(),inspections:new Set()};
    for(const w of collections.workOrders||[]){for(const p of [...(w.beforePhotos||[]),...(w.afterPhotos||[])])wanted.photos.add(p);for(const r of w.reportIds||[])wanted.reports.add(r);for(const i of w.inspectionIds||[])wanted.inspections.add(i);}
    for(const e of collections.reportEvents||[])wanted.reports.add(e.reportId);
    for(const t of collections.lightingTasks||[])if(t.status==='completed'&&t.observationId)wanted.lightingContext.add(t.observationId);
    for(const i of original.inspections||[])if(wanted.inspections.has(i.id))for(const t of i.thumbs||[])if(t.id)wanted.photos.add(t.id);
    for(const[c,ids]of Object.entries(wanted)){const values=(original[c]||[]).filter(r=>ids.has(r.id));if(values.length)collections[c]=values;}
    return{operationId:options.operationId||uuid(),collections,overwrite:!!options.overwrite,source:{app:input.app||'donggu-streetlight',version:input.version||2,at:input.at||0,mode:input.mode||'unknown'}};
  }
  function checkLimit(payload){const count=Object.values(payload.collections).reduce((n,rows)=>n+rows.length,0),bytes=new TextEncoder().encode(JSON.stringify(payload)).length;if(count>MAX_DOCUMENTS||bytes>MAX_BYTES)fail('업무 복원 묶음이 '+count+'문서입니다. 웹 원자 복원은 200문서·4MB까지예요. 관리자 대량 이전 도구로 빈 업무 저장소에 복원해 주세요.');return{count,bytes};}
  async function prepareBackup(input,options={}){
    const payload=buildPayload(input,options);if(!payload)return null;
    if(options.functionsEnabled===false||(!options.call&&!root.FIREBASE_CONFIG?.functionsEnabled))fail('보수·재고·불변 이력 복원은 관리자 서버 기능을 연결해야 합니다. 아직 어떤 기록도 복원하지 않았어요.');
    checkLimit(payload);const call=options.call||root.DGSecurity?.call;if(!call)fail('서버 복원 기능이 준비되지 않았습니다.');
    const result=await call('previewOperationalRestore',payload);
    if(!result?.operationId||!result.token||!Array.isArray(result.handledPaths))fail('서버 복원 미리보기를 확인하지 못했어요.');
    return{...result,payload,notes:['원작성자는 보존하고 복원 관리자는 별도 이력에 기록합니다.','기존 불변 이력은 덮어쓰지 않으며, 이전 revision으로 되돌리는 복원은 지원하지 않습니다.'],call};
  }
  async function applyBackup(plan,options={}){if(!plan)return{restored:0,skipped:0};const call=options.call||plan.call||root.DGSecurity?.call;if(!call)fail('서버 복원 기능이 준비되지 않았습니다.');return call('applyOperationalRestore',{payload:plan.payload,token:plan.token});}
  return{PRIMARY,EXCLUDED,MAX_DOCUMENTS,MAX_BYTES,buildPayload,checkLimit,prepareBackup,applyBackup};
});
