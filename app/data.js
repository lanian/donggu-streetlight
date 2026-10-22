/* Shared storage operations. No backend credentials or network are initialized here. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;root.DGData=api})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';
  const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
  function equal(a,b){if(a===b)return true;if(a==null||b==null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();return ak.length===bk.length&&ak.every((key,i)=>key===bk[i]&&equal(a[key],b[key]))}
  const newId=prefix=>(prefix||'op')+'-'+(root.crypto&&root.crypto.randomUUID?root.crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2));
  const stableId=(prefix,...parts)=>{const id=prefix+'-'+parts.map(x=>encodeURIComponent(String(x))).join('~');if(id.length>1400)throw new Error('문서 식별자가 너무 길어요.');return id};
  function error(code,message){const e=new Error(message);e.code=code;return e}
  function clauses(value){if(!value||!value.length)return[];return Array.isArray(value[0])?value:[value]}
  function matches(row,[key,op,value]){const got=key==='__name__'?row.id:row[key];switch(op){case'==':return got===value;case'!=':return got!==undefined&&got!==value;case'>':return got>value;case'>=':return got>=value;case'<':return got<value;case'<=':return got<=value;case'in':return value.includes(got);case'array-contains':return Array.isArray(got)&&got.includes(value);default:throw error('unsupported-query','지원하지 않는 조회 조건이에요: '+op)}}
  function select(rows,options={}){let out=rows.filter(r=>clauses(options.where).every(c=>matches(r,c)));const order=clauses(options.orderBy);out.sort((a,b)=>{for(const [key,dir='asc']of order){const x=key==='__name__'?a.id:a[key],y=key==='__name__'?b.id:b[key];if(x===y)continue;const n=x==null?-1:y==null?1:x<y?-1:1;return dir==='desc'?-n:n}return String(a.id).localeCompare(String(b.id))});return out}
  function rowsOf(snap){if(!snap||!Array.isArray(snap.docs))throw error('invalid-snapshot','저장소 조회 결과를 읽을 수 없어요.');return snap.docs.map(d=>({...clone(typeof d.data==='function'?d.data():d.data||d),id:d.id}))}
  function checkComplete(snap){if(snap.truncated||snap.hasMore||snap.nextCursor||snap.metadata&&snap.metadata.truncated)throw error('incomplete-query','저장소가 일부 기록만 반환했어요. 전체 자료를 확인한 뒤 다시 시도하세요.')}
  async function readAll(db,collection,options={}){
    if(!db)throw error('unavailable','저장소에 연결하지 못했어요.');
    if(typeof db.readAll==='function')return db.readAll(collection,options);
    let base=db.collection(collection);
    // Firestore exposes cursors. Keep a deterministic document-ID tiebreaker on every page.
    if(typeof base.startAfter==='function'){
      for(const [field,op,value]of clauses(options.where))base=base.where(field,op,value);
      const order=clauses(options.orderBy);for(const [field,dir='asc']of order)base=base.orderBy(field,dir);
      if(!order.some(([f])=>f==='__name__'))base=base.orderBy('__name__',order.length?(order[order.length-1][1]||'asc'):'asc');
      const size=Math.max(1,Math.min(1000,options.pageSize||400)),rows=[],seen=new Set();let cursor=null;
      while(true){let q=cursor?base.startAfter(cursor):base;const snap=await q.limit(size).get(options.requireServer?{source:'server'}:undefined);
        if(options.requireServer&&snap.metadata&&snap.metadata.fromCache)throw error('offline','완전한 자료를 확인하려면 서버 연결이 필요해요.');
        const docs=snap.docs||[];for(const row of rowsOf(snap)){if(seen.has(row.id))throw error('unstable-query','조회 중 기록 순서가 바뀌었어요. 다시 불러와 주세요.');seen.add(row.id);rows.push(row)}
        if(options.onPage)options.onPage(rows.length);if(docs.length<size)break;cursor=docs[docs.length-1];
      }return rows;
    }
    // The artifact API has get/update/set but no documented cursor. Request an unbounded
    // snapshot (never a silent fixed limit), and refuse a backend-declared partial response.
    const snap=await base.get();checkComplete(snap);const rows=select(rowsOf(snap),options);if(options.onPage)options.onPage(rows.length);return rows;
  }
  const statusKeys=['status','lastInspected','lastResult','redoNote'];
  function latestPatch(current,patch){const next=clone(patch);if(typeof next.lastInspected==='number'&&typeof current?.lastInspected==='number'&&next.lastInspected<current.lastInspected){for(const key of statusKeys)delete next[key];delete next.updatedAt}return next}
  function mergeLightFields(base,events){const out={};for(const[id,data]of Object.entries(base||{}))out[id]=clone(data);for(const e of [...events].sort((a,b)=>(a.at||0)-(b.at||0)||String(a.id).localeCompare(String(b.id)))){if(!e.lightId||!e.changes||typeof e.changes!=='object')continue;if((base[e.lightId]?.foundAt||0)>(e.at||0))continue;const current=out[e.lightId]||{};out[e.lightId]={...current,...latestPatch(current,e.changes)}}return out}
  function applyOps(data,ops){const result=[];for(const op of ops){const [col,id,...rest]=op.path.split('/');if(!col||!id||rest.length)throw error('invalid-path','문서 경로가 올바르지 않아요.');const bucket=data[col]||(data[col]={});const exists=Object.prototype.hasOwnProperty.call(bucket,id);
      if(op.ifAbsent&&exists){result.push({path:op.path,skipped:true});continue}if(op.delete){delete bucket[id];result.push({path:op.path});continue}
      let next=clone(op.data);if(col==='lights'&&op.merge)next=latestPatch(bucket[id]||{},next);bucket[id]=op.merge?{...(bucket[id]||{}),...next}:next;result.push({path:op.path});
    }return result}
  function createLocalDB(options={}){
    const storage=options.storage||root.localStorage,key=options.key||'donggu-streetlight-local',idb=options.indexedDB===undefined?root.indexedDB:options.indexedDB,locks=options.locks||root.navigator&&root.navigator.locks;
    let data={},database=null;const subscriptions=new Set();
    function legacy(){const raw=storage&&storage.getItem(key);if(!raw)return{};const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw error('corrupt-local-data','기기 저장 자료를 읽지 못했어요. 원본을 복구한 뒤 다시 시도하세요.');return value}
    try{data=legacy()}catch(e){if(e.code==='corrupt-local-data')throw e;throw error('corrupt-local-data','기기 저장 자료가 손상됐어요. 기존 자료를 덮어쓰지 않았어요.')}
    const ready=idb?new Promise((resolve,reject)=>{const request=idb.open('donggu-local-records-v2',1);request.onupgradeneeded=()=>request.result.createObjectStore('state');request.onerror=()=>reject(request.error);request.onsuccess=()=>{database=request.result;database.onversionchange=()=>database.close();const tx=database.transaction('state','readwrite'),st=tx.objectStore('state'),get=st.get(key);get.onsuccess=()=>{if(get.result!==undefined)data=get.result;else st.put(data,key)};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)}}):Promise.resolve();
    function snapshot(col,q){let rows=select(Object.entries(data[col]||{}).map(([id,d])=>({...clone(d),id})),q);if(q.limit!=null)rows=rows.slice(0,q.limit);return{docs:rows.map(row=>{const{id,...d}=row;return{id,data:()=>clone(d)}})}}
    function notify(){for(const sub of subscriptions)try{sub.callback(snapshot(sub.col,sub.q))}catch(e){console.error('Local data subscriber failed',e)}}
    async function refresh(){await ready;if(database){await new Promise((resolve,reject)=>{const tx=database.transaction('state','readonly'),req=tx.objectStore('state').get(key);req.onsuccess=()=>{data=req.result||{};resolve()};req.onerror=()=>reject(req.error)})}else data=legacy();return data}
    const channel=options.events&&typeof root.BroadcastChannel==='function'?new root.BroadcastChannel('donggu-local-records-v2'):null;
    if(channel)channel.onmessage=()=>refresh().then(notify).catch(console.error);
    if(options.events&&options.events.addEventListener)options.events.addEventListener('storage',event=>{if(!database&&event.key===key)refresh().then(notify).catch(console.error)});
    async function commit(change){await ready;let result,next;
      if(database){await new Promise((resolve,reject)=>{const tx=database.transaction('state','readwrite'),st=tx.objectStore('state'),req=st.get(key);req.onsuccess=()=>{try{next=clone(req.result||{});result=change(next);st.put(next,key)}catch(e){reject(e);tx.abort()}};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||error('aborted','저장을 완료하지 못했어요.'))})}
      else{const save=()=>{next=clone(legacy());result=change(next);storage.setItem(key,JSON.stringify(next))};if(locks&&locks.request)await locks.request('donggu-local-records-v2',save);else if(root.navigator)throw error('local-storage-unavailable','이 브라우저에서 안전한 기기 저장을 사용할 수 없어요. IndexedDB 사용을 허용하거나 지원 브라우저로 열어 주세요.');else save()}
      data=next;notify();if(channel)channel.postMessage({changed:true});return result;
    }
    const query=(col,q={})=>({where:(field,op,value)=>query(col,{...q,where:[...clauses(q.where),[field,op,value]]}),orderBy:(field,dir)=>query(col,{...q,orderBy:[...clauses(q.orderBy),[field,dir]]}),limit:limit=>query(col,{...q,limit}),get:async()=>{await refresh();return snapshot(col,q)},onSnapshot(callback){const sub={col,q,callback};subscriptions.add(sub);const first=snapshot(col,q);callback(first);const original=JSON.stringify(first.docs.map(d=>({id:d.id,...d.data()})));refresh().then(()=>{const latest=snapshot(col,q);if(subscriptions.has(sub)&&JSON.stringify(latest.docs.map(d=>({id:d.id,...d.data()})))!==original)callback(latest)}).catch(console.error);return()=>subscriptions.delete(sub)},add:async rec=>{const id=newId('local');await commit(next=>applyOps(next,[{path:col+'/'+id,data:rec}]));return{id}}});
    const db={mode:'local',ready,collection:col=>query(col),readAll:async(col,q)=>{await refresh();return select(Object.entries(data[col]||{}).map(([id,d])=>({...clone(d),id})),q)},commitMany:(ops,options={})=>commit(next=>{for(const[path,revision]of Object.entries(options.expected||{})){const[c,id]=path.split('/'),current=(next[c]||{})[id];if(revision===null?current!==undefined:typeof revision==='object'?('document'in revision?!equal(current??null,revision.document):(current?.[revision.field]??null)!==revision.value):!current||(current.revision||0)!==revision)throw error('conflict','다른 사용자가 먼저 변경했어요. 새로고침 후 다시 시도하세요.')}return applyOps(next,ops)}),doc:path=>{const[col,id]=path.split('/');return{path,get:async()=>{await refresh();const d=(data[col]||{})[id];return{id,exists:d!==undefined,data:()=>clone(d)}},set:(rec,opts)=>commit(next=>applyOps(next,[{path,data:rec,merge:!!(opts&&(opts.merge||opts.mergeFields))}])),update:patch=>commit(next=>applyOps(next,[{path,data:patch,merge:true}])),delete:()=>commit(next=>applyOps(next,[{path,delete:true}])),create:rec=>commit(next=>applyOps(next,[{path,data:rec,ifAbsent:true}]))}},close(){if(channel)channel.close();if(database)database.close();subscriptions.clear()}};
    db.seed=async()=>{await refresh();let planned;try{const fetcher=options.fetch||root.fetch,mf=await(await fetcher('seed/manifest.json',{cache:'no-cache'})).json(),docs=Array.isArray(mf)?mf:mf.docs,version=Array.isArray(mf)?1:mf.version;const refreshSeed=data.seedVersion!==version,todo=refreshSeed?docs:docs.filter(e=>!(data[e.collection]&&data[e.collection][e.doc_id]));planned={version,purge:refreshSeed&&mf.purge,docs:await Promise.all(todo.map(async e=>({...e,data:await(await fetcher('seed/'+e.file,{cache:'no-cache'})).json()})))} }catch(e){return}if(planned)await commit(next=>{const newVersion=next.seedVersion!==planned.version;if(newVersion&&planned.purge)for(const c of['lights','inspections','reports','register'])next[c]={};for(const e of planned.docs){const bucket=next[e.collection]||(next[e.collection]={});if(newVersion||!bucket[e.doc_id])bucket[e.doc_id]=e.data};next.seedVersion=planned.version})};
    return db;
  }
  function validateBackup(input){if(!input||input.app!=='donggu-streetlight'||!input.collections||typeof input.collections!=='object'||Array.isArray(input.collections))throw error('invalid-backup','이 앱의 백업 파일이 아니에요.');const counts={};for(const[c,rows]of Object.entries(input.collections)){if(!Array.isArray(rows))throw error('invalid-backup',c+' 자료 형식이 올바르지 않아요.');const seen=new Set();for(const row of rows){if(!row||typeof row!=='object'||typeof row.id!=='string'||!row.id||row.id.includes('/')||row.id==='.'||row.id==='..'||['__proto__','prototype','constructor'].includes(row.id)||seen.has(row.id))throw error('invalid-backup',c+'에 잘못되었거나 중복된 문서 ID가 있어요.');seen.add(row.id)}counts[c]=rows.length;if(input.counts&&input.counts[c]!==rows.length)throw error('invalid-backup',c+'의 기록 수가 백업 목록과 달라요.')}if(input.complete===false)throw error('incomplete-backup','완료되지 않은 백업은 복원할 수 없어요.');return counts}
  return{clone,equal,newId,stableId,readAll,select,rowsOf,latestPatch,mergeLightFields,createLocalDB,validateBackup,error};
});
