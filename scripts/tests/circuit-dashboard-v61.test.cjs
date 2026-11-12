const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const C=require('../../app/operations-core');
function fixture(){let actor='local';const callbacks={},fields={'#dgDashFrom':{value:'2026-11-01'},'#dgDashTo':{value:'2026-11-07'}},now=Date.parse('2026-11-03T00:00:00+09:00');let resolve,gate;
 const rows={inspections:[{lightId:'p1',result:'고장',date:now},{lightId:'p2',result:'고장',date:now}],workOrders:[],reports:[],workEvents:[],assetLinks:[{lightId:'p1',circuitId:'c1'}],circuits:[{id:'c1',label:'분전함1 회로1'}]};
 const ctx=vm.createContext({console,Date,Promise,setTimeout(){},navigator:{onLine:true},document:{querySelector:key=>fields[key],addEventListener:(name,fn)=>callbacks[name]=fn},DGOperationsCore:C,DGOffline:{register(){}},DGOperations:{state:{settings:{}}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../app/management.js'),'utf8'),ctx);
 ctx.DGManagement.attach({esc:String,state:()=>({me:actor,lights:[{id:'p1',sw:'GPS'},{id:'p2',sw:'GPS'}]}),firebase:()=>null,can:()=>true,render(){},fmtDT:String,toast(){},readAll:async(c,o)=>{if(gate)await gate;o.onMetadata?.({source:'local',complete:true});return rows[c]||[];}});
 return {m:ctx.DGManagement,actor:v=>actor=v,gate:()=>{gate=new Promise(r=>resolve=r);return()=>resolve();},run:async()=>{callbacks.click({target:{closest:()=>({dataset:{mgmt:'dashboard-load'}})}});for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));}};
}
test('dashboard groups only confirmed physical circuits and keeps switch type statistics separate',async()=>{const f=fixture();await f.run();assert.deepEqual(Array.from(f.m.state.analytics.circuits,x=>Array.from(x)),[['분전함1 회로1',1],['회로 미등록',1]]);assert.deepEqual(Array.from(f.m.state.analytics.switchTypes,x=>Array.from(x)),[['GPS',2]]);});
test('dashboard does not publish prior account records when a full read resolves after account change',async()=>{const f=fixture(),release=f.gate();const pending=f.run();await new Promise(r=>setImmediate(r));f.actor('other');release();await pending;assert.equal(f.m.state.analytics,null);});
test('different physical circuits retain separate counts when their names are equal',()=>{
 const value=C.analytics([{lightId:'p1',result:'고장',date:1},{lightId:'p2',result:'고장',date:1},{lightId:'p2',result:'고장',date:2}],[],[],[{id:'p1',sw:'GPS'},{id:'p2',sw:'GPS'}],0,3,[],{links:[{lightId:'p1',circuitId:'c1'},{lightId:'p2',circuitId:'c2'}],circuits:[{id:'c1',label:'1회로',code:'함A'},{id:'c2',label:'1회로',code:'함B'}]});
 assert.deepEqual(value.circuits,[['1회로 (함B · c2)',2],['1회로 (함A · c1)',1]]);assert.deepEqual(value.switchTypes,[['GPS',3]]);
});
