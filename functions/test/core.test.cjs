const {test}=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const C=require('../core');
const report=extra=>({requestId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',code:'산수동 1',issue:'불이 꺼져 있어요',desc:'',contact:'',consent:false,...extra});

test('gateway schema accepts empty description, uses server time and requires a location',()=>{
  const result=C.normalizeReport(report(),1000,90);
  assert.equal(result.rec.desc,'');assert.equal(result.rec.at,1000);assert.equal(result.rec.privacyExpiresAt,1000+90*86400000);
  assert.throws(()=>C.normalizeReport(report({at:1}),1000),/허용되지/);
  assert.throws(()=>C.normalizeReport(report({code:''}),1000),/위치/);
  assert.throws(()=>C.normalizeReport(report({contact:'01012345678'}),1000),/동의/);
  assert.throws(()=>C.normalizeReport(report({lat:35,lng:999}),1000),/위치/);
  assert.throws(()=>C.normalizeReport(report({photo:'https://example.invalid/tracker'}),1000),/사진/);
  assert.equal(C.normalizeReport(report({consentDays:90}),1000,3650).rec.privacyExpiresAt,1000+90*86400000);
  assert.equal(C.normalizeReport(report({consentDays:120}),1000,30).rec.privacyExpiresAt,1000+30*86400000);
  assert.equal(C.normalizeReport(report(),1000,3650).rec.consentDays,90);
  assert.throws(()=>C.normalizeReport(report({consentDays:0}),1000),/보관 기간/);
});
test('rate limits use a fixed server window and reset only after expiry',()=>{
  let current;for(let i=0;i<10;i++)current=C.consumeLimit(current,1000+i);
  assert.equal(current.count,10);assert.throws(()=>C.consumeLimit(current,2000),/접수가/);
  assert.equal(C.consumeLimit(current,3601000).count,1);
});
test('real photo decoding resizes and removes EXIF instead of accepting an image-shaped string',async()=>{
  const original=await sharp({create:{width:1800,height:1400,channels:3,background:'#aabbcc'}}).jpeg().withMetadata().toBuffer();
  assert.ok((await sharp(original).metadata()).exif);
  const converted=await C.normalizePhoto('data:image/jpeg;base64,'+original.toString('base64'),sharp);
  const meta=await sharp(Buffer.from(converted.split(',')[1],'base64')).metadata();
  assert.equal(meta.format,'jpeg');assert.ok(meta.width<=1280&&meta.height<=1280);assert.equal(meta.exif,undefined);
  await assert.rejects(()=>C.normalizePhoto('data:image/jpeg;base64,bm90LWFuLWltYWdl',sharp),/사진/);
});
test('audit summaries retain field names and transitions, never private raw content',()=>{
  const result=C.auditSummary({status:'접수',contact:'secret-number',photo:'private-photo',desc:'sensitive description'},{status:'완료',contact:''});
  assert.equal(result.after.status,'완료');assert.ok(result.changedFields.includes('contact'));
  assert.doesNotMatch(JSON.stringify(result),/secret-number|private-photo|sensitive description/);
});

test('status code is stable per report, secret-bound, and the public status names only the stage', () => {
  const a = C.statusCode('secret', 'qr-1'), b = C.statusCode('secret', 'qr-1');
  assert.equal(a, b); assert.match(a, /^[2-9A-HJ-NP-Z]{6}$/);
  assert.notEqual(C.statusCode('other', 'qr-1'), a); assert.notEqual(C.statusCode('secret', 'qr-2'), a);
  assert.ok(C.sameCode(a, b)); assert.ok(!C.sameCode(a, 'ABCDEF')); assert.ok(!C.sameCode(a, 'ABC'));
  assert.deepEqual(C.normalizeStatusQuery({ receipt: ' r261104-1a2b3c4d ', code: 'abc-def' }), { receipt: 'R261104-1A2B3C4D', code: 'ABCDEF' });
  assert.throws(() => C.normalizeStatusQuery({ receipt: 'R261104-1A2B3C4D', code: 'ABCDE0' }), /확인 코드/);
  assert.throws(() => C.normalizeStatusQuery({ receipt: '261104', code: 'ABCDEF' }), /접수번호/);
  assert.throws(() => C.normalizeStatusQuery({ receipt: 'R261104-1A2B3C4D', code: 'ABCDEF', extra: 1 }), /허용되지/);
  const citizen = { receipt: 'R261104-1A2B3C4D', at: Date.UTC(2026, 10, 3, 20), desc: '비밀', contact: '010', imported: false };
  assert.equal(C.publicStatus(citizen, null).stage, 'received'); assert.equal(C.publicStatus(citizen, null).updatedOn, '2026-11-04');
  const imported = { ...citizen, imported: true, importedAt: Date.UTC(2026, 10, 4) };
  assert.equal(C.publicStatus(imported, { status: '접수' }).stage, 'reviewing');
  assert.equal(C.publicStatus(imported, { status: '처리중', updatedAt: 1 }).stage, 'in-progress');
  assert.equal(C.publicStatus(imported, { status: '완료', note: '작업자 메모', contact: '010' }).stage, 'done');
  assert.equal(C.publicStatus(imported, null).stage, 'reviewing', 'a deleted staff report still shows it was seen');
  for (const out of [C.publicStatus(citizen, null), C.publicStatus(imported, { status: '완료', note: '작업자 메모' })]) assert.doesNotMatch(JSON.stringify(out), /비밀|010|메모/);
});
