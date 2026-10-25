'use strict';
const {InputError}=require('./core');
const SERVICES=['gateway','audit','retention'];
function createHealthService(db){
  async function record(service,success,details={}){
    if(!SERVICES.includes(service))return;
    const now=Date.now(),ref=db.doc('systemHealth/'+service);
    try{await db.runTransaction(async tx=>{const old=(await tx.get(ref)).data()||{};
      // Audit writes can be frequent; one successful heartbeat per minute suffices.
      if(success&&service==='audit'&&now-(old.lastSuccessAt||0)<60000)return;
      const patch={schemaVersion:1,updatedAt:now,[success?'lastSuccessAt':'lastFailureAt']:now};
      if(!success)patch.lastErrorCode=String(details.code||'internal').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)||'internal';
      if(success&&details.counts)patch.counts=Object.fromEntries(Object.entries(details.counts).filter(([,v])=>Number.isSafeInteger(v)&&v>=0));
      tx.set(ref,patch,{merge:true});
    });}catch(error){console.error('Operational heartbeat unavailable',service,error.code||'internal');}
  }
  async function query(uid){
    const role=(await db.doc('roles/'+uid).get()).data()?.role;if(!['admin','inspector'].includes(role))throw new InputError('직원 권한이 필요합니다.','permission-denied');
    const now=Date.now(),snapshots=await db.getAll(...SERVICES.map(k=>db.doc('systemHealth/'+k))),services={};
    for(let i=0;i<SERVICES.length;i++){const id=SERVICES[i],v=snapshots[i].data()||{},success=Number(v.lastSuccessAt)||0,failure=Number(v.lastFailureAt)||0;services[id]={state:failure>success?'error':success?(id==='retention'&&(now-success>36*3600000||Number(v.counts?.remainingExpired)>0)?'stale':'ok'):'unknown',lastSuccessAt:success,lastFailureAt:failure,lastErrorCode:failure>success?String(v.lastErrorCode||'internal'):'',...(v.counts?{counts:v.counts}:{})};}
    const active=['draft','assigned','in_progress','completed'];
    let open=db.collection('workOrders').where('status','in',active);if(role!=='admin')open=open.where('assignedTo','==',uid);
    const mine=db.collection('workOrders').where('status','in',active).where('assignedTo','==',uid);
    const counts=await Promise.all([db.collection('citizen_reports').where('imported','==',false).count().get(),open.count().get(),open.where('dueAt','>',0).where('dueAt','<',now).count().get(),mine.count().get()]);
    const guard=(await db.doc('meta/operationalRestore').get()).data()||{};
    return{checkedAt:now,source:'server',scope:role==='admin'?'all':'assigned',services,maintenance:{active:guard.status==='partial',operationId:guard.operationId||'',startedAt:guard.startedAt||0,updatedAt:guard.completedAt||guard.startedAt||0},counts:{unimportedReports:counts[0].data().count,openWorkOrders:counts[1].data().count,overdueWorkOrders:counts[2].data().count,myOpenWorkOrders:counts[3].data().count}};
  }
  return{record,query};
}
module.exports={createHealthService};
