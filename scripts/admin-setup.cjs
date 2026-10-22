#!/usr/bin/env node
'use strict';
// Explicit operator action only. The default is a plan, with no SDK import or network access.
const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i<0?'':args[i+1]||'';};
const project=value('--project'),uid=value('--uid');
if(!project||!uid||uid.includes('/')||uid.length>128){console.error('사용법: node scripts/admin-setup.cjs --project PROJECT_ID --uid VERIFIED_UID [--apply] [--emulator]');process.exitCode=1;}
else if(!args.includes('--apply'))console.log(JSON.stringify({mode:'dry-run',project,initialAdminUid:uid,writes:['roles/'+uid,'meta/setup','settings/operations'],note:'실제 쓰기는 없습니다. 계정 UID를 확인한 뒤 --apply를 명시하세요.'},null,2));
else (async()=>{
  const emulator=args.includes('--emulator');
  if(emulator&&(!project.startsWith('demo-')||!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||'')))throw new Error('에뮬레이터는 demo- 프로젝트와 127.0.0.1 주소만 허용합니다.');
  if(!emulator&&process.env.FIRESTORE_EMULATOR_HOST)throw new Error('에뮬레이터 환경 변수와 실제 적용 옵션이 섞여 있습니다.');
  if(emulator){process.env.METADATA_SERVER_DETECTION='none';process.env.GCLOUD_PROJECT=project;}
  const sdk=require('node:module').createRequire(require('node:path').resolve(__dirname,'../functions/package.json'));
  const {initializeApp,applicationDefault}=sdk('firebase-admin/app');
  const {getFirestore}=sdk('firebase-admin/firestore');
  const {getAuth}=sdk('firebase-admin/auth');
  initializeApp({projectId:project,...(emulator?{}:{credential:applicationDefault()})});
  // The actual existing Auth user must be checked for production; do not invent an account.
  const user=emulator?{uid,displayName:'Emulator admin'}:await getAuth().getUser(uid);
  if(user.disabled)throw new Error('비활성화된 계정입니다.');
  const db=getFirestore(),setup=db.doc('meta/setup'),role=db.doc('roles/'+uid),settings=db.doc('settings/operations');
  await db.runTransaction(async tx=>{
    const [lock,existing,settingsDoc]=await Promise.all([tx.get(setup),tx.get(role),tx.get(settings)]);
    if(lock.exists)throw new Error('이미 초기 설정이 완료됐습니다. 기존 관리자가 역할을 관리해야 합니다.');
    const now=Date.now();tx.set(role,{...(existing.data()||{}),role:'admin',name:user.displayName||user.email||uid,at:now,by:'bootstrap-cli'});
    tx.create(setup,{by:uid,at:now,method:'approved-uid-cli'});
    if(!settingsDoc.exists)tx.create(settings,{schemaVersion:1,inspectionDays:90,privacyDays:90,updatedAt:now,updatedBy:uid});
  });console.log('초기 관리자와 설정 잠금을 함께 저장했습니다.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
