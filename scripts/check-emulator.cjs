#!/usr/bin/env node
'use strict';
// Both suites must run against a local emulator. Never silently pass through a skip.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const host=process.env.FIRESTORE_EMULATOR_HOST||'';
if(!/^127\.0\.0\.1:\d+$/.test(host)){
  console.error('FIRESTORE_EMULATOR_HOST must identify a 127.0.0.1 Firestore emulator.');
  process.exit(1);
}
const cwd=path.resolve(__dirname,'..');
for(const [name,args,projectId] of [
  ['Firestore authorization rules',['--test','scripts/tests/firestore-rules.emulator.cjs'],'demo-donggu-streetlight'],
  ['Functions server operations',['functions/test/server.emulator.cjs'],'demo-donggu-server-tests']
]){
  console.log('Checking '+name);
  // Firebase CLI injects FIREBASE_CONFIG; give each suite the same demo project
  // for Admin SDK initialization and its explicit emulator cleanup requests.
  const env={...process.env,GCLOUD_PROJECT:projectId,GOOGLE_CLOUD_PROJECT:projectId,FIREBASE_CONFIG:JSON.stringify({projectId})};
  const result=spawnSync(process.execPath,args,{cwd,env,stdio:'inherit',timeout:180000});
  if(result.error)console.error(result.error.message);
  if(result.status!==0){process.exit(Number.isInteger(result.status)?result.status:1);}
}
