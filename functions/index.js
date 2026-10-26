'use strict';
const crypto=require('node:crypto');
const {initializeApp}=require('firebase-admin/app');
const {getFirestore,FieldValue}=require('firebase-admin/firestore');
const {getAppCheck}=require('firebase-admin/app-check');
const {onCall,onRequest,HttpsError}=require('firebase-functions/v2/https');
const {onDocumentWrittenWithAuthContext}=require('firebase-functions/v2/firestore');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const {defineSecret,defineString}=require('firebase-functions/params');
const sharp=require('sharp');
const C=require('./core');
initializeApp();
const db=getFirestore();
const restore=require('./restore').createRestoreService(db);
const health=require('./health').createHealthService(db);
const region='asia-northeast3';
const rateSecret=defineSecret('REPORT_RATE_SECRET');
const allowedOrigins=defineString('PUBLIC_REPORT_ORIGINS',{default:''});
const callableOptions={region,enforceAppCheck:process.env.FUNCTIONS_EMULATOR!=='true'};
function fail(error){if(error instanceof HttpsError)throw error;throw new HttpsError(error instanceof C.InputError?error.code:'internal',error instanceof C.InputError?error.message:'작업을 완료하지 못했습니다.');}
function uidOf(request){if(!request.auth)throw new HttpsError('unauthenticated','직원 로그인이 필요합니다.');return request.auth.uid;}
async function roleOf(uid){return (await db.doc('roles/'+uid).get()).data()?.role||'';}
async function adminOnly(request){const uid=uidOf(request);if(await roleOf(uid)!=='admin')throw new HttpsError('permission-denied','관리자 권한이 필요합니다.');if((await db.doc('meta/operationalRestore').get()).data()?.status==='partial')throw new HttpsError('failed-precondition','관리자 대량 이전이 진행 중입니다. 같은 이전 작업을 완료한 뒤 사용해 주세요.');return uid;}
function emailOf(request){const email=String(request.auth?.token?.email||'').toLowerCase();if(!email||request.auth.token.email_verified!==true)throw new HttpsError('failed-precondition','확인된 이메일 계정이 필요합니다.');return email;}
async function commandAudit(transaction,id,by,action,path,detail={}){transaction.create(db.doc('auditEvents/'+id),{at:Date.now(),by,actorType:'user',action,path,...detail});}

exports.previewOperationalRestore=onCall({...callableOptions,timeoutSeconds:120,memory:'512MiB'},async request=>{try{return await restore.preview(await adminOnly(request),request.data);}catch(e){fail(e);}});
exports.applyOperationalRestore=onCall({...callableOptions,timeoutSeconds:120,memory:'512MiB'},async request=>{try{return await restore.apply(await adminOnly(request),request.data);}catch(e){fail(e);}});
exports.getOperationalHealth=onCall(callableOptions,async request=>{try{return await health.query(uidOf(request));}catch(e){fail(e);}});

exports.createStaffInvite=onCall(callableOptions,async request=>{try{
  const by=await adminOnly(request),email=C.text(request.data?.email,254,true).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new C.InputError('초대할 이메일을 확인하세요.');
  const code=crypto.randomBytes(24).toString('base64url'),id=C.hash(code),now=Date.now();
  const dongs=Array.isArray(request.data?.dongs)?request.data.dongs.map(x=>C.text(x,40,true)).slice(0,20):[];
  const ref=db.doc('staffInvites/'+id);
  const batch=db.batch();batch.create(ref,{email,role:'inspector',dongs,createdBy:by,createdAt:now,expiresAt:now+7*86400000,usedBy:null});
  batch.create(db.doc('auditEvents/invite-'+id),{at:now,by,actorType:'user',action:'invite-created',path:ref.path});await batch.commit();
  return {code,expiresAt:now+7*86400000};
}catch(e){fail(e);}});

exports.redeemStaffInvite=onCall(callableOptions,async request=>{try{
  const uid=uidOf(request),email=emailOf(request),code=C.text(request.data?.code,100,true),now=Date.now();
  const invite=db.doc('staffInvites/'+C.hash(code)),role=db.doc('roles/'+uid),limit=db.doc('privateLimits/invite-'+C.hash(uid));
  // Failed guesses consume the per-user quota too; committing the limit separately is intentional.
  await db.runTransaction(async tx=>{const old=await tx.get(limit);tx.set(limit,C.consumeLimit(old.data(),now,10));});
  await db.runTransaction(async tx=>{
    const [i,r]=await Promise.all([tx.get(invite),tx.get(role)]);const value=i.data();
    if(!value||value.email!==email||value.expiresAt<now||value.usedBy&&value.usedBy!==uid)throw new HttpsError('permission-denied','유효한 초대가 아닙니다.');
    if(value.usedBy===uid)return;
    if(r.exists&&r.data().role==='admin')throw new HttpsError('failed-precondition','관리자 계정의 역할은 초대로 변경할 수 없습니다.');
    tx.set(role,{role:'inspector',name:String(request.auth.token.name||email).slice(0,80),dongs:value.dongs||[],at:now,by:value.createdBy},{merge:true});
    tx.update(invite,{usedBy:uid,usedAt:now});
    tx.set(db.doc('joinRequests/'+uid),{uid,email,status:'approved',reviewedBy:value.createdBy,reviewedAt:now,updatedAt:now},{merge:true});
    await commandAudit(tx,'redeem-'+i.id,uid,'invite-redeemed',role.path);
  });return {approved:true};
}catch(e){fail(e);}});

exports.approveJoinRequest=onCall(callableOptions,async request=>{try{
  const by=await adminOnly(request),uid=C.text(request.data?.uid,128,true),decision=request.data?.decision==='reject'?'rejected':'approved',now=Date.now();
  if(uid.includes('/'))throw new C.InputError('사용자 ID를 확인하세요.');
  const ref=db.doc('joinRequests/'+uid),role=db.doc('roles/'+uid);
  await db.runTransaction(async tx=>{const [s,r]=await Promise.all([tx.get(ref),tx.get(role)]);if(!s.exists||s.data().status!=='pending')throw new HttpsError('failed-precondition','대기 중인 신청이 아닙니다.');
    if(decision==='approved')tx.set(role,{role:r.data()?.role==='admin'?'admin':'inspector',name:C.text(s.data().name,80)||uid,at:now,by},{merge:true});
    tx.update(ref,{status:decision,reviewedBy:by,reviewedAt:now,updatedAt:now});await commandAudit(tx,'join-'+uid+'-'+now,by,'join-'+decision,ref.path);
  });return {status:decision};
}catch(e){fail(e);}});

exports.submitCitizenReport=onRequest({region,cors:false,secrets:[rateSecret],maxInstances:10,timeoutSeconds:30,memory:'512MiB'},async(req,res)=>{
  res.set('Cache-Control','no-store');
  const origin=req.get('Origin')||'',origins=allowedOrigins.value().split(',').map(x=>x.trim()).filter(Boolean);
  const emulator=process.env.FUNCTIONS_EMULATOR==='true';
  if(origin&&(origins.includes(origin)||(emulator&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)))){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');}
  else if(origin){res.status(403).json({error:'허용되지 않은 출처입니다.'});return;}
  if(req.method==='OPTIONS'){res.set('Access-Control-Allow-Methods','POST');res.set('Access-Control-Allow-Headers','Content-Type, X-Firebase-AppCheck');res.status(204).end();return;}
  if(req.method!=='POST'){res.status(405).json({error:'POST 요청이 필요합니다.'});return;}
  try{
    if(!emulator){const token=req.get('X-Firebase-AppCheck');if(!token)throw new HttpsError('unauthenticated','앱 확인이 필요합니다.');try{await getAppCheck().verifyToken(token);}catch{throw new HttpsError('unauthenticated','앱 확인을 다시 시도해 주세요.');}}
    if(!req.is('application/json')||Number(req.get('Content-Length')||0)>1600000||JSON.stringify(req.body||{}).length>1600000)throw new C.InputError('신고 요청 크기를 확인하세요.');
    const now=Date.now(),settings=(await db.doc('settings/operations').get()).data()||{};
    const parsed=C.normalizeReport(req.body,now,settings.privacyDays),id='qr-'+C.hash(parsed.requestId),ref=db.doc('citizen_reports/'+id);
    const key=emulator?'emulator-only-rate-key':rateSecret.value();
    // req.ip is the address provided by the managed HTTP runtime. Never use a client-supplied ID as a quota key.
    const rateId=crypto.createHmac('sha256',key).update(req.ip||req.socket.remoteAddress||'unknown').digest('hex');
    const limit=db.doc('privateLimits/report-'+rateId),receipt='R'+new Date(now).toISOString().slice(2,10).replace(/-/g,'')+'-'+id.slice(-8).toUpperCase();
    const fingerprint=C.hash(JSON.stringify({...parsed.rec,at:0,privacyExpiresAt:0})+parsed.photo);
    const photo=await C.normalizePhoto(parsed.photo,sharp);
    const result=await db.runTransaction(async tx=>{
      const [existing,previous]=await Promise.all([tx.get(ref),tx.get(limit)]);
      if(existing.exists){if(existing.data().requestHash!==fingerprint)throw new HttpsError('already-exists','같은 요청 ID의 내용이 다릅니다.');return {receipt:existing.data().receipt,id};}
      tx.set(limit,C.consumeLimit(previous.data(),now,10));
      tx.create(ref,{...parsed.rec,photo,receipt,requestHash:fingerprint});return {receipt,id};
    });await health.record('gateway',true);res.status(200).json(result);
  }catch(e){const code=e.code||'';if(!(e instanceof C.InputError)&&!(e instanceof HttpsError))await health.record('gateway',false,{code});res.status(code==='resource-exhausted'?429:code==='unauthenticated'?401:code==='already-exists'?409:code==='invalid-argument'?400:500).json({error:e instanceof C.InputError||e instanceof HttpsError?e.message:'접수하지 못했습니다. 잠시 후 다시 시도하세요.'});}
});

// Server-owned audit entries use the trigger's authenticated actor, never a client-provided "by" as proof.
exports.recordAudit=onDocumentWrittenWithAuthContext({document:'{collection}/{id}',region},async event=>{
  if(!['roles','joinRequests','lights','photos','inspections','reports','citizen_reports','patrols','workOrders','workEvents','inventory','inventoryMoves','settings','lightingContext','lightingTasks','lightingRuns','lightingAreas','reportEvents'].includes(event.params.collection)||!event.data)return;
  try{
  const before=event.data.before.exists?event.data.before.data():null,after=event.data.after.exists?event.data.after.data():null;
  const record={eventId:event.id,at:Date.parse(event.time)||Date.now(),path:event.params.collection+'/'+event.params.id,by:event.authId||null,actorType:event.authType||'unknown',...C.auditSummary(before,after)};
  try{await db.doc('auditEvents/'+C.hash(event.id)).create(record);}catch(e){if(e.code!==6&&e.code!=='already-exists')throw e;}
  // Legacy/manual staff reports get a server-selected expiry; subsequent edits cannot extend it.
  if(after&&['reports','citizen_reports'].includes(event.params.collection)&&after.privacyExpiresAt==null&&!after.privacyPurgedAt&&C.PRIVATE_FIELDS.some(k=>after[k])){
    const settings=(await db.doc('settings/operations').get()).data()||{};
    await db.runTransaction(async tx=>{const ref=event.data.after.ref,s=await tx.get(ref);if(s.exists&&s.data().privacyExpiresAt==null&&!s.data().privacyPurgedAt)tx.update(ref,{privacyExpiresAt:Date.now()+C.days(settings.privacyDays)*86400000});});
  }
  await health.record('audit',true);
  }catch(error){await health.record('audit',false,{code:error.code});throw error;}
});

exports.purgeExpiredPersonalData=onSchedule({region,schedule:'every 24 hours',timeZone:'Asia/Seoul',timeoutSeconds:540},async()=>{
  const now=Date.now(),counts={citizenReports:0,reports:0,expiredInvites:0,expiredLimits:0,remainingExpired:0};
  try{
  for(const collection of ['citizen_reports','reports'])for(let page=0;page<25;page++){
    const rows=await db.collection(collection).where('privacyExpiresAt','<=',now).limit(400).get();if(rows.empty)break;
    const batch=db.batch();for(const d of rows.docs){const patch=Object.fromEntries(C.PRIVATE_FIELDS.map(k=>[k,FieldValue.delete()]));batch.update(d.ref,{...patch,privacyExpiresAt:FieldValue.delete(),privacyPurgedAt:now});}await batch.commit();counts[collection==='citizen_reports'?'citizenReports':'reports']+=rows.size;
  }
  for(const collection of ['privateLimits','staffInvites'])for(let page=0;page<10;page++){const rows=await db.collection(collection).where('expiresAt','<=',now).limit(400).get();if(rows.empty)break;const batch=db.batch();rows.docs.forEach(d=>batch.delete(d.ref));await batch.commit();counts[collection==='staffInvites'?'expiredInvites':'expiredLimits']+=rows.size;}
  for(const collection of ['citizen_reports','reports'])counts.remainingExpired+=(await db.collection(collection).where('privacyExpiresAt','<=',now).count().get()).data().count;
  await health.record('retention',true,{counts});
  }catch(error){await health.record('retention',false,{code:error.code});throw error;}
});
