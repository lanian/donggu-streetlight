'use strict';
const {test,beforeEach,after}=require('node:test'),assert=require('node:assert/strict');
if(!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||'')){test('restore handlers require loopback emulator',{skip:true},()=>{});}else{
  process.env.FUNCTIONS_EMULATOR='true';process.env.GCLOUD_PROJECT='demo-donggu-restore-tests';process.env.FIREBASE_CONFIG=JSON.stringify({projectId:process.env.GCLOUD_PROJECT});process.env.METADATA_SERVER_DETECTION='none';
  const handlers=require('../index'),{getFirestore}=require('firebase-admin/firestore'),{getApps,deleteApp}=require('firebase-admin/app');
  const {fixture}=require('./restore.test.cjs'),db=getFirestore();
  const request=(data,uid='admin')=>({auth:{uid,token:{email:uid+'@example.invalid',email_verified:true}},data});
  beforeEach(async()=>{await fetch('http://'+process.env.FIRESTORE_EMULATOR_HOST+'/emulator/v1/projects/demo-donggu-restore-tests/databases/(default)/documents',{method:'DELETE'});await db.doc('roles/admin').set({role:'admin'});});
  after(async()=>{await Promise.all(getApps().map(deleteApp));});
  test('server-only restore preserves origins, stock and immutable history; old retry preserves a later edit',async()=>{
    const payload=fixture();await assert.rejects(()=>handlers.previewOperationalRestore.run(request(payload,'outsider')),e=>e.code==='permission-denied');
    const preview=await handlers.previewOperationalRestore.run(request(payload));assert.equal(preview.counts.added,10);
    const [a,b]=await Promise.all([handlers.applyOperationalRestore.run(request({payload,token:preview.token})),handlers.applyOperationalRestore.run(request({payload,token:preview.token}))]);assert.equal(a.restored,10);assert.equal(b.restored,10);assert.equal([a,b].filter(x=>x.replayed).length,1);
    assert.equal((await db.doc('inventory/lamp').get()).data().quantity,9);assert.equal((await db.doc('workOrders/w').get()).data().createdBy,'original-admin');assert.equal((await db.collection('workEvents').get()).size,4);
    const receipt=(await db.doc('restoreOperations/'+payload.operationId).get()).data();assert.equal(receipt.by,'admin');assert.equal(receipt.provenance.find(p=>p.path==='workOrders/w').sourceCreatedBy,'original-admin');
    await db.doc('workOrders/w').update({title:'나중에 수정',revision:5});const retry=await handlers.applyOperationalRestore.run(request({payload,token:preview.token}));assert.equal(retry.replayed,true);assert.equal((await db.doc('workOrders/w').get()).data().title,'나중에 수정');
    await assert.rejects(()=>handlers.applyOperationalRestore.run(request({payload:{...payload,overwrite:true},token:preview.token})),e=>e.code==='failed-precondition');
  });
  test('preview is bound to exact current dependencies, administrator and expiry',async()=>{
    const payload=fixture(),preview=await handlers.previewOperationalRestore.run(request(payload));await db.doc('reports/r1').set({createdAt:1100,lightId:'p1',status:'접수'});
    await assert.rejects(()=>handlers.applyOperationalRestore.run(request({payload,token:preview.token})),e=>e.code==='aborted');assert.equal((await db.doc('workOrders/w').get()).exists,false);
    const fresh=await handlers.previewOperationalRestore.run(request({...payload,overwrite:true})).catch(e=>e);assert.equal(fresh.code,'already-exists');
    const expiring={...payload,operationId:'restore-expiring'},review=await handlers.previewOperationalRestore.run(request(expiring));await db.doc('restoreOperations/restore-expiring').update({expiresAt:1});
    await assert.rejects(()=>handlers.applyOperationalRestore.run(request({payload:expiring,token:review.token})),e=>e.code==='failed-precondition');
    await db.doc('roles/admin').set({role:'inspector'});await assert.rejects(()=>handlers.applyOperationalRestore.run(request({payload,token:preview.token})),e=>e.code==='permission-denied');
  });
  test('missing history is rejected before writing; an existing immutable event cannot be replaced',async()=>{
    const payload=fixture();payload.collections.workEvents.pop();await assert.rejects(()=>handlers.previewOperationalRestore.run(request(payload)),e=>e.code==='failed-precondition');assert.equal((await db.collection('restoreOperations').get()).empty,true);
    const full=fixture(),event={...full.collections.workEvents[0]};delete event.id;await db.doc('workEvents/e0').set({...event,note:'다른 기록'});
    await assert.rejects(()=>handlers.previewOperationalRestore.run(request(full)),e=>e.code==='already-exists');
  });
  test('operational health exposes counts and heartbeat without raw report or staff data',async()=>{
    await db.doc('roles/inspector').set({role:'inspector'});await db.doc('citizen_reports/raw').set({imported:false,contact:'private-contact',desc:'private-message'});await db.doc('systemHealth/retention').set({lastSuccessAt:1,lastFailureAt:0,counts:{reports:2}});
    await db.doc('workOrders/w').set({status:'assigned',assignedTo:'inspector',dueAt:1000});
    await assert.rejects(()=>handlers.getOperationalHealth.run(request({},'outsider')),e=>e.code==='permission-denied');
    const result=await handlers.getOperationalHealth.run(request({},'inspector'));assert.equal(result.scope,'assigned');assert.equal(result.counts.myOpenWorkOrders,1);assert.equal(result.counts.unimportedReports,1);assert.equal(result.services.retention.state,'stale');assert.doesNotMatch(JSON.stringify(result),/private-contact|private-message/);
    await db.doc('meta/operationalRestore').set({status:'partial',operationId:'bulk',startedAt:1000});const maintenance=await handlers.getOperationalHealth.run(request({},'inspector'));assert.equal(maintenance.maintenance.active,true);assert.equal(maintenance.maintenance.operationId,'bulk');
  });
  test('bulk CLI resumes after an interrupted group without duplicating stock or history, then replays its receipt',async()=>{
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
    const source=fixture(),w=source.collections.workOrders[0],collections={workOrders:[],workEvents:[]};
    for(let i=0;i<105;i++){const record={...w,id:'bulk-'+i,status:'assigned',revision:1,updatedAt:1000,reportIds:[],afterPhotos:[],parts:[],costTotal:0,accountedCost:0,stockApplied:{}};delete record.completedAt;delete record.completedBy;delete record.verifiedAt;delete record.verifiedBy;collections.workOrders.push(record);collections.workEvents.push({...source.collections.workEvents[0],id:'bulk-event-'+i,workId:record.id});}
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'donggu-restore-test-')),file=path.join(folder,'backup.json');fs.writeFileSync(file,JSON.stringify({app:'donggu-streetlight',version:2,at:5000,mode:'local',collections}));
    const run=promisify(execFile),script=path.resolve(__dirname,'../scripts/restore-backup.cjs'),args=[script,'--project','demo-donggu-restore-tests','--uid','admin','--file',file,'--operation','bulk-test','--emulator'];
    try{await run(process.execPath,args,{env:process.env});assert.equal((await db.collection('workOrders').get()).empty,true);
      const interrupted='require('+JSON.stringify(script)+').main({afterChunk(n){if(n===1)throw new Error("simulated interruption")}}).catch(e=>{console.error(e.message);process.exitCode=1})';
      await assert.rejects(()=>run(process.execPath,['-e',interrupted,'restore-test',...args.slice(1),'--apply'],{env:process.env}),/simulated interruption/);
      const partial=(await db.doc('restoreOperations/bulk-test').get()).data();assert.equal(partial.status,'partial');assert.equal(partial.completedChunks,1);assert.equal((await db.doc('meta/operationalRestore').get()).data().status,'partial');
      await run(process.execPath,[...args,'--apply'],{env:process.env});assert.equal((await db.collection('workOrders').get()).size,105);assert.equal((await db.doc('restoreOperations/bulk-test').get()).data().status,'applied');await db.doc('workOrders/bulk-0').update({title:'나중 수정'});await run(process.execPath,[...args,'--apply'],{env:process.env});assert.equal((await db.doc('workOrders/bulk-0').get()).data().title,'나중 수정');
    }finally{fs.rmSync(folder,{recursive:true,force:true});}
  });
}
