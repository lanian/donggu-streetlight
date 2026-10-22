#!/usr/bin/env node
'use strict';
// Existing records need one explicit migration; this tool defaults to a network-free plan.
const args=process.argv.slice(2),at=args.indexOf('--project'),project=at<0?'':args[at+1];
if(!project){console.error('사용법: node scripts/backfill-retention.cjs --project PROJECT_ID [--apply]');process.exitCode=1;}
else if(!args.includes('--apply'))console.log(JSON.stringify({mode:'dry-run',project,collections:['reports','citizen_reports'],action:'연락처·사진·위치가 남은 기존 문서에 privacyExpiresAt 추가. 생성시각+보관일을 사용하며 기존 만료값은 연장하지 않음.'},null,2));
else(async()=>{const sdk=require('node:module').createRequire(require('node:path').resolve(__dirname,'../functions/package.json'));
  const {initializeApp,applicationDefault}=sdk('firebase-admin/app'),{getFirestore,FieldPath}=sdk('firebase-admin/firestore');
  initializeApp({projectId:project,credential:applicationDefault()});const db=getFirestore(),config=(await db.doc('settings/operations').get()).data()||{},days=require('../functions/core').days(config.privacyDays);let updated=0;
  for(const name of ['reports','citizen_reports']){let cursor;for(;;){let query=db.collection(name).orderBy(FieldPath.documentId()).limit(400);if(cursor)query=query.startAfter(cursor);const result=await query.get();if(result.empty)break;const batch=db.batch();for(const doc of result.docs){const data=doc.data();if(data.privacyExpiresAt!=null||data.privacyPurgedAt||!['contact','photo','lat','lng'].some(k=>data[k]!=null&&data[k]!==''))continue;const created=data.at||data.createdAt;batch.update(doc.ref,{privacyExpiresAt:(Number.isFinite(created)&&created>0?Math.min(created,Date.now()):Date.now())+days*86400000});updated++;}await batch.commit();cursor=result.docs.at(-1);}}
  console.log('보관 만료값을 추가한 문서: '+updated);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
