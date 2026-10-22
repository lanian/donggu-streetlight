const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const security=require('../../security');
const html=fs.readFileSync(path.resolve(__dirname,'../../index.html'),'utf8');
const between=(a,b)=>{const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start);return html.slice(start,end);};
test('all CSV exports use the common formula-safe cell encoder',()=>{
  for(const value of ['=1+1','+SUM(A1)','-1+2','@cmd',' \t=1','＝1+1'])assert.ok(security.csvCell(value).startsWith('"\''));
  assert.equal(security.csvCell('산수동 "1"'),'"산수동 ""1"""');
  assert.doesNotMatch(html,/const q=v=>/);
});
test('malformed evidence does not crash the shipped review renderer or show an approval button',()=>{
  const record={id:'bad',lightId:'p1',code:'산수동 1',date:1,checks:{},faults:'broken',result:'정상',inspector:'worker',thumbs:'broken'};
  const sandbox={...security,IR:{show:30},S:{insp:[record],names:{}},inspList:()=>[record],byId:()=>null,esc:String,fmtDT:String,fmtD:String,can:()=>true,dl:null};
  vm.createContext(sandbox);vm.runInContext(between('function inspReviewSection(){','async function inspReview('),sandbox);
  const output=vm.runInContext('inspReviewSection()',sandbox);assert.match(output,/사진 형식 오류/);assert.doesNotMatch(output,/data-ichk=/);
  assert.equal(security.safeImageSrc('https://example.invalid/pixel'),'');assert.equal(security.safeImageSrc('data:image/svg+xml;base64,AAAA'),'');
});
test('role change updates an existing role without erasing its assigned districts',async()=>{
  const saved={role:'inspector',name:'tester',dongs:['산수1동']};const sandbox={S:{me:'admin',roles:[{id:'worker',...saved}],names:{}},user:null,db:{doc:()=>({update:async patch=>Object.assign(saved,patch),set:()=>assert.fail('must preserve existing document')})},write:fn=>fn(),ROLE_LABEL:{admin:'관리자'},toast(){}};
  vm.createContext(sandbox);vm.runInContext(between('async function setRole(','async function write('),sandbox);await vm.runInContext('setRole("worker","admin")',sandbox);assert.deepEqual(saved.dongs,['산수1동']);
});
test('Firebase devices default to shared mode while local demo remains durable',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../../security.js'),'utf8');
  for(const [config,expected] of [[{projectId:'demo'},false],[null,true]]){const window={FIREBASE_CONFIG:config,localStorage:{getItem:()=>null}};vm.runInNewContext(source,{window});assert.equal(window.DG_DEVICE_TRUSTED,expected);}
});
test('citizen import refuses to silently use a different signed-in Firebase project',async()=>{
  const sandbox={FB:{auth:{currentUser:{uid:'staff'}},fs:{}},window:{FIREBASE_CONFIG:{projectId:'staff-project'},REPORT_CONFIG:{firestore:{projectId:'report-project'}}}};
  vm.createContext(sandbox);vm.runInContext(between('async function fsApp(){','async function importCitizenReports(){'),sandbox);
  await assert.rejects(()=>vm.runInContext('fsApp()',sandbox),/프로젝트가 달라/);
  sandbox.window.REPORT_CONFIG.firestore.projectId='staff-project';assert.equal(await vm.runInContext('fsApp()',sandbox),sandbox.FB.fs);
});
test('shared-device switch preserves pending offline work and refuses to clear it',async()=>{
  let handle,cleared=0,written=0,message='';
  const window={FIREBASE_CONFIG:{projectId:'demo'},localStorage:{getItem:()=> 'true',setItem:()=>written++},document:{addEventListener:(event,fn)=>handle=fn},DGOffline:{ready:true,jobs:async()=>[{state:'queued'}],list:async()=>[],clear:async()=>cleared++}};
  const button={dataset:{dgAction:'device'},disabled:false},sandbox={window,document:{getElementById:()=>({checked:false})},confirm:()=>true,toast:value=>message=value,FB:{fs:{terminate:()=>assert.fail('pending work must block'),clearPersistence:()=>assert.fail('pending work must block')}}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../security.js'),'utf8'),sandbox);
  await handle({target:{closest:()=>button},preventDefault(){}});
  assert.equal(cleared,0);assert.equal(written,0);assert.equal(window.DG_DEVICE_TRUSTED,true);assert.match(message,/미전송 작업/);
});
function deviceFixture(offline,integration){
  let handle,cleared=0,written=0,reloaded=0,message='',signedOut=0;
  const window={FIREBASE_CONFIG:{projectId:'demo'},localStorage:{getItem:()=> 'true',setItem:()=>written++},document:{addEventListener:(event,fn)=>handle=fn},DGOffline:{clear:async()=>cleared++,...offline},DGIntegration:integration};
  const button={dataset:{dgAction:'device'},disabled:false},sandbox={window,document:{getElementById:()=>({checked:false})},confirm:()=>true,toast:value=>message=value,location:{reload:()=>reloaded++},FB:{auth:{signOut:async()=>signedOut++},fs:{terminate:async()=>{},clearPersistence:async()=>{}}}};
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../security.js'),'utf8'),sandbox);sandbox.DGSecurity=window.DGSecurity;
  return {window,sandbox,change:()=>handle({target:{closest:()=>button},preventDefault(){}}),result:()=>({cleared,written,reloaded,message,signedOut})};
}
test('device mode can change before login without reading an unconfigured offline namespace',async()=>{
  const unexpected=()=>assert.fail('Unconfigured stores cannot be accessed'),fixture=deviceFixture({ready:false,jobs:unexpected,list:unexpected,clear:unexpected});
  await fixture.change();assert.equal(fixture.result().written,1);assert.equal(fixture.result().reloaded,1);assert.equal(fixture.window.DG_DEVICE_TRUSTED,false);
});
test('an authenticated in-memory draft still blocks device switching while its store is unavailable',async()=>{
  const unexpected=()=>assert.fail('Unavailable stores cannot be accessed'),fixture=deviceFixture({ready:false,jobs:unexpected,list:unexpected},{hasUnsavedSync:()=>true});
  fixture.sandbox.FB.auth.currentUser={uid:'staff'};
  await fixture.change();assert.equal(fixture.result().written,0);assert.equal(fixture.result().reloaded,0);assert.match(fixture.result().message,/초안/);
});
test('device mode flushes active forms before checking all four draft categories',async()=>{
  for(const kind of ['draft','patrol','workDraft','workCompletion']){
    const persisted=[];
    const fixture=deviceFixture({ready:true,jobs:async()=>[],list:async name=>{assert.deepEqual(persisted,['draft','patrol']);return name===kind?[{id:'pending'}]:[];}},{persistDraft:async()=>{await Promise.resolve();persisted.push('draft');},persistPatrol:async()=>{await Promise.resolve();persisted.push('patrol');}});
    await fixture.change();assert.equal(fixture.result().cleared,0,kind);assert.equal(fixture.result().written,0,kind);assert.match(fixture.result().message,/초안/);
  }
});
test('device mode delegates the unsaved check to the shared integration after awaiting active saves',async()=>{
  const events=[],fixture=deviceFixture({ready:true,jobs:()=>assert.fail('Use the common integration guard'),list:()=>assert.fail('Use the common integration guard')},{persistDraft:async()=>events.push('draft'),persistPatrol:async()=>events.push('patrol'),hasUnsaved:async()=>{events.push('check');return true;}});
  await fixture.change();assert.deepEqual(events,['draft','patrol','check']);assert.equal(fixture.result().cleared,0);assert.equal(fixture.result().written,0);
});
test('logout asks before discarding any draft category and still permits an explicit logout',async()=>{
  for(const kind of ['draft','patrol','workDraft','workCompletion']){
    const fixture=deviceFixture({ready:true,jobs:async()=>[],list:async name=>name===kind?[{id:'draft'}]:[]});
    vm.runInContext(between('async function fbSignOut(){','function vSignIn(){'),fixture.sandbox);
    fixture.sandbox.confirm=()=>false;await vm.runInContext('fbSignOut()',fixture.sandbox);assert.equal(fixture.result().signedOut,0,kind);
    fixture.sandbox.confirm=()=>true;await vm.runInContext('fbSignOut()',fixture.sandbox);assert.equal(fixture.result().signedOut,1,kind);
  }
});
