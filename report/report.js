const C=Object.assign({org:"",dept:"",phone:"",sms:"",mail:"",backend:null,officialUrl:"",officialStatusUrl:"",officialName:"운영서비스",firestore:{},gatewayUrl:"",statusUrl:"",appCheckSiteKey:"",allowLocalGateway:false,privacyDays:90,maxPhotoKB:150},window.REPORT_CONFIG||{});
if(!Number.isInteger(C.privacyDays)||C.privacyDays<1||C.privacyDays>3650)C.privacyDays=90;
const ISSUES=["불이 꺼져 있어요","깜빡거려요","낮에도 켜져 있어요","등이 파손됐어요","기둥이 기울었어요","전선이 노출됐어요","기타"];
const $=s=>document.querySelector(s);
const st={code:"",lightId:null,facility:null,issue:"",photo:null,pos:null};
let codeRevision=0,gpsRevision=0,photoRevision=0,copyRevision=0;
const officialRequested=()=>C.backend==="official";
const officialTarget=()=>globalThis.DGOfficialHandoff?.destination(C.officialUrl)||null;
const officialStatusTarget=()=>globalThis.DGOfficialHandoff?.statusDestination(C.officialStatusUrl)||null;
const contactPhone=String(C.phone||"").trim()==="062-000-0000"?"":String(C.phone||"").trim();
$("#orgLine").textContent=[C.org,C.dept].filter(Boolean).join(" ");$("#pdays").textContent=C.privacyDays;$("#phoneLine").textContent=contactPhone||"담당 부서의 공식 연락처";
function deliveryMode(){
  if(officialRequested())return officialTarget()?"official":null;
  const local=C.allowLocalGateway===true&&/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(C.gatewayUrl||"");
  if(C.backend==="gateway"&&(local||(/^https:\/\//.test(C.gatewayUrl||"")&&C.appCheckSiteKey&&C.firestore&&C.firestore.projectId&&C.firestore.apiKey&&C.firestore.appId)))return "gateway";
  return String(C.sms||"").trim()||String(C.mail||"").trim()?"external":null;
}
function updateOfficialSummary(){
  if(!officialRequested())return;
  copyRevision++;
  const out=$("#officialSummary"),api=globalThis.DGOfficialHandoff;
  out.value=api?api.summary({code:st.code,lightId:st.lightId,facility:st.facility,issue:st.issue,desc:$("#desc").value}):"신고 안내를 불러오지 못했어요. 페이지를 다시 열어 주세요.";
  $("#officialCopy").disabled=!api;$("#officialCopyState").textContent="";
}
function configureOfficialLink(id,url,status=false){
  const link=$(id);link.hidden=status&&!url;
  if(url){link.href=url;link.removeAttribute("aria-disabled");link.removeAttribute("tabindex")}
  else{link.removeAttribute("href");link.setAttribute("aria-disabled","true");link.tabIndex=-1}
  link.onclick=event=>{const approved=status?officialStatusTarget():officialTarget();if(!officialRequested()||!approved){event.preventDefault();$("#officialDestinationNotice").textContent="운영서비스 연결 주소를 확인할 수 없어요. 담당자에게 확인해 주세요.";return}link.href=approved;$("#officialDestinationNotice").textContent="운영서비스에서 신고 또는 조회를 마쳐 주세요. 이 페이지에서는 접수 여부를 확인할 수 없어요."};
}
function configureDelivery(){
  const mode=deliveryMode(),btn=$("#send"),notice=$("#deliveryNotice"),official=officialRequested();
  $("#officialEntry").hidden=!official;$("#officialFacilityState").hidden=!official;$("#officialCopyActions").hidden=!official;$("#assistSummary").hidden=!official;$("#contentAssist").open=!official;$("#contentAssist").className=official?"content-assist official-assist":"content-assist";
  $("#privateInputs").hidden=official;$("#legacySubmit").hidden=official;$("#legacyFoot").hidden=official;$("#officialFoot").hidden=!official;
  if(official){
    $("#codeLabel").textContent="기둥에 붙은 표찰 번호 (선택). 모르면 비워 두고 운영서비스 지도에서 시설을 찾아 주세요.";
    $("#orgLine").textContent="비공식 신고 안내 · 실제 접수는 운영서비스에서";$("#officialName").textContent=String(C.officialName||"운영서비스").slice(0,100);
    configureOfficialLink("#officialOpen",officialTarget());configureOfficialLink("#officialOpenAfterCopy",officialTarget());configureOfficialLink("#officialStatus",officialStatusTarget(),true);
    $("#officialDestinationNotice").textContent=mode?"새 창의 운영서비스에서 시설 선택·휴대폰 확인 등 필요한 절차를 진행해 주세요.":"운영서비스 연결 주소를 확인할 수 없어요. 담당자에게 확인해 주세요.";
    $("#useGps").checked=false;st.pos=null;gpsRevision++;st.photo=null;photoRevision++;$("#prev").hidden=true;$("#photoDel").hidden=true;$("#statusOpen").hidden=true;
    updateOfficialSummary();
  }
  btn.disabled=!mode||official;btn.textContent=mode==="gateway"?"신고 보내기":mode==="external"?"신고 내용 준비하기":"신고 접수 준비 중";
  notice.hidden=official||mode==="gateway";
  notice.textContent=mode==="external"?"신고 내용을 준비한 뒤 문자·이메일 앱에서 직접 보내 주세요. 보내기 전에는 접수되지 않아요.":`현재 이 페이지의 신고 접수가 준비 중이에요. ${contactPhone?contactPhone+"로 문의해 주세요.":"담당 부서의 공식 연락처로 문의해 주세요."}`;
}
configureDelivery();
// plate code from the QR link (?c=산수동 642) or typed
const params=new URLSearchParams(location.search),q=params.get("c"),qrId=params.get("lid");
st.lightId=qrId&&/^[A-Za-z0-9_-]{1,120}$/.test(qrId)?qrId:null;
function setCode(c,editing=false){st.code=(c||"").trim().slice(0,40);$("#codeKnown").hidden=editing||!st.code;$("#codeAsk").hidden=!editing&&!!st.code;$("#codeText").textContent=st.code;updateOfficialSummary()}
setCode(q);
if(officialRequested()&&params.has("status"))$("#officialTitle").textContent="처리상태는 운영서비스에서 확인해 주세요";
$("#codeEdit").onclick=()=>{codeRevision++;st.lightId=null;st.facility=null;$("#codeConfirmed").hidden=true;$("#codeIn").value=st.code;$("#codeHint").replaceChildren();setCode(st.code,true);$("#officialFacilityState").textContent="수정한 표찰은 목록에서 다시 확인할 수 있어요.";$("#codeIn").focus()};
/* 표찰 번호 확인: 공개 가로등 대장(data/lights.json)에서 같은 번호를 찾아 보여 줘요. 띄어쓰기·하이픈 모양·앞자리 0·"동" 생략은
   같은 번호로 봐요(예: "운림 63" = "운림동 063", "270 - 4" = "270-4"). 고르면 그 등으로 바로 연결되고, 못 찾아도 그대로 보낼 수 있어요. */
let LIGHTS=null,LIGHTS_LOADING=null;
function loadLights(){if(LIGHTS)return Promise.resolve(LIGHTS);return LIGHTS_LOADING||(LIGHTS_LOADING=fetch(new URL("../data/lights.json",location.href)).then(r=>{if(!r.ok)throw new Error("대장 조회 실패");return r.json()}).then(j=>{if(!Array.isArray(j.cols)||!Array.isArray(j.rows))throw new Error("대장 형식 오류");const at=k=>j.cols.indexOf(k);
  LIGHTS=j.rows.filter(r=>!r[at("removed")]&&r[at("code")]).map(r=>{const code=String(r[at("code")]);return{id:r[at("id")],code,lampId:at("lampId")<0?null:r[at("lampId")],kind:r[at("kind")]||"",place:r[at("addr")]||r[at("jibun")]||[r[at("dong")],r[at("road")]].filter(Boolean).join(" "),key:codeKey(code)}});return LIGHTS}).catch(()=>null).finally(()=>{LIGHTS_LOADING=null}))}
async function resolveOfficialFacility(){
  if(!officialRequested()||!st.lightId)return;
  const id=st.lightId,revision=codeRevision;$("#officialFacilityState").textContent="대장에서 시설번호를 확인하는 중이에요…";
  const rows=await loadLights();if(revision!==codeRevision||st.lightId!==id||!officialRequested())return;
  const matches=(rows||[]).filter(row=>row.id===id),row=matches.length===1?matches[0]:null;
  st.facility=row;$("#codeConfirmed").hidden=!row;
  if(row){setCode(row.code);$("#officialFacilityState").textContent=row.lampId==null||String(row.lampId)===""?"표찰은 확인했어요. 운영 시설번호는 이 대장에 없어 추정하지 않아요.":"운영 시설번호 "+String(row.lampId)+" · 이 번호는 메모로 복사하며 링크에 자동 전달하지 않아요."}
  else{$("#officialFacilityState").textContent=rows?"이 시설 ID가 대장에 없거나 철거된 상태예요. 같은 표찰의 다른 시설로 추정 연결하지 않아요. 운영서비스에서 확인해 주세요.":"대장을 불러오지 못했어요. 운영서비스에서 시설을 확인하거나 번호를 다시 확인해 주세요.";updateOfficialSummary()}
}
function codeKey(v){return String(v||"").normalize("NFKC").replace(/[‐-―−~]/g,"-").replace(/\s+/g,"").replace(/\d+/g,n=>String(+n))}
function codeParts(key){const m=/^([^\d-]*)(.*)$/.exec(key);return{letters:m[1],rest:m[2]}}
function findCodes(text){
  const key=codeKey(text);if(!key||!LIGHTS)return[];
  const exact=LIGHTS.filter(l=>l.key===key);if(exact.length)return exact.slice(0,5);
  const q=codeParts(key);if(!q.rest)return LIGHTS.filter(l=>l.key.startsWith(key)).slice(0,5);
  return LIGHTS.filter(l=>{const p=codeParts(l.key);return p.rest===q.rest&&(!q.letters||p.letters.startsWith(q.letters.replace(/동$/,"")))}).slice(0,5);
}
async function codeLookup(){
  const hint=$("#codeHint"),text=$("#codeIn").value,revision=++codeRevision;if(codeKey(text).length<2){hint.replaceChildren();return}
  if(!LIGHTS){hint.textContent="번호 확인 중…";const rows=await loadLights();if($("#codeIn").value!==text||revision!==codeRevision||$("#codeAsk").hidden)return;if(!rows){hint.textContent="대장을 불러오지 못했어요. 다시 입력하면 확인을 재시도해요.";return}}
  if(revision!==codeRevision||$("#codeAsk").hidden)return;
  const found=findCodes(text);hint.replaceChildren();
  if(!found.length){hint.textContent=officialRequested()?"대장에서 이 번호를 찾지 못했어요. 입력한 표찰은 메모로 복사하고 운영서비스에서 시설을 확인해 주세요.":"대장에서 이 번호를 찾지 못했어요. 표찰에 적힌 그대로라면 이대로 보내도 돼요.";return}
  const lead=document.createElement("div");lead.textContent=officialRequested()?"이 중에 있나요? 고르면 해당 시설의 표찰을 메모에 넣어요.":found.length===1&&found[0].key===codeKey(text)?"이 등이 맞나요? 누르면 이 등으로 신고해요.":"이 중에 있나요? 누르면 그 등으로 신고해요.";hint.appendChild(lead);
  const box=document.createElement("div");box.className="pick";
  for(const l of found){const b=document.createElement("button");b.type="button";const t=document.createElement("b");t.textContent=l.code;const sm=document.createElement("small");sm.textContent=[l.kind,l.place].filter(Boolean).join(" · ");b.append(t,sm);
    b.onclick=()=>{if(revision!==codeRevision||$("#codeIn").value!==text||$("#codeAsk").hidden)return;codeRevision++;st.lightId=/^[A-Za-z0-9_-]{1,120}$/.test(l.id)?l.id:null;st.facility=st.lightId?l:null;setCode(l.code);$("#codeConfirmed").hidden=!st.lightId;$("#officialFacilityState").textContent=l.lampId==null||String(l.lampId)===""?"표찰은 확인했어요. 운영 시설번호는 추정하지 않아요.":"운영 시설번호 "+String(l.lampId)+" · 링크에는 자동 전달하지 않아요.";hint.replaceChildren()};box.appendChild(b)}
  hint.appendChild(box);
}
let codeTimer=null;
$("#codeIn").addEventListener("focus",()=>{loadLights()},{once:true});
$("#codeIn").addEventListener("input",e=>{codeRevision++;st.lightId=null;st.facility=null;st.code=e.target.value.trim().slice(0,40);$("#codeConfirmed").hidden=true;$("#codeHint").replaceChildren();$("#officialFacilityState").textContent="입력한 표찰은 목록에서 확인하거나 운영서비스에서 확인해 주세요.";updateOfficialSummary();if(typeof setTimeout!=="function")return;if(codeTimer)clearTimeout(codeTimer);codeTimer=setTimeout(codeLookup,250)});
$("#issues").innerHTML=ISSUES.map(i=>`<button type="button" aria-pressed="false">${i}</button>`).join("");
$("#issues").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;st.issue=b.textContent;document.querySelectorAll("#issues button").forEach(x=>x.setAttribute("aria-pressed",x===b));updateOfficialSummary()});
$("#desc").addEventListener("input",updateOfficialSummary);
$("#officialCopy").onclick=async()=>{if(!officialRequested()||!globalThis.DGOfficialHandoff)return;updateOfficialSummary();const text=$("#officialSummary").value,revision=copyRevision;try{await navigator.clipboard.writeText(text);if(revision!==copyRevision||!officialRequested())return;$("#officialCopyState").textContent="복사했어요. 운영서비스에 붙여 넣고 신고를 마쳐 주세요."}catch(e){if(revision!==copyRevision||!officialRequested())return;$("#officialSummary").focus();$("#officialSummary").select();$("#officialCopyState").textContent="자동 복사를 사용할 수 없어요. 선택된 메모를 직접 복사해 주세요. 운영서비스 링크는 그대로 사용할 수 있어요."}};
if(officialRequested())resolveOfficialFacility();
// photo: shrink to ~150 KB so it fits in one record
async function shrink(file){const img=await new Promise((res,rej)=>{const i=new Image(),u=URL.createObjectURL(file);i.onload=()=>{URL.revokeObjectURL(u);res(i)};i.onerror=rej;i.src=u});
  let max=1000,qv=.7,out;for(let k=0;k<5;k++){const r=Math.min(1,max/Math.max(img.width,img.height));const c=document.createElement("canvas");c.width=Math.round(img.width*r);c.height=Math.round(img.height*r);c.getContext("2d").drawImage(img,0,0,c.width,c.height);out=c.toDataURL("image/jpeg",qv);if(out.length*0.75/1024<=C.maxPhotoKB)break;max*=.8;qv-=.08}return out}
$("#photoBtn").onclick=()=>{if(officialRequested())return;$("#photo").value="";$("#photo").click()};$("#photoLibBtn").onclick=()=>{if(officialRequested())return;$("#photoLib").value="";$("#photoLib").click()};
for(const id of ["photo","photoLib"])$("#"+id).addEventListener("change",async e=>{if(officialRequested()){e.target.value="";return}const f=e.target.files&&e.target.files[0];if(!f)return;const revision=++photoRevision;try{const value=await shrink(f);if(revision!==photoRevision||officialRequested())return;st.photo=value;$("#prev").src=st.photo;$("#prev").hidden=false;$("#photoDel").hidden=false}catch(err){if(revision===photoRevision&&!officialRequested())showErr("사진을 읽지 못했어요. 다른 사진을 골라 주세요.")}});
$("#photoDel").onclick=()=>{photoRevision++;st.photo=null;$("#prev").hidden=true;$("#photoDel").hidden=true};
// location
/* 현재 위치는 광주 동구 주변일 때만 신고에 붙여요(서버 규칙과 같은 범위). 동구 밖에서 신고해도 접수는 되고, 그때는 좌표만 빠져요. */
const inArea=p=>!!p&&p.lat>=34.9&&p.lat<=35.3&&p.lng>=126.7&&p.lng<=127.1;
const gpsText=p=>!p?"(위치를 못 잡았어요 — 꺼도 돼요)":inArea(p)?`(±${p.acc}m)`:"(지금 동구 밖이에요 — 위치는 빼고 보내요. 등 번호나 장소를 적어 주세요)";
function getPos(){return new Promise(res=>{if(!navigator.geolocation)return res(null);navigator.geolocation.getCurrentPosition(p=>res({lat:+p.coords.latitude.toFixed(6),lng:+p.coords.longitude.toFixed(6),acc:Math.round(p.coords.accuracy)}),()=>res(null),{enableHighAccuracy:true,timeout:8000,maximumAge:30000})})}
$("#useGps").addEventListener("change",async e=>{const revision=++gpsRevision;if(officialRequested()||!deliveryMode()){e.target.checked=false;st.pos=null;$("#gpsState").textContent="";return}if(e.target.checked){$("#gpsState").textContent="(위치 잡는 중…)";const pos=await getPos();if(revision!==gpsRevision||officialRequested()||!$("#useGps").checked)return;st.pos=pos;$("#gpsState").textContent=gpsText(st.pos)}else{st.pos=null;$("#gpsState").textContent=""}});
if(!officialRequested()&&deliveryMode())(async()=>{const revision=++gpsRevision;$("#gpsState").textContent="(위치 잡는 중…)";const pos=await getPos();if(revision!==gpsRevision||officialRequested()||!$("#useGps").checked)return;st.pos=pos;$("#gpsState").textContent=gpsText(st.pos)})();
function showErr(m){const e=$("#err");e.textContent=m;e.hidden=false;e.scrollIntoView({block:"center"})}
function receiptNo(){const d=new Date();const r=Math.random().toString(36).slice(2,6).toUpperCase();return `R${String(d.getFullYear()).slice(2)}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${r}`}
function buildText(rec){return `[가로등 고장 신고 ${rec.receipt}]\n등 번호: ${rec.code||"(모름)"}\n문제: ${rec.issue}\n내용: ${rec.desc||"-"}\n위치: ${rec.lat?`${rec.lat}, ${rec.lng} (±${rec.acc}m)`:"-"}\n연락처: ${rec.contact||"-"}\n시각: ${new Date(rec.at).toLocaleString("ko-KR")}`}
const REPORT_SCRIPTS=new Map();
function loadReportScript(src){if(REPORT_SCRIPTS.has(src))return REPORT_SCRIPTS.get(src);const promise=new Promise((resolve,reject)=>{const script=document.createElement("script");script.src=src;script.onload=resolve;script.onerror=()=>{REPORT_SCRIPTS.delete(src);script.remove();reject(new Error("접수 기능을 불러오지 못했어요."))};document.head.appendChild(script)});REPORT_SCRIPTS.set(src,promise);return promise;}
function localUrl(u){return C.allowLocalGateway===true&&/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(u||"")}
async function serverHeaders(url){
  const headers={"Content-Type":"application/json"};if(localUrl(url))return headers;
  for(const component of ["app","app-check"])await loadReportScript(`https://www.gstatic.com/firebasejs/10.12.2/firebase-${component}-compat.js`);
  if(!firebase.apps.length)firebase.initializeApp(C.firestore);if(!st.appCheck){firebase.appCheck().activate(C.appCheckSiteKey,true);st.appCheck=true;}
  /* a fresh limited-use token per request: the server consumes it, so it cannot be replayed */headers["X-Firebase-AppCheck"]=(await firebase.appCheck().getLimitedUseToken()).token;return headers;
}
async function sendGateway(rec){
  if(deliveryMode()!=="gateway")throw new Error("현재 페이지는 자체 서버 접수 방식이 아니에요.");
  const payload={code:rec.code,lightId:rec.lightId||"",issue:rec.issue,desc:rec.desc,lat:rec.lat,lng:rec.lng,acc:rec.acc,photo:rec.photo||"",contact:rec.contact||"",consent:rec.consent,consentDays:C.privacyDays};
  const key=JSON.stringify(payload);if(!st.submitJob||st.submitJob.key!==key)st.submitJob={key,requestId:crypto.randomUUID()};
  const headers=await serverHeaders(C.gatewayUrl);
  const response=await fetch(C.gatewayUrl,{method:"POST",headers,body:JSON.stringify({...payload,requestId:st.submitJob.requestId}),cache:"no-store"});
  const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||"접수 서버에 연결하지 못했어요.");
  if(typeof result.receipt!=="string"||!result.receipt)throw new Error("접수 확인을 받지 못했어요. 같은 내용으로 다시 시도해 주세요.");
  return result;
}
$("#send").onclick=async()=>{
  $("#err").hidden=true;
  if(officialRequested()){configureDelivery();return}
  const mode=deliveryMode();if(!mode){configureDelivery();showErr($("#deliveryNotice").textContent);return}
  if(!st.issue){showErr("무슨 문제인지 하나 골라 주세요.");return}
  const contact=$("#contact").value.trim();if(contact&&!$("#consent").checked){showErr("연락처를 남기려면 보관 동의에 체크해 주세요.");return}
  const useGps=$("#useGps").checked&&inArea(st.pos);
  const rec={receipt:receiptNo(),code:st.code,lightId:st.lightId,issue:st.issue,desc:$("#desc").value.trim().slice(0,500),lat:useGps&&st.pos?st.pos.lat:null,lng:useGps&&st.pos?st.pos.lng:null,acc:useGps&&st.pos?st.pos.acc:null,photo:st.photo||null,contact:contact||null,consent:!!contact,at:Date.now(),ua:navigator.userAgent.slice(0,80),imported:false};
  if(!rec.code&&!rec.lightId&&!rec.desc&&rec.lat==null){showErr($("#useGps").checked&&st.pos&&!inArea(st.pos)?"지금 위치가 동구 밖이라 위치로는 찾을 수 없어요. 등 번호나 장소(예: ○○마트 앞)를 적어 주세요.":"등 번호, 위치 설명 또는 현재 위치 중 하나는 알려 주세요.");return}
  const btn=$("#send");btn.disabled=true;btn.textContent="보내는 중…";
  try{
    if(mode==="gateway"){const result=await sendGateway(rec);rec.receipt=result.receipt;rec.statusCode=typeof result.statusCode==="string"?result.statusCode:"";if(rec.statusCode)remember(rec.receipt,rec.statusCode);finish(rec,"담당 부서에 바로 전달됐어요.")}
    else{
      const text=buildText(rec);const hasPhoto=!!rec.photo;
      finish(rec,`아직 접수되지 않았어요. 아래 버튼으로 문자·이메일 앱을 열고 직접 보내 주세요.${hasPhoto?" 사진은 메시지에 직접 첨부해 주세요.":""}`,text);
      const alt=$("#alt");alt.hidden=false;alt.replaceChildren();
      const addLink=(label,href,style)=>{const a=document.createElement("a");a.className="btn "+style;a.textContent=label;a.href=href;alt.appendChild(a)};
      if(String(C.sms||"").trim())addLink("문자로 보내기",`sms:${String(C.sms).trim()}${/iphone|ipad/i.test(navigator.userAgent)?"&":"?"}body=${encodeURIComponent(text)}`,"sodium");
      if(String(C.mail||"").trim())addLink("이메일로 보내기",`mailto:${String(C.mail).trim()}?subject=${encodeURIComponent("가로등 고장 신고 "+rec.receipt)}&body=${encodeURIComponent(text)}`,"ghost");
      $("#done").appendChild(alt);
    }
  }catch(e){configureDelivery();showErr((e&&e.message?e.message+" ":"")+"보내지 못했어요. 잠시 후 같은 내용으로 다시 시도하거나 "+(contactPhone||"담당 부서의 공식 연락처")+"로 문의해 주세요.")}
};
function finish(rec,msg,copy){if(officialRequested())return;const sent=!copy;$("#doneCode").hidden=!(sent&&rec.statusCode&&statusEnabled());$("#doneCodeText").textContent=rec.statusCode||"";$("#form").hidden=true;$("#done").hidden=false;$("#doneIcon").textContent=sent?"✓":"→";$("#doneTitle").textContent=sent?"접수됐어요":"신고 내용을 준비했어요 · 전송 전";$("#receipt").hidden=!sent;$("#receipt").textContent=sent?rec.receipt:"";$("#doneMsg").textContent=msg;$("#doneFoot").textContent=sent?"감사합니다. 같은 등을 여러 번 신고하지 않으셔도 돼요.":"문자·이메일 앱에서 보내기를 눌러 신고를 마쳐 주세요.";$("#doneCopy").hidden=sent;if(copy){$("#copyText").value=copy;$("#copyBtn").onclick=async()=>{try{await navigator.clipboard.writeText(copy);$("#copyBtn").textContent="복사했어요"}catch(e){$("#copyText").select()}}}window.scrollTo(0,0)}
// ---------- 처리 상태 확인 (게이트웨이와 statusUrl이 설정됐을 때만) ----------
function statusEnabled(){return deliveryMode()==="gateway"&&(localUrl(C.statusUrl)||/^https:\/\//.test(C.statusUrl||""))}
const SAVED_KEY="dg-report-receipts";
function savedReceipts(){try{const v=JSON.parse(localStorage.getItem(SAVED_KEY)||"[]");return Array.isArray(v)?v.filter(x=>x&&typeof x.r==="string"&&typeof x.k==="string").slice(0,10):[]}catch(e){return []}}
function remember(r,k){try{localStorage.setItem(SAVED_KEY,JSON.stringify([{r,k,at:Date.now()},...savedReceipts().filter(x=>x.r!==r)].slice(0,10)))}catch(e){}}
const STAGES=[["received","접수"],["reviewing","담당자 확인"],["in-progress","처리 중"],["done","완료"]];
function showStatus(r,k){
  if(officialRequested()||!statusEnabled())return;
  $("#form").hidden=true;$("#done").hidden=true;$("#statusView").hidden=false;$("#statusOpen").hidden=true;
  if(r)$("#stReceipt").value=r;if(k)$("#stCode").value=k;
  const saved=savedReceipts();$("#stSaved").hidden=!saved.length;$("#stSavedList").replaceChildren(...saved.map(x=>{const b=document.createElement("button");b.type="button";b.textContent=x.r;b.dataset.r=x.r;b.dataset.k=x.k;return b}));
  if(r&&k)checkStatus();else $("#stReceipt").focus();
}
async function checkStatus(){
  if(officialRequested()||!statusEnabled())return;
  const err=$("#stErr"),out=$("#stResult"),btn=$("#stCheck");err.hidden=true;
  const receipt=$("#stReceipt").value.trim().toUpperCase().replace(/\s+/g,""),code=$("#stCode").value.trim().toUpperCase().replace(/[\s-]+/g,"");
  if(!/^R\d{6}-[0-9A-F]{8}$/.test(receipt)){err.textContent="접수번호를 확인해 주세요. 예: R261104-1A2B3C4D";err.hidden=false;return}
  if(!/^[2-9A-HJ-NP-Z]{6}$/.test(code)){err.textContent="확인 코드 6자리를 확인해 주세요.";err.hidden=false;return}
  btn.disabled=true;btn.textContent="확인하는 중…";
  try{
    const response=await fetch(C.statusUrl,{method:"POST",headers:await serverHeaders(C.statusUrl),body:JSON.stringify({receipt,code}),cache:"no-store"});
    const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||"지금은 조회할 수 없어요.");
    const at=STAGES.findIndex(x=>x[0]===result.stage);if(at<0)throw new Error("처리 상태를 읽지 못했어요.");
    remember(receipt,code);
    const ol=document.createElement("ol");ol.className="steps";STAGES.forEach(([,label],i)=>{const li=document.createElement("li");li.textContent=label;if(i<at||(i===at&&result.stage==="done"))li.className="on";else if(i===at)li.className="now";ol.appendChild(li)});
    const h=document.createElement("div");h.style.cssText="font-size:18px;font-weight:800";h.textContent=result.label;
    const p=document.createElement("p");p.className="muted";p.style.margin="4px 0 0";p.textContent=`${result.detail}${result.updatedOn?` · ${result.updatedOn} 기준`:""}`;
    const rc=document.createElement("p");rc.className="muted";rc.style.margin="8px 0 0";rc.textContent="접수번호 "+result.receipt;
    out.replaceChildren(h,ol,p,rc);out.hidden=false;
  }catch(e){out.hidden=true;err.textContent=(e&&e.message)||"지금은 조회할 수 없어요.";err.hidden=false}
  finally{btn.disabled=false;btn.textContent="확인하기"}
}
if(statusEnabled()){
  $("#statusOpen").hidden=false;
  $("#footLead").textContent="이 페이지는 신고를 받고, 오른쪽 위 「처리 상태 보기」에서 접수번호로 처리 단계를 확인할 수 있어요. 그 밖의 문의는 ";
  $("#statusOpen").onclick=()=>showStatus();$("#doneStatus").onclick=()=>showStatus($("#receipt").textContent,$("#doneCodeText").textContent);
  $("#stCheck").onclick=checkStatus;$("#stSavedList").addEventListener("click",e=>{const b=e.target.closest("button");if(b){$("#stReceipt").value=b.dataset.r;$("#stCode").value=b.dataset.k;checkStatus()}});
  for(const id of ["stReceipt","stCode"])$("#"+id).addEventListener("keydown",e=>{if(e.key==="Enter")checkStatus()});
  $("#stBack").onclick=()=>{$("#statusView").hidden=true;$("#form").hidden=false;$("#statusOpen").hidden=false;$("#done").hidden=true};
  if(params.has("status"))showStatus(params.get("r")||"");
}
