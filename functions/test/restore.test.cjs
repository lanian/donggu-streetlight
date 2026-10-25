'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const R=require('../restore-core');
const client=require('../../app/restore');
const {chunks}=require('../scripts/restore-backup.cjs');
function fixture(){
  const work={schemaVersion:1,lightId:'p1',code:'산수동 1',dong:'산수동',title:'복원 대상',description:'',type:'수리',priority:'보통',status:'verified',assignedTo:'original-inspector',dueAt:5000,createdAt:1000,createdBy:'original-admin',updatedAt:4000,updatedBy:'original-admin',revision:4,reportIds:['r1'],inspectionIds:[],beforePhotos:[],afterPhotos:['after'],completionNote:'교체 완료',completedAt:3000,completedBy:'original-inspector',verificationNote:'확인',verifiedAt:4000,verifiedBy:'original-admin',parts:[{name:'램프',qty:1,unitCost:100,inventoryId:'lamp'}],costTotal:100,accountedCost:100,measurements:[],stockApplied:{lamp:1}};
  const statuses=['assigned','in_progress','completed','verified'];
  return{operationId:'restore-test',overwrite:false,source:{app:'donggu-streetlight',version:2,mode:'local',at:5000},collections:{
    workOrders:[{id:'w',...work}],
    workEvents:statuses.map((status,i)=>({id:'e'+i,workId:'w',lightId:'p1',fromStatus:i?statuses[i-1]:'',toStatus:status,type:i?'transition':'created',note:'',at:(i+1)*1000,by:[0,3].includes(i)?'original-admin':'original-inspector',revision:i+1,createdAt:1000,costTotal:i>=2?100:0,costDelta:i===3?100:0})),
    inventory:[{id:'lamp',name:'램프',unit:'개',quantity:9,unitCost:100,revision:2,updatedAt:4000,updatedBy:'original-admin'}],
    inventoryMoves:[{id:'initial',itemId:'lamp',delta:10,reason:'초기',at:1000,by:'original-admin',revision:1},{id:'used',itemId:'lamp',delta:-1,reason:'검수',at:4000,by:'original-admin',revision:2,workId:'w'}],
    photos:[{id:'after',lightId:'p1',workId:'w',kind:'work',by:'original-inspector',at:3000,data:'data:image/jpeg;base64,dGVzdA=='}],
    reports:[{id:'r1',lightId:'p1',workId:'w',createdAt:1100,updatedAt:4000,status:'완료',contact:''}]
  }};
}
test('restore validates completed workflow graph without replaying stock or costs',()=>{
  const input=fixture(),plan=R.normalize(input),result=R.validateGraph(plan,new Map());
  assert.equal(result.writes.length,10);assert.equal(result.result.get('inventory/lamp').quantity,9);assert.equal(result.result.get('workOrders/w').accountedCost,100);
  for(const mutate of [v=>v.collections.workEvents.pop(),v=>v.collections.inventory[0].quantity=8,v=>v.collections.photos=[],v=>v.collections.workOrders[0].accountedCost=200]){const copy=structuredClone(input);mutate(copy);assert.throws(()=>R.validateGraph(R.normalize(copy),new Map()));}
});
test('restore rejects privilege collections, malformed values and immutable collisions',()=>{
  const input=fixture();assert.throws(()=>R.normalize({...input,collections:{...input.collections,roles:[{id:'outsider',role:'admin'}]}}));
  const modified=structuredClone(input);modified.collections.workOrders[0].parts[0].qty=Infinity;assert.throws(()=>R.normalize(modified));
  const plan=R.normalize(input),old=new Map([['workEvents/e0',{...input.collections.workEvents[0],id:undefined}]]);old.set('workEvents/e0',{...plan.entries.find(e=>e.path==='workEvents/e0').data,note:'later history'});assert.throws(()=>R.validateGraph(plan,old),e=>e.code==='already-exists');
  const newer=new Map([['inventory/lamp',{...plan.entries.find(e=>e.path==='inventory/lamp').data,revision:3}]]);assert.throws(()=>R.validateGraph({...plan,overwrite:true},newer),e=>e.code==='failed-precondition');
});
test('client preflight blocks missing functions and oversized plans before any mutation',async()=>{
  const v=fixture(),backup={app:'donggu-streetlight',version:2,at:5000,mode:'local',collections:v.collections};let calls=0;
  await assert.rejects(()=>client.prepareBackup(backup,{functionsEnabled:false,call:async()=>{calls++}}),/서버/);assert.equal(calls,0);
  const built=client.buildPayload(backup,{operationId:'fixed'});assert.equal(built.operationId,'fixed');assert.equal(built.collections.photos.length,1);assert.equal(built.collections.reports.length,1);
  const evidence=structuredClone(backup);evidence.collections.workOrders[0].inspectionIds=['i1'];evidence.collections.inspections=[{id:'i1',lightId:'p1',inspector:'original-inspector',date:1000,result:'정상',thumbs:[{id:'inspection-photo',t:'data:image/jpeg;base64,dGVzdA=='}]}];evidence.collections.photos.push({id:'inspection-photo',inspectionId:'i1',lightId:'p1',by:'original-inspector',kind:'inspection',at:1000,data:'data:image/jpeg;base64,dGVzdA=='});
  const included=client.buildPayload(evidence,{operationId:'with-inspection'});assert.equal(included.collections.photos.length,2);assert.equal(R.validateGraph(R.normalize(included),new Map()).writes.length,12);
  assert.throws(()=>client.checkLimit({collections:{workEvents:Array.from({length:201},(_,i)=>({id:String(i)}))}}),/200/);
  const groups=chunks(Array.from({length:401},(_,i)=>({path:'workEvents/'+i,data:{note:'x'}})));assert.deepEqual(groups.map(x=>x.length),[200,200,1]);
});
module.exports={fixture};
