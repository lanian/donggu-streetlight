// Invoke the actual exported server handlers against a loopback Firestore emulator.
// Auth/App Check transport verification belongs to the deployed Firebase runtime;
// these tests cover the handler's authorization and transaction behavior only.
const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict');
if(!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||'')){
  test('server handlers require a loopback emulator',{skip:true},()=>{});
}else{
  process.env.FUNCTIONS_EMULATOR='true';process.env.GCLOUD_PROJECT='demo-donggu-server-tests';process.env.METADATA_SERVER_DETECTION='none';
  const handlers=require('../index');
  const {getFirestore}=require('firebase-admin/firestore');
  const {getApps,deleteApp}=require('firebase-admin/app');
  const db=getFirestore();
  const auth=(uid,email)=>({uid,token:{email,email_verified:true,name:uid}});
  const adminRequest=data=>({auth:auth('admin','admin@example.invalid'),data});
  beforeEach(async()=>{await fetch('http://'+process.env.FIRESTORE_EMULATOR_HOST+'/emulator/v1/projects/demo-donggu-server-tests/databases/(default)/documents',{method:'DELETE'});await db.doc('roles/admin').set({role:'admin'});});
  after(async()=>{await Promise.all(getApps().map(deleteApp));});
  test('bootstrap CLI atomically selects exactly one explicitly supplied administrator under a race',async()=>{
    const {execFile}=require('node:child_process'),{promisify}=require('node:util'),path=require('node:path');
    const run=promisify(execFile),script=path.resolve(__dirname,'../../scripts/admin-setup.cjs');
    const results=await Promise.allSettled(['first-admin','racer-admin'].map(uid=>run(process.execPath,[script,'--project','demo-donggu-server-tests','--uid',uid,'--apply','--emulator'],{env:process.env})));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1,results.map(result=>result.status==='rejected'?result.reason.stderr:'completed').join('\n'));
    const lock=(await db.doc('meta/setup').get()).data();assert.ok(['first-admin','racer-admin'].includes(lock.by));
    assert.equal((await db.doc('roles/'+lock.by).get()).data().role,'admin');
    const loser=lock.by==='first-admin'?'racer-admin':'first-admin';assert.equal((await db.doc('roles/'+loser).get()).exists,false);
  });
  test('invitation is admin-created, email-bound, one-time and retry safe',async()=>{
    await assert.rejects(()=>handlers.createStaffInvite.run({auth:auth('outsider','o@example.invalid'),data:{email:'new@example.invalid'}}),e=>e.code==='permission-denied');
    const result=await handlers.createStaffInvite.run(adminRequest({email:'new@example.invalid'}));assert.match(result.code,/^[\w-]{32}$/);
    await assert.rejects(()=>handlers.redeemStaffInvite.run({auth:auth('wrong','wrong@example.invalid'),data:{code:result.code}}),e=>e.code==='permission-denied');
    const request={auth:auth('new','new@example.invalid'),data:{code:result.code}};
    await handlers.redeemStaffInvite.run(request);await handlers.redeemStaffInvite.run(request);
    assert.equal((await db.doc('roles/new').get()).data().role,'inspector');
    await assert.rejects(()=>handlers.redeemStaffInvite.run({auth:auth('another','new@example.invalid'),data:{code:result.code}}),e=>e.code==='permission-denied');
  });
  test('join approval creates role and decision together and preserves existing district assignment',async()=>{
    await db.doc('joinRequests/new').set({uid:'new',name:'새 직원',status:'pending'});await db.doc('roles/new').set({role:'resident',dongs:['산수1동']});
    await handlers.approveJoinRequest.run(adminRequest({uid:'new'}));
    assert.equal((await db.doc('joinRequests/new').get()).data().status,'approved');
    assert.deepEqual((await db.doc('roles/new').get()).data().dongs,['산수1동']);
    await assert.rejects(()=>handlers.approveJoinRequest.run(adminRequest({uid:'new'})),e=>e.code==='failed-precondition');
  });
  function submit(body,ip='127.0.0.42'){
    return new Promise((resolve,reject)=>{
      const headers={origin:'http://localhost:9000','content-type':'application/json'};
      const req={method:'POST',body,headers,ip,socket:{remoteAddress:ip},get:key=>headers[key.toLowerCase()]||'',is:value=>value==='application/json'};
      const res={statusCode:200,set(){return this},status(status){this.statusCode=status;return this},json(data){resolve({status:this.statusCode,data});return this},end(){resolve({status:this.statusCode});return this},on(){return this},once(){return this}};
      Promise.resolve(handlers.submitCitizenReport(req,res)).catch(reject);
    });
  }
  test('gateway handles concurrent retries once and rejects replayed IDs with changed contents',async()=>{
    const body={requestId:'same-request-aaaaaaaaaaaa',code:'산수동 1',issue:'꺼짐',desc:'',consent:false};
    const results=await Promise.all([submit(body),submit(body)]);assert.ok(results.every(r=>r.status===200));assert.equal(results[0].data.receipt,results[1].data.receipt);
    const rows=await db.collection('citizen_reports').get();assert.equal(rows.size,1);assert.equal(typeof rows.docs[0].data().at,'number');assert.ok(rows.docs[0].data().privacyExpiresAt>rows.docs[0].data().at);
    assert.equal((await submit({...body,desc:'different'})).status,409);
    for(let i=0;i<9;i++)assert.equal((await submit({...body,requestId:'another-request-'+String(i).padStart(16,'0')})).status,200);
    assert.equal((await submit({...body,requestId:'over-quota-aaaaaaaaaaaaaa'})).status,429);
  });
  test('server audit is idempotent and the expiry job removes sensitive values in both copies',async()=>{
    const ref=db.doc('reports/private');await ref.set({status:'접수',contact:'secret',photo:'private',desc:'work detail',privacyExpiresAt:1});
    const snap=await ref.get();const event={id:'stable-cloud-event',time:new Date().toISOString(),authId:'inspector',authType:'user',params:{collection:'reports',id:'private'},data:{before:{exists:false},after:snap}};
    await handlers.recordAudit.run(event);await handlers.recordAudit.run(event);
    const logs=await db.collection('auditEvents').get();assert.equal(logs.size,1);assert.doesNotMatch(JSON.stringify(logs.docs[0].data()),/secret|private-photo/);
    await db.doc('citizen_reports/raw').set({contact:'secret',photo:'private',lat:35,lng:126,privacyExpiresAt:1});
    await db.doc('staffInvites/expired').set({email:'expired@example.invalid',expiresAt:1});
    await handlers.purgeExpiredPersonalData.run({});
    for(const key of ['reports/private','citizen_reports/raw']){const value=(await db.doc(key).get()).data();assert.equal(value.contact,undefined);assert.equal(value.photo,undefined);assert.equal(value.lat,undefined);assert.ok(value.privacyPurgedAt);}
    assert.equal((await db.doc('staffInvites/expired').get()).exists,false);
  });
  test('lighting context changes receive a server-owned audit without copying observation text or locations',async()=>{
    const ref=db.doc('lightingContext/external');
    await ref.set({kind:'observation',label:'현장 관찰',revision:1,status:'on',note:'private-observation-note',operator:'private-operator',lat:35.15,lng:126.92});
    const event={id:'lighting-cloud-event',time:new Date().toISOString(),authId:'inspector',authType:'user',params:{collection:'lightingContext',id:'external'},data:{before:{exists:false},after:await ref.get()}};
    await handlers.recordAudit.run(event);await handlers.recordAudit.run(event);
    const logs=await db.collection('auditEvents').get();assert.equal(logs.size,1);
    const value=logs.docs[0].data();assert.equal(value.by,'inspector');assert.equal(value.path,'lightingContext/external');assert.equal(value.after.revision,1);
    assert.doesNotMatch(JSON.stringify(value),/private-observation-note|private-operator|35\.15|126\.92/);
    assert.ok(value.changedFields.includes('note'));
  });
}
