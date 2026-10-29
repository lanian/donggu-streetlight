const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.resolve(__dirname,'../../app/patrol-history.js'),'utf8');
const scope=vm.createContext({});
vm.runInContext(code,scope);
const patrol=scope.DGPatrolHistory;
const marks=Array.from({length:120},(_,i)=>({id:'L'+i,code:'등-'+i,result:i%10===0?'고장':i%7===0?'점검필요':'정상',at:1000+i}));
const spots=Array.from({length:12},(_,i)=>({lat:35+i/1000,lng:126,at:1200+i,near:'L'+i}));
test('records remain complete and the initial view renders only 10 recent rows',()=>{
 const original={marks:marks.map(m=>({...m})),spots:spots.map(x=>({...x}))};
 const snap=patrol.snapshot(original);
 assert.equal(snap.total,132);
 assert.equal(snap.visible.length,10);
 assert.equal(snap.remaining,122);
 assert.equal(snap.latest.type,'spot');
 assert.equal(snap.latest.index,11);
 assert.equal(original.marks.length,120,'display pagination never modifies stored marks');
 assert.equal(original.spots.length,12,'display pagination never modifies spots');
});
test('filters include dark spot as a follow-up without misclassifying GPS passage as a check',()=>{
 const snap=patrol.snapshot({marks,spots,passed:new Map([['some','pass']])});
 const problems=marks.filter(m=>m.result!=='정상').length+spots.length;
 assert.equal(snap.issues,problems);
 assert.equal(snap.normal,marks.filter(m=>m.result==='정상').length);
 assert.equal(patrol.snapshot({marks,spots},{filter:'issues',limit:200}).visible.length,problems);
 assert.equal(patrol.snapshot({marks,spots},{filter:'normal',limit:200}).visible.length,snap.normal);
 assert.equal(patrol.snapshot({marks:[],spots:[],passed:new Map([['X',{}]])}).total,0);
});
test('unreviewed candidate list hides recorded lamps but allows explicit review',()=>{
 const ahead=[{l:{id:'L0',code:'A'}},{l:{id:'L1',code:'B'}},{l:{id:'L2',code:'C'}}];
 const checked=[{id:'L0',result:'정상'},{id:'L2',result:'고장'}];
 const ids=arr=>Array.from(arr,x=>x.l.id);
 assert.deepEqual(ids(patrol.candidates(ahead,checked)),['L1']);
 assert.deepEqual(ids(patrol.candidates(ahead,checked,true)),['L0','L1','L2']);
 assert.equal(patrol.unmarkedTarget(ahead,checked).id,'L1');
 assert.equal(patrol.unmarkedTarget(ahead,[...checked,{id:'L1'}]),null);
 assert.equal(ahead.length,3);
});
test('spot indices are preserved when sorted by time for the remove button',()=>{
 const snap=patrol.snapshot({marks:[{id:'A',at:4}],spots:[{at:9},{at:2},{at:7}]},{limit:20});
 assert.deepEqual(Array.from(snap.visible,r=>[r.type,r.index]),[['spot',0],['spot',2],['mark',0],['spot',1]]);
});
test('page size is bounded even for 10,000 observations',()=>{
 const large={marks:Array.from({length:10000},(_,i)=>({id:String(i),result:'정상',at:i})),spots:[]};
 assert.equal(patrol.snapshot(large,{limit:10}).visible.length,10);
 assert.equal(patrol.snapshot(large,{limit:99999}).visible.length,500);
 assert.equal(patrol.snapshot(large,{limit:-5}).visible.length,1);
 assert.equal(patrol.snapshot(large).total,10000);
});
