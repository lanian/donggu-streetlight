#!/usr/bin/env node
/* 도로조명 관리시스템(roadlighting.kr) getPoint.json → data/lights.json
   사용: node scripts/build-registry.mjs getPoint.json [data/lights.json]
   입력은 {RESULT_CD, RESULT_MSG, DATA:[{lamp_id,label_no,latitude,longitude,facility_class,lampName,poleName,jumName,...}]} 형식 */
import fs from "node:fs";
const [,, inPath, outPath="data/lights.json"]=process.argv;
if(!inPath){console.error("사용: node scripts/build-registry.mjs getPoint.json [data/lights.json]");process.exit(1)}
const DONGS=["계림동","광산동","궁동","금남로1가","금남로2가","금남로3가","금남로4가","금남로5가","금동","남동","대의동","대인동","동명동","불로동","산수동","서석동","소태동","수기동","용산동","운림동","월남동","장동","지산동","충장로1가","충장로2가","충장로3가","충장로4가","충장로5가","학동","호남동","황금동"];
const COLS=["id","lampId","label","code","kind","dong","num","road","main","sub","lat","lng","lampType","pole","sw","removed","noPlate","dongGuess"];
const raw=JSON.parse(fs.readFileSync(inPath,"utf8"));const src=Array.isArray(raw)?raw:(raw.DATA||[]);
const tidy=v=>(v==null?"":String(v)).trim();
const first=[],byDongSorted=[...DONGS].sort((a,b)=>b.length-a.length);
for(const s of src){
  const lampId=tidy(s.lamp_id),label=tidy(s.label_no),kind=tidy(s.facility_class)||"보안등";
  const r7=v=>Math.round(+v*1e7)/1e7;const lat=r7(s.latitude),lng=r7(s.longitude);
  const o={id:"p"+lampId,lampId,label,code:label,kind,dong:"",num:null,road:null,main:null,sub:null,lat,lng,lampType:tidy(s.lampName),pole:tidy(s.poleName),sw:tidy(s.jumName),removed:null,noPlate:null,dongGuess:null};
  const compact=label.replace(/\s+/g,"");
  if(/철거/.test(compact))o.removed=1;
  if(/표찰없음/.test(compact))o.noPlate=1;
  const dong=byDongSorted.find(d=>compact.startsWith(d));
  if(dong){o.dong=dong;const rest=compact.slice(dong.length);const restRaw=label.replace(/\s+/g,"").startsWith(dong)?label.trim().replace(new RegExp("^"+dong+"\\s*"),""):rest;o.code=rest?`${dong} ${restRaw}`:dong;const core=rest.replace(/\(.*$/,"");if(/^\d+(-\d+)*$/.test(core))o.num=core;}
  else if(kind==="가로등"){const m=compact.match(/^(.*?[로길](?:\d+번길)?)?(\d+)(?:-(\d+))?(\(철거\))?$/);
    if(m){o.road=m[1]||"";o.main=m[2];o.sub=m[3]||null;o.code=`${o.road?o.road+" ":""}${o.main}${o.sub?"-"+o.sub:""}${m[4]||""}`}}
  first.push(o);
}
// 동 이름이 없는 등(가로등 숫자 표찰 등)은 가장 가까운, 동이 적힌 등의 동으로 추정
const known=first.filter(o=>o.dong&&Number.isFinite(o.lat));
const kx=111320*Math.cos(35.14*Math.PI/180),ky=110540;
for(const o of first){if(o.dong||!Number.isFinite(o.lat))continue;let best=null,bd=1e12;for(const k of known){const d=((k.lng-o.lng)*kx)**2+((k.lat-o.lat)*ky)**2;if(d<bd){bd=d;best=k}}if(best){o.dong=best.dong;o.dongGuess=1}}
const rows=first.map(o=>COLS.map(c=>o[c]===""&&["num","road","main","sub","removed","noPlate","dongGuess"].includes(c)?null:o[c]));
fs.writeFileSync(outPath,JSON.stringify({cols:COLS,rows}));
const kinds={};first.forEach(o=>kinds[o.kind]=(kinds[o.kind]||0)+1);
console.log(`${first.length}개 → ${outPath}`,kinds,`철거 ${first.filter(o=>o.removed).length} · 표찰없음 ${first.filter(o=>o.noPlate).length} · 동 추정 ${first.filter(o=>o.dongGuess).length}`);
