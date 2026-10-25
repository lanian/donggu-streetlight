'use strict';
const crypto=require('node:crypto');
const R=require('./restore-core');
const TTL=15*60*1000;
function createRestoreService(db){
  async function snapshot(tx,plan){
    const paths=new Set([...plan.entries.map(e=>e.path),...R.references(plan.entries)]),current=new Map(),queries={};
    if(paths.size>400)R.fail('참조 문서가 너무 많아 원자 복원 한도를 넘었어요.','resource-exhausted');
    if(paths.size){const docs=await tx.getAll(...[...paths].map(p=>db.doc(p)));for(const s of docs)current.set(s.ref.path,s.exists?s.data():null);}
    for(let depth=0;depth<4;depth++){
      const extra=R.references([...current].filter(([,v])=>v).map(([path,data])=>({path,collection:path.split('/')[0],id:path.split('/')[1],data}))).filter(p=>!current.has(p));
      if(!extra.length)break;if(current.size+extra.length>600)R.fail('참조 문서가 원자 복원 한도를 넘었어요.','resource-exhausted');
      const docs=await tx.getAll(...extra.map(p=>db.doc(p)));for(const s of docs)current.set(s.ref.path,s.exists?s.data():null);
    }
    const groups=[];
    for(const e of plan.entries){if(e.collection==='workOrders')groups.push(['workEvents','workId',e.id]);if(e.collection==='inventory')groups.push(['inventoryMoves','itemId',e.id]);}
    for(const [col,field,id]of groups){const found=await tx.get(db.collection(col).where(field,'==',id).limit(401));if(found.size>400)R.fail('기존 업무 이력이 원자 복원 한도를 넘었어요.','resource-exhausted');queries[col+':'+id]=R.hash(found.docs.map(s=>({id:s.id,data:s.data()})).sort((a,b)=>a.id.localeCompare(b.id)));for(const s of found.docs)current.set(s.ref.path,s.data());}
    if(current.size>600)R.fail('검증할 업무 이력이 너무 많아요.','resource-exhausted');
    return{current,expected:Object.fromEntries([...current].map(([p,v])=>[p,v==null?null:R.hash(v)])),queries};
  }
  async function authorized(tx,uid){const [role,guard]=await Promise.all([tx.get(db.doc('roles/'+uid)),tx.get(db.doc('meta/operationalRestore'))]);if(role.data()?.role!=='admin')R.fail('관리자만 업무 기록을 복원할 수 있어요.','permission-denied');if(guard.data()?.status==='partial')R.fail('대량 이전이 진행 중입니다. 같은 이전 작업을 완료해 주세요.','failed-precondition');}
  async function preview(uid,input){
    const plan=R.normalize(input),ref=db.doc('restoreOperations/'+plan.operationId),now=Date.now();
    return db.runTransaction(async tx=>{
      await authorized(tx,uid);const old=await tx.get(ref),prior=old.data();
      if(prior){if(prior.by!==uid||prior.payloadHash!==plan.payloadHash)R.fail('복원 작업 ID가 다른 계획에 사용됐어요.','already-exists');if(prior.status==='applied')return{operationId:plan.operationId,token:prior.token,counts:prior.counts,handledPaths:plan.entries.map(e=>e.path),expiresAt:prior.expiresAt,applied:true};if(prior.status!=='preview')R.fail('대량 이전 작업 ID는 웹 복원에서 사용할 수 없어요.','failed-precondition');}
      const state=await snapshot(tx,plan),prepared=R.validateGraph(plan,state.current);
      const token=crypto.randomBytes(24).toString('base64url'),receipt={schemaVersion:1,status:'preview',by:uid,createdAt:prior?.createdAt||now,previewedAt:now,expiresAt:now+TTL,token,payloadHash:plan.payloadHash,overwrite:plan.overwrite,source:plan.source,expected:state.expected,queries:state.queries,counts:prepared.counts,paths:plan.entries.map(e=>e.path)};
      tx.set(ref,receipt);
      return{operationId:plan.operationId,token,expiresAt:receipt.expiresAt,counts:prepared.counts,handledPaths:receipt.paths,applied:false,limits:{documents:R.MAX_DOCUMENTS,bytes:R.MAX_BYTES}};
    });
  }
  async function apply(uid,input){
    if(!R.plain(input)||Object.keys(input).some(k=>!['payload','token'].includes(k))||typeof input.token!=='string')R.fail('검토한 복원 계획을 확인해 주세요.');
    const plan=R.normalize(input.payload),ref=db.doc('restoreOperations/'+plan.operationId),now=Date.now();
    return db.runTransaction(async tx=>{
      await authorized(tx,uid);const receipt=await tx.get(ref),prior=receipt.data();
      if(!prior||prior.by!==uid||prior.payloadHash!==plan.payloadHash||prior.token!==input.token)R.fail('검토한 복원 계획과 요청이 다릅니다.','failed-precondition');
      // A completed operation is a receipt, not another set of writes; later edits survive a lost-response retry.
      if(prior.status==='applied')return{operationId:plan.operationId,...prior.counts,replayed:true,appliedAt:prior.appliedAt};
      if(prior.status!=='preview'||prior.expiresAt<now)R.fail('복원 검토가 만료됐어요. 내용을 다시 확인해 주세요.','failed-precondition');
      const state=await snapshot(tx,plan);
      if(R.hash(state.expected)!==R.hash(prior.expected)||R.hash(state.queries)!==R.hash(prior.queries))R.fail('복원 검토 후 현재 자료가 바뀌었어요. 다시 비교해 주세요.','aborted');
      const prepared=R.validateGraph(plan,state.current);
      for(const e of prepared.writes)tx.set(db.doc(e.path),e.data);
      const provenance=prepared.writes.map(e=>({path:e.path,sourceCreatedBy:e.data.createdBy||null,sourceUpdatedBy:e.data.updatedBy||e.data.by||null,sourceRevision:e.data.revision||null}));
      tx.update(ref,{status:'applied',appliedAt:now,counts:prepared.counts,provenance});
      tx.create(db.doc('auditEvents/restore-'+plan.operationId),{at:now,by:uid,actorType:'user',action:'operational-restore',path:ref.path,restored:prepared.counts.restored,skipped:prepared.counts.skipped,payloadHash:plan.payloadHash});
      return{operationId:plan.operationId,...prepared.counts,replayed:false,appliedAt:now};
    });
  }
  return{preview,apply};
}
module.exports={createRestoreService,TTL};
