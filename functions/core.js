'use strict';
const crypto = require('node:crypto');
class InputError extends Error { constructor(message, code = 'invalid-argument') { super(message); this.code = code; } }
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function text(value, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new InputError('입력 형식이나 길이를 확인하세요.');
  return value.trim();
}
function identity(value) { const id=text(value,128,true);if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw new InputError('요청 ID를 확인하세요.');return id; }
function days(value, fallback=90) { return Number.isInteger(value)&&value>=1&&value<=3650?value:fallback; }
function normalizeReport(input, now, privacyDays=90) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('신고 내용을 확인하세요.');
  const allowed=['requestId','code','lightId','issue','desc','lat','lng','acc','photo','contact','consent','consentDays'];
  if (Object.keys(input).some(k=>!allowed.includes(k))) throw new InputError('허용되지 않은 신고 항목입니다.');
  const requestId=identity(input.requestId),code=text(input.code,40),lightId=text(input.lightId,120),issue=text(input.issue,40,true),desc=text(input.desc,500),contact=text(input.contact,40);
  if (typeof input.consent !== 'boolean' || (contact && !input.consent)) throw new InputError('연락처 보관 동의가 필요합니다.');
  if(input.consentDays!==undefined&&days(input.consentDays,0)===0)throw new InputError('보관 기간을 확인하세요.');
  const consentDays=days(input.consentDays);
  const rec={schemaVersion:1,code,lightId,issue,desc,contact,consent:!!contact,consentDays,imported:false,at:now,privacyExpiresAt:now+Math.min(days(privacyDays),consentDays)*86400000};
  if (input.lat!=null || input.lng!=null) {
    if (!Number.isFinite(input.lat)||input.lat < -90||input.lat > 90||!Number.isFinite(input.lng)||input.lng < -180||input.lng > 180) throw new InputError('위치를 확인하세요.');
    rec.lat=+input.lat.toFixed(6);rec.lng=+input.lng.toFixed(6);
    if(input.acc!=null){if(!Number.isFinite(input.acc)||input.acc<0||input.acc>100000)throw new InputError('위치 정확도를 확인하세요.');rec.acc=Math.round(input.acc);}
  }
  if(!code&&!lightId&&!desc&&rec.lat==null)throw new InputError('등 번호, 위치 설명 또는 현재 위치가 필요합니다.');
  const photo=text(input.photo,1500000);
  if(photo&&!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo))throw new InputError('사진은 JPEG, PNG, WebP 파일만 사용할 수 있습니다.');
  return {requestId,rec,photo};
}
async function normalizePhoto(value, sharp) {
  if(!value)return null;
  try {
    const raw=Buffer.from(value.slice(value.indexOf(',')+1),'base64');
    if(!raw.length||raw.length>1100000)throw new Error('size');
    // Decode, orient, resize and encode afresh: no EXIF, embedded metadata or remote URL survives.
    const data=await sharp(raw,{limitInputPixels:20000000,animated:false}).rotate().resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();
    if(data.length>500000)throw new Error('size');
    return 'data:image/jpeg;base64,'+data.toString('base64');
  } catch { throw new InputError('사진을 읽지 못했거나 허용 크기를 초과했습니다.'); }
}
function consumeLimit(previous, now, max=10, windowMs=3600000) {
  const current=previous&&Number.isFinite(previous.start)&&now-previous.start<windowMs?previous:{start:now,count:0};
  if(current.count>=max)throw new InputError('접수가 잠시 많습니다. 나중에 다시 시도하세요.','resource-exhausted');
  return {start:current.start,count:current.count+1,expiresAt:now+windowMs*2};
}
const PRIVATE_FIELDS=['contact','photo','lat','lng','acc','ua'];
function auditSummary(before, after) {
  const changed=[...new Set([...Object.keys(before||{}),...Object.keys(after||{})])].filter(k=>JSON.stringify(before&&before[k])!==JSON.stringify(after&&after[k])).sort();
  const snapshot=value=>value?Object.fromEntries(['role','status','result','lightId','reviewedAt','reviewedBy','assignedTo','revision','imported','privacyPurgedAt'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]])):null;
  return {action:!before?'create':!after?'delete':'update',changedFields:changed,before:snapshot(before),after:snapshot(after)};
}
module.exports={InputError,hash,text,identity,days,normalizeReport,normalizePhoto,consumeLimit,PRIVATE_FIELDS,auditSummary};
