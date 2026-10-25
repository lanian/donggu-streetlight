/* Shared input boundaries and optional Firebase administration. No connection is made on load. */
(function(root){
  'use strict';
  function csvCell(value){let s=String(value??'');if(/^[\s\u0000-\u001f]*[=+\-@＝＋－＠]/u.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
  function safeImageSrc(value){return typeof value==='string'&&value.length<=1500000&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)?value:'';}
  function inspectionThumbs(record){return Array.isArray(record&&record.thumbs)?record.thumbs.slice(0,6).filter(t=>t&&typeof t==='object'&&typeof t.id==='string'&&t.id.length<=200&&!t.id.includes('/')&&safeImageSrc(t.t)):[];}
  function inspectionFaults(record){return Array.isArray(record&&record.faults)?record.faults.filter(f=>typeof f==='string').slice(0,20):[];}
  function validInspectionEvidence(record){return !!record&&(!('thumbs' in record)||(Array.isArray(record.thumbs)&&record.thumbs.length<=6&&inspectionThumbs(record).length===record.thumbs.length))&&(!record.photo||!!safeImageSrc(record.photo));}
  const trustKey='dg-device-trusted:'+((root.FIREBASE_CONFIG||{}).projectId||'local');
  let trusted=!root.FIREBASE_CONFIG;
  try{if(root.FIREBASE_CONFIG)trusted=root.localStorage.getItem(trustKey)==='true';}catch(e){}
  root.DG_DEVICE_TRUSTED=trusted;
  const state={requests:[],message:'',invite:null,busy:false};
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const enabled=()=>!!(root.FIREBASE_CONFIG&&root.FIREBASE_CONFIG.functionsEnabled);
  async function hasPendingWork(){
    const offline=root.DGOffline,integration=root.DGIntegration;
    if(!offline||!offline.ready)return !!(typeof FB!=='undefined'&&FB&&FB.auth.currentUser&&integration&&typeof integration.hasUnsavedSync==='function'&&integration.hasUnsavedSync());
    if(root.DGLightingWorkflows?.persistActive)await root.DGLightingWorkflows.persistActive();if(root.DGOperations?.persistActive)await root.DGOperations.persistActive();if(root.DGLighting?.persistDraft)await root.DGLighting.persistDraft();
    if(integration){if(typeof integration.persistDraft==='function')await integration.persistDraft();if(typeof integration.persistPatrol==='function')await integration.persistPatrol();if(typeof integration.hasUnsaved==='function')return !!(await integration.hasUnsaved());}
    const [jobs,...drafts]=await Promise.all([offline.jobs(),...['draft','patrol','workDraft','workCompletion','lightingDraft','lightingTaskDraft'].map(kind=>offline.list(kind))]);
    return jobs.some(job=>job.state!=='synced')||drafts.some(values=>values.length>0);
  }
  async function call(name,data){
    if(!enabled())throw new Error('서버 관리 기능이 아직 연결되지 않았습니다.');
    if(typeof FB==='undefined'||!FB||!FB.auth.currentUser)throw new Error('직원 로그인이 필요합니다.');
    await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions-compat.js');
    const cfg=root.FIREBASE_CONFIG;
    if(cfg.appCheckSiteKey){await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check-compat.js');if(!root.DG_APP_CHECK_ACTIVE){firebase.appCheck().activate(cfg.appCheckSiteKey,true);root.DG_APP_CHECK_ACTIVE=true;}}
    return (await firebase.app().functions(cfg.functionsRegion||'asia-northeast3').httpsCallable(name)(data)).data;
  }
  function devicePanel(){return root.FIREBASE_CONFIG?`<details class="help"><summary>이 기기의 저장 방식</summary><p>공유 PC는 로그인 세션을 현재 탭에 보관하며 개인정보의 영구 캐시를 켜지 않아요. 전용 현장 기기에서만 오프라인 보관을 켜세요.</p><label><input type="checkbox" id="dgDeviceTrusted" ${root.DG_DEVICE_TRUSTED?'checked':''}> 현장 전용 기기 · 오프라인 자료 보관</label><button class="btn ghost sm" data-dg-action="device">적용 후 다시 열기</button></details>`:'';}
  function joinPanel(){return `<div class="panel"><h3>직원 접근 신청</h3><label class="f">부서·담당 업무</label><input class="f-in" id="dgJoinMessage" maxlength="500" placeholder="관리자가 확인할 내용을 적으세요"><button class="btn sm" data-dg-action="join">승인 요청</button>${enabled()?`<label class="f">받은 초대 코드</label><input class="f-in" id="dgInviteCode" maxlength="100" autocomplete="off"><button class="btn ghost sm" data-dg-action="redeem">초대 수락</button>`:''}<p class="muted">${escape(state.message||'승인 후 화면을 다시 열면 담당 기능을 사용할 수 있어요.')}</p></div>${devicePanel()}`;}
  function accessPanel(){return `<details class="help"><summary>직원 신청·초대</summary><button class="btn ghost sm" data-dg-action="requests">대기 신청 새로 확인</button>${state.requests.map(r=>`<div class="panel"><b>${escape(r.name||r.uid)}</b><div class="muted">${escape(r.email)} · ${escape(r.message)}</div><button class="btn sm" data-dg-approve="${escape(r.id)}">점검자로 승인</button><button class="btn ghost sm" data-dg-reject="${escape(r.id)}">반려</button></div>`).join('')}${enabled()?`<label class="f">초대할 직원 이메일</label><input class="f-in" id="dgInviteEmail" type="email" maxlength="254"><button class="btn ghost sm" data-dg-action="invite">7일 초대 코드 만들기</button>${state.invite?`<p>확인된 이메일 계정 한 명만 사용할 수 있어요. 담당자에게 직접 전달하세요.</p><input class="f-in" readonly value="${escape(state.invite.code)}" aria-label="생성된 초대 코드">`:''}`:'<p class="muted">초대 코드는 서버 관리 기능을 연결하면 사용할 수 있어요. 현재는 접근 신청을 확인해 승인할 수 있습니다.</p>'}<p class="muted">${escape(state.message)}</p></details>${devicePanel()}`;}
  async function reviewJoin(uid,decision){
    if(enabled())return call('approveJoinRequest',{uid,decision});
    const requestRef=FB.fs.doc('joinRequests/'+uid),roleRef=FB.fs.doc('roles/'+uid),now=Date.now();
    await FB.fs.runTransaction(async tx=>{const [request,role]=await Promise.all([tx.get(requestRef),tx.get(roleRef)]);if(!request.exists||request.data().status!=='pending')throw new Error('대기 중인 신청이 아닙니다.');
      if(decision!=='reject')tx.set(roleRef,{role:role.exists&&role.data().role==='admin'?'admin':'inspector',name:request.data().name||uid,at:now,by:S.me},{merge:true});
      tx.update(requestRef,{status:decision==='reject'?'rejected':'approved',reviewedBy:S.me,reviewedAt:now,updatedAt:now});});
  }
  async function handle(event){const button=event.target.closest&&event.target.closest('[data-dg-action],[data-dg-approve],[data-dg-reject]');if(!button)return;event.preventDefault();if(state.busy)return;state.busy=true;button.disabled=true;
    try{
      const action=button.dataset.dgAction;
      if(action==='device'){
        const value=!!document.getElementById('dgDeviceTrusted').checked;
        if(!confirm('작성 중인 내용과 전송 대기 작업을 먼저 저장했나요? 저장 방식을 바꾸고 화면을 다시 엽니다.'))return;
        if(await hasPendingWork())throw new Error('저장 대기함의 미전송 작업과 작성 중인 초안을 먼저 저장하거나 직접 정리하세요.');
        if(!value&&root.DGOffline&&root.DGOffline.ready)await root.DGOffline.clear();
        if(!value&&typeof FB!=='undefined'&&FB){await FB.fs.terminate();await FB.fs.clearPersistence();}
        root.localStorage.setItem(trustKey,String(value));root.DG_DEVICE_TRUSTED=value;
        location.reload();return;
      }
      if(typeof FB==='undefined'||!FB)throw new Error('Firebase 직원 로그인이 필요합니다.');
      if(action==='join'){
        const u=FB.auth.currentUser;if(!u)throw new Error('직원 로그인이 필요합니다.');const now=Date.now(),ref=FB.fs.doc('joinRequests/'+u.uid),snapshot=await ref.get();
        const changes={name:(u.displayName||u.email||'직원').slice(0,80),message:document.getElementById('dgJoinMessage').value.trim().slice(0,500),updatedAt:now};
        if(snapshot.exists)await ref.update(changes);else await ref.set({...changes,uid:u.uid,email:u.email||'',status:'pending',createdAt:now});
        state.message='승인을 요청했어요. 관리자 승인 후 화면을 다시 열어 주세요.';
      }else if(action==='redeem'){await call('redeemStaffInvite',{code:document.getElementById('dgInviteCode').value.trim()});location.reload();return;}
      else if(action==='requests'){if(!need('admin'))return;const snapshot=await FB.fs.collection('joinRequests').where('status','==','pending').limit(100).get();state.requests=snapshot.docs.map(d=>({...d.data(),id:d.id}));state.message=`대기 신청 ${state.requests.length}건`;}
      else if(action==='invite'){if(!need('admin'))return;state.invite=await call('createStaffInvite',{email:document.getElementById('dgInviteEmail').value.trim()});state.message='초대 코드를 만들었어요. 이메일은 자동으로 발송하지 않습니다.';}
      else if(button.dataset.dgApprove||button.dataset.dgReject){if(!need('admin'))return;const uid=button.dataset.dgApprove||button.dataset.dgReject;await reviewJoin(uid,button.dataset.dgReject?'reject':'approve');state.requests=state.requests.filter(r=>r.id!==uid);state.message='신청 처리를 저장했어요.';}
      render();
    }catch(error){state.message=error&&error.message||'저장하지 못했어요.';toast(state.message);}finally{state.busy=false;button.disabled=false;}
  }
  if(root.document)root.document.addEventListener('click',handle);
  root.csvCell=csvCell;root.safeImageSrc=safeImageSrc;root.inspectionThumbs=inspectionThumbs;root.inspectionFaults=inspectionFaults;root.validInspectionEvidence=validInspectionEvidence;
  root.DGSecurity={csvCell,safeImageSrc,inspectionThumbs,inspectionFaults,validInspectionEvidence,devicePanel,joinPanel,accessPanel,hasPendingWork,call};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.DGSecurity;
})(typeof window!=='undefined'?window:globalThis);
