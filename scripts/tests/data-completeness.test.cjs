const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const html=fs.readFileSync(path.resolve(__dirname,'../../index.html'),'utf8');
const dataJS=fs.readFileSync(path.resolve(__dirname,'../../app/data.js'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
function context(extra={}){const security=require('../../security.js'),c=vm.createContext({console,Date,Math,Blob,crypto:webcrypto,window:{},FB:null,S:{me:'staff'},render(){},toast(){},confirm:()=>true,resolveNames(){},...security,DGSecurity:security,...extra});vm.runInContext(dataJS,c);c.listAllRecords=(name,opts)=>c.DGData.readAll(c.db,name,opts);return c}
function load(c,start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert(a>=0&&b>a,start);vm.runInContext(html.slice(a,b),c)}
function backing(initial={}){let data=JSON.stringify(initial);return{fail:false,getItem:()=>data,setItem(key,value){if(this.fail)throw Object.assign(new Error('quota'),{name:'QuotaExceededError'});data=value},dump:()=>JSON.parse(data)}}
function local(initial={}){const storage=backing(initial),c=context();return{storage,db:c.DGData.createLocalDB({storage}),api:c.DGData}}
function firestore(initial={}){
  const records=clone(initial),calls=[];let serial=Promise.resolve(),fail=null,batches=0;
  const doc=key=>({path:key,get:async()=>snapshot(key),set:async(data,opts)=>{if(fail&&key.startsWith(fail))throw Error('failed '+key);records[key]=opts?{...(records[key]||{}),...clone(data)}:clone(data)},update:async data=>{if(fail&&key.startsWith(fail))throw Error('failed '+key);records[key]={...(records[key]||{}),...clone(data)}},delete:async()=>delete records[key]});
  const snapshot=key=>({id:key.split('/')[1],exists:key in records,data:()=>records[key]&&clone(records[key])});
  const query=(collection,state={where:[],order:[],limit:Infinity,after:null})=>({
    where:(...x)=>query(collection,{...state,where:[...state.where,x]}),orderBy:(...x)=>query(collection,{...state,order:[...state.order,x]}),limit:n=>query(collection,{...state,limit:n}),startAfter:cursor=>query(collection,{...state,after:cursor.id}),
    get:async options=>{calls.push({collection,...state,options});let rows=Object.keys(records).filter(k=>k.startsWith(collection+'/')).map(k=>snapshot(k));
      rows=rows.filter(d=>state.where.every(([f,op,v])=>{const x=d.data()[f];return op==='=='?x===v:op==='>='?x>=v:op==='<='?x<=v:false}));
      rows.sort((a,b)=>{for(const[f,dir]of state.order){const x=f==='__name__'?a.id:a.data()[f],y=f==='__name__'?b.id:b.data()[f];if(x!==y)return(x<y?-1:1)*(dir==='desc'?-1:1)}return a.id.localeCompare(b.id)});
      if(state.after)rows=rows.slice(rows.findIndex(d=>d.id===state.after)+1);return{docs:rows.slice(0,state.limit),metadata:{fromCache:false}};
    }
  });
  const db={doc,collection:name=>query(name),app:{options:{projectId:'demo'}},batch(){const writes=[];return{set(ref,data,opts){writes.push([ref,data,opts])},async commit(){batches++;if(fail==='batch')throw Object.assign(Error('rejected'),{code:'permission-denied'});for(const[ref,data,opts]of writes)await ref.set(data,opts)}}},runTransaction(fn){const pending=serial.then(async()=>{const writes=[];await fn({get:ref=>ref.get(),set:(ref,d)=>writes.push(()=>ref.set(d)),update:(ref,d)=>writes.push(()=>ref.update(d))});for(const write of writes)await write()});serial=pending.catch(()=>{});return pending}};
  return{db,records,calls,fail:path=>fail=path,batchCount:()=>batches};
}
function appStorage(c){load(c,'async function lightState(id,server=false){','/* ---------- Firebase mode');load(c,'async function write(fn,okMsg){','// Downscale')}

test('two independent local clients preserve writes and atomic conditional mutations',async()=>{
  const s=backing({lights:{p:{status:'정상'}},workOrders:{w:{revision:1,status:'new'}}}),a=context().DGData.createLocalDB({storage:s}),b=context().DGData.createLocalDB({storage:s});
  await a.doc('inspections/a').set({date:1});await b.doc('inspections/b').set({date:2});assert.deepEqual(Object.keys(s.dump().inspections).sort(),['a','b']);
  await a.commitMany([{path:'workOrders/w',data:{revision:2,status:'assigned'},merge:true}],{expected:{'workOrders/w':1}});
  await assert.rejects(b.commitMany([{path:'workOrders/w',data:{revision:3,status:'stale'},merge:true},{path:'workEvents/bad',data:{event:'should not exist'}}],{expected:{'workOrders/w':1}}),{code:'conflict'});
  assert.equal(s.dump().workOrders.w.revision,2);assert.equal(s.dump().workEvents,undefined);
  await a.doc('lights/p').update({updatedAt:10});await assert.rejects(b.commitMany([{path:'reports/r',data:{}}],{expected:{'lights/p':{field:'updatedAt',value:9}}}),{code:'conflict'});
  assert.equal(s.dump().reports,undefined);
  await a.commitMany([{path:'lights/p',data:{note:'accepted'},merge:true}],{expected:{'lights/p':{document:{updatedAt:10,status:'정상'}}}});
  await assert.rejects(b.commitMany([{path:'lights/p',data:{note:'stale'},merge:true}],{expected:{'lights/p':{document:{status:'정상',updatedAt:10}}}}),{code:'conflict'});
  assert.equal(s.dump().lights.p.note,'accepted');
});

test('Firestore complete reads use cursors and a stable ID tie breaker across equal dates',async()=>{
  const initial={};for(let i=0;i<1001;i++)initial['inspections/i'+String(i).padStart(4,'0')]={date:10,result:'정상'};
  const f=firestore(initial),c=context();const rows=await c.DGData.readAll(f.db,'inspections',{where:[['date','>=',10]],orderBy:[['date','desc']],pageSize:120,requireServer:true});
  assert.equal(rows.length,1001);assert.equal(new Set(rows.map(r=>r.id)).size,1001);assert.equal(f.calls.length,9);assert(f.calls.every(x=>x.options.source==='server'));assert(f.calls.slice(1).every(x=>x.after));
  assert.deepEqual(f.calls[0].order.map(x=>Array.from(x)),[['date','desc'],['__name__','desc']]);
  await assert.rejects(c.DGData.readAll({collection:()=>({get:async()=>({docs:[],hasMore:true})})},'x'),{code:'incomplete-query'});
});

test('first light overrides preserve concurrent fields on local and append-only artifact stores',async()=>{
  const {db,storage}=local({lights:{}}),c=context({db,S:{me:'local'}});appStorage(c);
  await Promise.all([c.patchLight('p',{status:'고장'}),c.patchLight('p',{lat:35})]);assert.equal(storage.dump().lights.p.status,'고장');assert.equal(storage.dump().lights.p.lat,35);
  const f=firestore(),a=context({db:f.db,byId:()=>null});appStorage(a);await Promise.all([a.patchLight('p',{status:'고장',lastInspected:20,updatedAt:20},'new'),a.patchLight('p',{lat:35,updatedAt:10},'position')]);
  await a.patchLight('p',{status:'정상',lastInspected:1,updatedAt:1},'old');
  const events=Object.entries(f.records).map(([id,d])=>({id,...d})),merged=a.DGData.mergeLightFields({},events);
  assert.equal(merged.p.status,'고장');assert.equal(merged.p.lastInspected,20);assert.equal(merged.p.lat,35);
  await a.patchLight('p',{_deleted:true,updatedAt:30},'deleted');await a.patchLight('p',{status:'정상',updatedAt:25},'late');
  assert(a.DGData.mergeLightFields({},Object.entries(f.records).map(([id,d])=>({id,...d}))).p._deleted);
});

test('backup exports all 20,001 documents and safe restore checks the target atomically',async()=>{
  const inspections={};for(let i=0;i<20001;i++)inspections['i'+i]={date:i,memo:'current'};const {db,storage}=local({inspections});let exported;
  const c=context({db,BK:{busy:false,photos:false,overwrite:false,roles:false},BK_COLS:['inspections'],fmtD:()=>'',dl:{save:async x=>exported=JSON.parse(await x.data.text())}});
  load(c,'async function backupExport(){','/* ---------- period report');await c.backupExport();assert.equal(exported.counts.inspections,20001);assert.equal(exported.collections.inspections.length,20001);assert.equal(exported.complete,true);
  c.BK.file={text:async()=>JSON.stringify({app:'donggu-streetlight',collections:{inspections:[{id:'i20000',memo:'backup'},{id:'new',memo:'new'}]}})};
  await c.backupImport();assert.equal(c.BK.preview.skip,1);assert.equal(c.BK.preview.add,1);
  await db.doc('inspections/new').set({memo:'created after preview'});await c.backupImport();
  assert.equal(storage.dump().inspections.i20000.memo,'current');assert.equal(storage.dump().inspections.new.memo,'created after preview');
});

test('backup validation rejects duplicate IDs, inconsistent counts and incomplete files',()=>{
  const {api}=local();for(const value of [
    {app:'donggu-streetlight',collections:{lights:[{id:'same'},{id:'same'}]}},
    {app:'donggu-streetlight',counts:{lights:2},collections:{lights:[{id:'one'}]}},
    {app:'donggu-streetlight',complete:false,collections:{}},
    {app:'donggu-streetlight',collections:{lights:[{id:'__proto__'}]}}
  ])assert.throws(()=>api.validateBackup(value));
});

function patrolContext(db){const pt={sessionId:'session-a',start:1,end:2,dong:'전체',dist:10,passed:new Map([['p',1]]),marks:[{id:'p',code:'A',result:'고장',at:2}],spots:[],track:[]};const c=context({db,pt,byId:id=>({id,code:'A',dong:'D'}),closed:0,reset:0});c.ptReset=()=>{c.reset++;pt.marks=[];pt.passed.clear();pt.on=false};c.closeSheet=()=>c.closed++;appStorage(c);load(c,'const PATROL_JOBS=','async function exportPatrolCSV');return c}

test('patrol retry after a final-write failure uses one inspection and one patrol document',async()=>{
  const f=firestore(),c=patrolContext(f.db);f.fail('patrols/');await c.ptSave({});assert.equal(Object.keys(f.records).filter(x=>x.startsWith('inspections/')).length,1);assert.equal(c.reset,0);
  const firstId=Object.keys(f.records).find(x=>x.startsWith('inspections/'));f.fail(null);await c.ptSave({});assert.equal(Object.keys(f.records).filter(x=>x.startsWith('inspections/')).length,1);assert(f.records[firstId]);assert.equal(Object.keys(f.records).filter(x=>x.startsWith('patrols/')).length,1);assert.equal(c.reset,1);
});

test('an old patrol completion cannot reset a newly started patrol',async()=>{
  const f=firestore(),c=patrolContext(f.db),original=f.db.doc;let release;const wait=new Promise(resolve=>release=resolve);let started;
  f.db.doc=key=>{const ref=original(key);if(key.startsWith('patrols/'))ref.set=async data=>{started=true;await wait;f.records[key]=clone(data)};return ref};
  const saving=c.ptSave({});while(!started)await new Promise(r=>setImmediate(r));c.pt.sessionId='new-session';c.pt.marks=[{id:'new',result:'정상'}];c.pt.on=true;release();await saving;assert.equal(c.reset,0);assert.equal(c.pt.marks[0].id,'new');assert.equal(c.closed,0);
});

test('different representative slots survive simultaneous selection and explicit deletion shadows legacy data',async()=>{
  const {db,storage}=local({lights:{p:{reps:{전경:{id:'legacy'}}}}});const light={id:'p',reps:{전경:{id:'legacy'}}};
  const c=context({db,S:{me:'local'},byId:()=>light,getPhoto:async id=>({id,lightId:'p',data:'image'}),loadImg:async()=>({}),thumbOf:()=> 'data:image/jpeg;base64,thumb'});appStorage(c);
  load(c,'const REP_SLOTS=','function thumbOf(');load(c,'async function repPatchFor(','async function ensureRepPhotos(');
  await Promise.all([c.setRepFromPhoto('p','wide','전경'),c.setRepFromPhoto('p','plate','표찰')]);let saved=storage.dump().lights.p;assert.equal(saved.repWide.id,'wide');assert.equal(saved.repPlate.id,'plate');
  await c.clearRepPhoto('p','전경');saved=storage.dump().lights.p;assert.equal(saved.repWide,null);assert.equal(c.repSlots(saved).전경,undefined);assert.equal(c.repSlots(saved).표찰.id,'plate');
});

test('reports include an older period beyond 1,000 newer records and refresh after live invalidation',async()=>{
  const now=new Date(),start=new Date(now.getFullYear(),now.getMonth(),1).getTime(),inspections={};for(let i=0;i<1000;i++)inspections['new'+i]={lightId:'p',date:start+i,result:'정상'};inspections.previous={lightId:'p',date:start-1000,result:'고장'};
  const {db}=local({inspections}),light={id:'p',dong:'D',status:'정상'},c=context({db,REP:{period:'last',dong:'전체',data:null},IR:{more:null},PT_COVER:{},S:{lights:[light],patrols:[],insp:[]},repRange:()=>({a:start-31*864e5,b:start-1}),byId:()=>light,inDong:()=>true,adongOf:()=> 'D',adongOrder:()=>0});
  load(c,'function reportQueryKey(){','function repMonthKey');load(c,'function reportData(){','function reportSection');load(c,'function dataChanged(key){','/* Registry:');await c.repLoad();assert.equal(c.reportData().ins.length,1);
  await db.doc('inspections/late').set({lightId:'p',date:start-2000,result:'고장'});c.dataChanged('insp');assert.equal(c.REP.data,null);await c.repLoad();assert.equal(c.reportData().ins.length,2);
});

test('gallery retrieves the 41st latest photo and 31 patrol sessions give full 30-day coverage',async()=>{
  const now=Date.now(),photos={},patrols={},lights=[];for(let i=1;i<=41;i++)photos['ph'+i]={lightId:'p',at:i,data:'data:image/png;base64,aGVsbG8=',label:'전경'};for(let i=0;i<31;i++){lights.push({id:'p'+i,lat:35});patrols['trip'+i]={start:now-i*1000,passed:['p'+i]}}
  const {db}=local({photos,patrols}),box={},c=context({db,GAL:{},S:{lights,patrols:[]},$:s=>s==='#galBox'?box:{},esc:String,fmtD:String,inDong:()=>true,PT_DAYS:30});
  load(c,'async function loadGallery(id){','async function getPhoto');await c.loadGallery('p');assert(c.GAL.ph41);assert.match(box.innerHTML,/ph41/);
  load(c,'let PT_LAST={};','const pt=');load(c,'function ptCoverage(dong){','function ptSay');await c.loadPatrolCoverage();assert.equal(c.ptCoverage('전체').cov,31);assert.equal(c.ptCoverage('전체').pct,100);
});

test('concurrent citizen imports are idempotent and complete the raw marker without resetting existing status',async()=>{
  const f=firestore({'citizen_reports/raw':{issue:'기타',code:'',imported:false,at:10}});
  const make=()=>{const c=context({db:f.db,FB:{fs:f.db,auth:{currentUser:{uid:'u'}}},IB:{},window:{REPORT_CONFIG:{firestore:{projectId:'demo'}}},S:{me:'u',reports:[]},fsApp:async()=>f.db,byId:()=>null,firebase:{firestore:{FieldValue:{delete:()=> 'deleted'}}}});load(c,'async function importCitizenReports(){','async function addInboxReport');return c};
  const a=make(),b=make();await Promise.all([a.importCitizenReports(),b.importCitizenReports()]);const keys=Object.keys(f.records).filter(k=>k.startsWith('reports/'));assert.equal(keys.length,1);assert.match(a.IB.importMsg,/실패 0건/);assert.match(b.IB.importMsg,/실패 0건/);assert.equal(f.records['citizen_reports/raw'].imported,true);assert.equal(f.records['citizen_reports/raw'].reportId,keys[0].split('/')[1]);
  f.records[keys[0]].status='완료';f.records['citizen_reports/raw'].imported=false;await a.importCitizenReports();assert.equal(f.records[keys[0]].status,'완료');assert.equal(f.records['citizen_reports/raw'].imported,true);
});

test('an older inspection preserves evidence without regressing newer light status on local storage',async()=>{
  const {db,storage}=local({lights:{p:{status:'고장',lastInspected:20,lastResult:'고장',updatedAt:20}}});
  const c=context({db,S:{me:'local'},byId:()=>({id:'p'}),repSlots:()=>({}),GAL:{}});appStorage(c);load(c,'async function inspectionOperations(job,server=false){','async function saveInspection');
  await c.commitInspectionJob({id:'old',rec:{lightId:'p',result:'정상',date:10,inspector:'local'},photos:[],fill:[],reps:{}});
  assert.equal(storage.dump().inspections.old.result,'정상');assert.equal(storage.dump().lights.p.status,'고장');assert.equal(storage.dump().lights.p.lastInspected,20);
});

test('a cross-store import repairs a failed raw marker and preserves an already processed report',async()=>{
  const raw=firestore({'citizen_reports/raw':{issue:'기타',code:'',imported:false,at:10,privacyExpiresAt:100},'roles/u':{role:'admin'}}),{db}=local({});
  const c=context({db,IB:{},window:{REPORT_CONFIG:{firestore:{projectId:'demo'}}},S:{me:'local',reports:[]},fsApp:async()=>raw.db,byId:()=>null,firebase:{auth:()=>({currentUser:{uid:'u'}}),firestore:{FieldValue:{delete:()=> 'deleted'}}}});
  load(c,'async function importCitizenReports(){','async function addInboxReport');raw.fail('citizen_reports/');await c.importCitizenReports();let rows=await c.listAllRecords('reports');assert.equal(rows.length,1);assert.equal(rows[0].privacyExpiresAt,100);assert.equal(raw.records['citizen_reports/raw'].imported,false);
  await db.doc('reports/'+rows[0].id).update({status:'완료'});raw.fail(null);await c.importCitizenReports();rows=await c.listAllRecords('reports');assert.equal(rows.length,1);assert.equal(rows[0].status,'완료');assert.equal(raw.records['citizen_reports/raw'].imported,true);
});

test('an offline inspection rejected as stale retries only the immutable evidence',async()=>{
  const f=firestore({'lights/p':{status:'정상',lastInspected:1,updatedAt:1}}),c=context({db:f.db,FB:{fs:f.db},S:{me:'u'},byId:()=>({id:'p'}),repSlots:()=>({}),GAL:{}});appStorage(c);load(c,'async function inspectionOperations(job,server=false){','async function saveInspection');
  const real=f.db.batch;let attempts=0;f.db.batch=()=>{const b=real();return{set:(...args)=>b.set(...args),commit:async()=>{attempts++;if(attempts===1){f.records['lights/p']={status:'고장',lastInspected:30,updatedAt:30};throw Object.assign(Error('older pending write'),{code:'permission-denied'})}await b.commit()}}};
  await c.commitInspectionJob({id:'offline',rec:{lightId:'p',result:'정상',date:10,inspector:'u'},photos:[],fill:[],reps:{}});assert.equal(attempts,2);assert.equal(f.records['inspections/offline'].result,'정상');assert.equal(f.records['lights/p'].lastInspected,30);assert.equal(f.records['lights/p'].status,'고장');
});
