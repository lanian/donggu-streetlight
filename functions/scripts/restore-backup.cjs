#!/usr/bin/env node
'use strict';
// Explicit administrator CLI for an empty destination. No production project is inferred.
const fs=require('node:fs'),path=require('node:path');
const R=require('../restore-core');
const {buildPayload}=require('../../app/restore');
function args(values){const out={apply:false,emulator:false};for(let i=0;i<values.length;i++){const k=values[i];if(k==='--apply')out.apply=true;else if(k==='--plan')out.apply=false;else if(k==='--emulator')out.emulator=true;else if(['--project','--uid','--file','--operation'].includes(k))out[k.slice(2)]=values[++i];else throw new Error('알 수 없는 인수: '+k);}return out;}
function chunks(entries){const result=[];let current=[],bytes=0;for(const e of entries){const size=Buffer.byteLength(R.canonical(e));if(current.length&&(current.length>=200||bytes+size>4*1024*1024)){result.push(current);current=[];bytes=0;}current.push(e);bytes+=size;}if(current.length)result.push(current);return result;}
async function main(hooks={}){
  const options=args(process.argv.slice(2));
  if(!/^[a-z][a-z0-9-]{4,62}$/.test(options.project||'')||!options.uid||!options.file||!options.operation)throw new Error('명시적으로 --project PROJECT --uid ADMIN_UID --file BACKUP.json --operation RESTORE_ID를 지정하세요. 기본은 --plan입니다.');
  if(options.emulator&&!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw new Error('--emulator는 loopback Firestore 주소가 필요합니다.');
  if(!options.emulator&&process.env.FIRESTORE_EMULATOR_HOST)throw new Error('에뮬레이터 주소가 설정됐습니다. --emulator를 명시하세요.');
  if(fs.statSync(options.file).size>256*1024*1024)throw new Error('대량 이전 파일은 256MB 이하로 준비하세요.');
  const backup=JSON.parse(fs.readFileSync(path.resolve(options.file),'utf8'));
  const payload=buildPayload(backup,{operationId:options.operation,overwrite:false});if(!payload)throw new Error('복원할 업무 기록이 없습니다.');
  const plan=R.normalize(payload,true);R.validateGraph(plan,new Map());
  const {initializeApp,deleteApp}=require('firebase-admin/app'),{getFirestore}=require('firebase-admin/firestore');
  const app=initializeApp({projectId:options.project}),db=getFirestore(app);
  const operation=db.doc('restoreOperations/'+plan.operationId),lock=db.doc('meta/operationalRestore');
  async function staff(tx){const rows=await tx.get(db.collection('roles').where('role','in',['admin','inspector']));if(rows.size!==1||rows.docs[0].id!==options.uid||rows.docs[0].data().role!=='admin')throw new Error('대량 이전은 확인한 관리자 1명만 있는 초기 저장소에서 실행하세요. 운영 중인 저장소는 웹 원자 복원을 사용하세요.');}
  try{
    const groups=chunks(plan.entries),summary=await db.runTransaction(async tx=>{
      await staff(tx);const [receipt,guard]=await Promise.all([tx.get(operation),tx.get(lock)]),prior=receipt.data();
      if(prior&&(prior.payloadHash!==plan.payloadHash||prior.by!==options.uid||prior.mode!=='bulk-empty'))throw new Error('다른 내용·계정의 복원 작업 ID입니다.');
      if(guard.exists&&guard.data().operationId!==plan.operationId)throw new Error('다른 대량 이전 작업이 시작된 대상입니다.');
      if(!prior){for(const c of [...R.PRIMARY,...R.DEPENDENCIES])if(!(await tx.get(db.collection(c).limit(1))).empty)throw new Error('대상 업무 저장소가 비어 있지 않습니다: '+c);}
      if(options.apply&&!prior){tx.create(operation,{schemaVersion:1,mode:'bulk-empty',status:'partial',by:options.uid,createdAt:Date.now(),payloadHash:plan.payloadHash,source:plan.source,documentCount:plan.entries.length,chunkCount:groups.length,completedChunks:0});tx.set(lock,{operationId:plan.operationId,by:options.uid,startedAt:Date.now(),status:'partial'});}
      return{project:options.project,mode:options.apply?'apply':'plan',operationId:plan.operationId,documents:plan.entries.length,chunks:groups.length,status:prior?.status||'ready',completedChunks:prior?.completedChunks||0};
    });
    console.log(JSON.stringify(summary));if(!options.apply||summary.status==='applied')return;
    for(let n=0;n<groups.length;n++){
      const entries=groups[n],chunkRef=operation.collection('chunks').doc(String(n).padStart(6,'0')),digest=R.hash(entries);
      await db.runTransaction(async tx=>{
        await staff(tx);const [chunk,currentOp,guard]=await Promise.all([tx.get(chunkRef),tx.get(operation),tx.get(lock)]);
        if(guard.data()?.operationId!==plan.operationId||currentOp.data()?.payloadHash!==plan.payloadHash)throw new Error('복원 작업 잠금이 바뀌었습니다.');
        const existing=await tx.getAll(...entries.map(e=>db.doc(e.path)));
        if(chunk.exists){if(chunk.data().hash!==digest||existing.some((s,i)=>!s.exists||R.hash(s.data())!==R.hash(entries[i].data)))throw new Error('이전 복원 묶음이 나중에 변경됐습니다. 덮어쓰지 않고 중지합니다.');return;}
        if(existing.some(s=>s.exists))throw new Error('복원 중 대상 문서가 생성됐습니다. 덮어쓰지 않고 중지합니다.');
        for(const e of entries)tx.create(db.doc(e.path),e.data);
        tx.create(chunkRef,{hash:digest,count:entries.length,appliedAt:Date.now(),paths:entries.map(e=>e.path)});
        tx.update(operation,{completedChunks:n+1,status:'partial',updatedAt:Date.now()});
      });
      console.log(JSON.stringify({operationId:plan.operationId,completedChunks:n+1,totalChunks:groups.length,status:'partial'}));
      if(hooks.afterChunk)await hooks.afterChunk(n+1);
    }
    // Re-read every applied record before reporting full completion. An interrupted import remains visibly partial.
    for(const entries of groups){const docs=await db.getAll(...entries.map(e=>db.doc(e.path)));if(docs.some((s,i)=>!s.exists||R.hash(s.data())!==R.hash(entries[i].data)))throw new Error('최종 대조 중 변경된 기록이 있습니다. 복원은 부분 완료 상태입니다.');}
    await db.runTransaction(async tx=>{await staff(tx);const prior=(await tx.get(operation)).data();if(prior.payloadHash!==plan.payloadHash||prior.completedChunks!==groups.length)throw new Error('복원 진행 상태를 확인하세요.');const at=Date.now();tx.update(operation,{status:'applied',appliedAt:at});tx.update(lock,{status:'applied',completedAt:at});tx.set(db.doc('auditEvents/restore-'+plan.operationId),{at,by:options.uid,actorType:'user',action:'operational-restore-bulk',path:operation.path,restored:plan.entries.length,payloadHash:plan.payloadHash});});
    console.log(JSON.stringify({operationId:plan.operationId,status:'applied',restored:plan.entries.length}));
  }finally{await deleteApp(app);}
}
if(require.main===module)main().catch(error=>{console.error('복원 미완료:',error.message);process.exitCode=1;});
module.exports={args,chunks,main};
