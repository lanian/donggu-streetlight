// Run against a local Firestore emulator only. This file is intentionally outside *.test.cjs.
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  test('Firestore authorization tests', { skip: 'FIRESTORE_EMULATOR_HOST is required; no production connection is attempted.' }, () => {});
} else {
  const address = new URL('http://' + process.env.FIRESTORE_EMULATOR_HOST);
  assert.ok(['127.0.0.1', 'localhost', '[::1]', '::1'].includes(address.hostname), 'Use a local emulator host.');
  const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
  const { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, writeBatch, runTransaction } = require('firebase/firestore');
  const projectId = 'demo-donggu-streetlight';
  let env;
  const staff = () => env.authenticatedContext('inspector-a').firestore();
  const otherStaff = () => env.authenticatedContext('inspector-b').firestore();
  const admin = () => env.authenticatedContext('admin').firestore();
  const anonymous = () => env.unauthenticatedContext().firestore();
  const inspection = (extra = {}) => ({
    lightId: 'p1', code: '산수동 1', dong: '산수동', date: 1000,
    checks: { lamp: 'ok' }, faults: [], result: '정상', memo: '', inspector: 'inspector-a', ...extra
  });
  const photo = (extra = {}) => ({
    lightId: 'p1', code: '산수동 1', dong: '산수동', label: '전경', note: '',
    data: 'data:image/jpeg;base64,dGVzdA==', w: 100, h: 100, at: 1000, by: 'inspector-a', kind: 'inspection', ...extra
  });
  const fieldLight = (extra = {}) => ({
    code: '산수동 2', dong: '산수동', kind: '보안등', num: '2', road: null, main: null, sub: null,
    poleNo: null, address: '현장 등록', lampType: '', status: '정상', lastInspected: null,
    reg: '미등록', foundAt: 1000, foundBy: 'inspector-a', updatedAt: 1000, lat: 35.15, lng: 126.92, ...extra
  });
  const citizen = (extra = {}) => ({ issue: '불이 꺼져 있어요', desc: '', imported: false, at: 1000, ...extra });
  const lighting = (extra = {}) => ({ schemaVersion: 1, kind: 'source', label: '인접 공원 조명', category: 'other_public', operator: '다른 관리기관',
    lat: 35.15, lng: 126.92, radius: 20, strength: 'medium', status: 'on', level: 'unknown', schedule: 'hours',
    startMinute: 1080, endMinute: 360, observedAt: 1000, validDays: 90, nightConfirmed: true, lux: null, instrument: '',
    note: '', linkedLightId: '', distinct: true, removed: false, createdAt: 1000, createdBy: 'inspector-a',
    updatedAt: 1000, updatedBy: 'inspector-a', revision: 1, operationId: 'lighting-create', ...extra });
  function lightingWrite(client, recordId, record, receiptPatch = {}) {
    const receipt = { schemaVersion: 1, recordId, by: record.updatedBy, at: record.updatedAt, revision: record.revision, requestHash: 'a'.repeat(64), ...receiptPatch };
    const batch = writeBatch(client);
    batch.set(doc(client, 'lightingContext/' + recordId), record);
    batch.set(doc(client, 'lightingOperations/' + record.operationId), receipt);
    return batch.commit();
  }
  async function seed(records) {
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      const batch = writeBatch(db);
      for (const [key, value] of Object.entries(records)) batch.set(doc(db, key), value);
      await batch.commit();
    });
  }

  describe('Firestore role and evidence boundaries', () => {
    before(async () => {
      env = await initializeTestEnvironment({
        projectId,
        firestore: {
          host: address.hostname, port: Number(address.port || 8080),
          rules: fs.readFileSync(path.resolve(__dirname, '../../firestore.rules'), 'utf8')
        }
      });
    });
    beforeEach(async () => {
      await env.clearFirestore();
      await seed({
        'roles/admin': { role: 'admin' },
        'roles/inspector-a': { role: 'inspector' },
        'roles/inspector-b': { role: 'inspector' },
        'meta/setup': { by: 'admin', at: 1 }
      });
    });
    after(async () => { if (env) await env.cleanup(); });

    test('staff can create the first registry status patch, plate record and own location suggestion', async () => {
      const db = staff();
      await assertSucceeds(setDoc(doc(db, 'lights/p1'), { status: '고장', updatedAt: 1000 }));
      await assertSucceeds(updateDoc(doc(db, 'lights/p1'), { code: '산수동 1', plateFixed: true, plateFixedAt: 1000, num: '1' }));
      await assertSucceeds(updateDoc(doc(db, 'lights/p1'), { posSuggest: { lat: 35.15, lng: 126.92, by: 'inspector-a', at: 1000 } }));
      await assertFails(updateDoc(doc(db, 'lights/p1'), { posSuggest: { lat: 35.15, lng: 126.92, by: 'inspector-b' } }));
    });

    test('registry creation cannot bypass protected fields or bootstrap an approved registration', async () => {
      const db = staff();
      for (const extra of [{ lat: 35.15 }, { removed: true }, { lampType: 'LED' }, { edits: [] }, { reg: '대장반영' }]) {
        await assertFails(setDoc(doc(db, 'lights/p1'), { status: '정상', updatedAt: 1000, ...extra }));
      }
      await assertFails(setDoc(doc(db, 'lights/p2'), fieldLight()));
      await assertFails(setDoc(doc(db, 'lights/np-wrong-owner'), fieldLight({ foundBy: 'inspector-b' })));
    });

    test('field registration works in its namespace but later registry approval and metadata edits require admin', async () => {
      const db = staff();
      await assertSucceeds(setDoc(doc(db, 'lights/np-field-1'), fieldLight({ noPlate: true })));
      await assertFails(updateDoc(doc(db, 'lights/np-field-1'), { reg: '대장반영' }));
      await assertFails(updateDoc(doc(db, 'lights/np-field-1'), { lat: 35.16 }));
      await assertSucceeds(updateDoc(doc(admin(), 'lights/np-field-1'), { reg: '대장반영', lat: 35.16 }));
    });

    test('operational updates preserve admin metadata, including another inspector location suggestion', async () => {
      await seed({ 'lights/p1': {
        status: '정상', updatedAt: 1, lat: 35.15, removed: false, edits: [{ at: 1, by: 'admin' }],
        posSuggest: { lat: 35.16, lng: 126.92, by: 'inspector-b' }, redoNote: '다시 확인',
        photo: 'data:image/jpeg;base64,dGVzdA=='
      } });
      const db = staff();
      await assertSucceeds(updateDoc(doc(db, 'lights/p1'), { status: '고장', updatedAt: 1000, redoNote: null }));
      await assertFails(updateDoc(doc(db, 'lights/p1'), { lat: 35.18 }));
      await assertFails(updateDoc(doc(db, 'lights/p1'), { removed: true }));
      await assertFails(updateDoc(doc(db, 'lights/p1'), { edits: [] }));
      await assertFails(setDoc(doc(db, 'lights/p1'), { status: '정상', updatedAt: 2000 }));
      await assertFails(deleteDoc(doc(db, 'lights/p1')));
      await assertSucceeds(updateDoc(doc(admin(), 'lights/p1'), { posSuggest: null }));
      await assertSucceeds(updateDoc(doc(db, 'lights/p1'), { status: '수리중', updatedAt: 2000 }));
    });

    test('inspection creation requires its author and cannot carry review or redo authority', async () => {
      const db = staff();
      await assertSucceeds(setDoc(doc(db, 'inspections/valid'), inspection()));
      await assertSucceeds(setDoc(doc(db, 'inspections/patrol'), inspection({ patrol: true })));
      await assertFails(setDoc(doc(db, 'inspections/other-author'), inspection({ inspector: 'inspector-b' })));
      for (const extra of [{ reviewedAt: 1 }, { reviewedBy: 'admin' }, { redo: false }, { redoBy: 'admin' }, { redoNote: '' }, { redoAt: 1 }]) {
        await assertFails(setDoc(doc(db, 'inspections/forged'), inspection(extra)));
      }
    });

    test('inspection retries are idempotent and cannot replace saved or reviewed evidence', async () => {
      const db = staff(), ref = doc(db, 'inspections/saved');
      const record = inspection();
      await assertSucceeds(setDoc(ref, record));
      await assertSucceeds(setDoc(ref, record));
      await assertFails(updateDoc(ref, { result: '고장' }));
      await assertFails(updateDoc(doc(otherStaff(), 'inspections/saved'), { memo: '바꿈' }));
      await assertSucceeds(updateDoc(doc(admin(), 'inspections/saved'), { reviewedAt: 2000, reviewedBy: 'admin', redo: true }));
      // Merge retries retain review fields that were added after the original commit.
      await assertSucceeds(setDoc(ref, record, { merge: true }));
      await assertFails(setDoc(ref, record));
      await assertFails(updateDoc(ref, { result: '고장', checks: { lamp: 'bad' } }));
      await assertFails(updateDoc(ref, { reviewedBy: 'inspector-a' }));
      await assertFails(updateDoc(ref, { redo: false }));
      const saved = await getDoc(ref);
      assert.equal(saved.data().reviewedAt, 2000);
      assert.equal(saved.data().result, '정상');
    });

    test('six evidence photos, inspection and first light patch can commit in one batch', async () => {
      const db = staff(), batch = writeBatch(db);
      const thumbs = [];
      for (let index = 0; index < 6; index++) {
        const id = 'batch-photo-' + index;
        thumbs.push({ id, label: '전경', t: 'data:image/jpeg;base64,dGVzdA==' });
        batch.set(doc(db, 'photos/' + id), photo({ inspId: 'batch-inspection' }));
      }
      batch.set(doc(db, 'inspections/batch-inspection'), inspection({ thumbs, photoN: 6 }));
      batch.set(doc(db, 'lights/p1'), { status: '정상', lastInspected: 1000, lastResult: '정상', redoNote: null, updatedAt: 1000 });
      await assertSucceeds(batch.commit());
      await assertSucceeds(updateDoc(doc(admin(),'inspections/batch-inspection'),{reviewedBy:'admin',reviewedAt:2000}));
      const retry=writeBatch(db);
      for(let index=0;index<6;index++)retry.set(doc(db,'photos/batch-photo-'+index),photo({inspId:'batch-inspection'}),{merge:true});
      retry.set(doc(db,'inspections/batch-inspection'),inspection({thumbs,photoN:6}),{merge:true});
      await assertSucceeds(retry.commit());
    });

    test('photo author cannot replace evidence and legacy initial inspection linking remains available', async () => {
      const db = staff(), ref = doc(db, 'photos/legacy');
      await assertSucceeds(setDoc(doc(db, 'inspections/photo-owner'), inspection()));
      await assertSucceeds(setDoc(ref, photo()));
      await assertFails(setDoc(doc(db, 'photos/forged-owner'), photo({ by: 'inspector-b' })));
      await assertFails(updateDoc(doc(otherStaff(), 'photos/legacy'), { inspId: 'photo-owner' }));
      await assertFails(updateDoc(ref, { data: 'changed' }));
      await assertSucceeds(updateDoc(ref, { inspId: 'photo-owner' }));
      await assertSucceeds(setDoc(ref, photo({ inspId: 'photo-owner' })));
      await assertFails(updateDoc(ref, { inspId: 'another-inspection' }));
      await assertSucceeds(setDoc(doc(db, 'photos/representative'), photo({ kind: 'rep' })));
    });

    test('photo linking cannot target another author, another light or a reviewed inspection', async () => {
      await seed({
        'inspections/other-author': inspection({ inspector: 'inspector-b' }),
        'inspections/other-light': inspection({ lightId: 'p2' }),
        'inspections/reviewed': inspection({ reviewedAt: 2000, reviewedBy: 'admin' })
      });
      const db = staff();
      await assertSucceeds(setDoc(doc(db, 'photos/unlinked'), photo()));
      for (const inspId of ['other-author', 'other-light', 'reviewed', 'missing']) {
        await assertFails(updateDoc(doc(db, 'photos/unlinked'), { inspId }));
        await assertFails(setDoc(doc(db, 'photos/invalid-link'), photo({ inspId })));
      }
    });

    test('anonymous direct reports are blocked so gateway validation cannot be bypassed', async () => {
      const db=anonymous();
      await assertFails(setDoc(doc(db,'citizen_reports/direct'),citizen({lightId:'p1'})));
      await seed({'citizen_reports/received':citizen({contact:'01012345678',consent:true})});
      await assertFails(getDoc(doc(db,'citizen_reports/received')));
      await assertFails(updateDoc(doc(db,'citizen_reports/received'),{imported:true}));
    });

    test('bootstrap is never open to arbitrary login accounts, even before setup exists', async()=>{
      await env.clearFirestore();
      for(const uid of ['first','racer'])await assertFails(setDoc(doc(env.authenticatedContext(uid).firestore(),'roles/'+uid),{role:'admin'}));
      await assertFails(setDoc(doc(env.authenticatedContext('first').firestore(),'meta/setup'),{by:'first'}));
    });

    test('staff cannot mutate or hide raw reports, but atomic import clears PII and links the real report',async()=>{
      await seed({'citizen_reports/raw':citizen({contact:'01012345678',consent:true,photo:'data:image/jpeg;base64,dGVzdA=='})});
      const db=staff(),raw=doc(db,'citizen_reports/raw');
      await assertFails(updateDoc(raw,{desc:'changed'}));
      await assertFails(deleteDoc(raw));
      await assertFails(updateDoc(raw,{imported:true,importedAt:2000,importedBy:'inspector-a',reportId:'missing',contact:deleteField(),photo:deleteField()}));
      const copied={ext:'raw',issue:'불이 꺼져 있어요',desc:'',contact:'01012345678',photo:'data:image/jpeg;base64,dGVzdA==',status:'접수'};
      const fake=writeBatch(db);fake.set(doc(db,'reports/forged'),{...copied,desc:'changed'});fake.update(raw,{imported:true,importedAt:2000,importedBy:'inspector-a',reportId:'forged',contact:deleteField(),photo:deleteField()});await assertFails(fake.commit());
      const batch=writeBatch(db);batch.set(doc(db,'reports/imported'),copied);batch.update(raw,{imported:true,importedAt:2000,importedBy:'inspector-a',reportId:'imported',contact:deleteField(),photo:deleteField()});await assertSucceeds(batch.commit());
      assert.equal((await getDoc(raw)).data().contact,undefined);
    });

    test('inspection types and all evidence references are validated before creation and review',async()=>{
      const db=staff();
      for(const thumbs of ['broken',[null],[{id:'missing',label:'전경',t:'data:image/jpeg;base64,dGVzdA=='}]])await assertFails(setDoc(doc(db,'inspections/malformed'),inspection({thumbs})));
      // Existing legacy broken links cannot be approved; no late-bound unlinked photo can help.
      await seed({'inspections/legacy-link':inspection({thumbs:[{id:'later',t:'data:image/jpeg;base64,dGVzdA=='}]})});
      await assertFails(updateDoc(doc(admin(),'inspections/legacy-link'),{reviewedBy:'admin',reviewedAt:2000}));
      await assertSucceeds(setDoc(doc(db,'photos/later'),photo({kind:'rep'})));
      await assertFails(updateDoc(doc(admin(),'inspections/legacy-link'),{reviewedBy:'admin',reviewedAt:2000}));
      await assertSucceeds(updateDoc(doc(db,'photos/later'),{inspId:'legacy-link'}));
      await assertSucceeds(updateDoc(doc(admin(),'inspections/legacy-link'),{reviewedBy:'admin',reviewedAt:2000}));
    });

    test('inspection timestamps never go backwards except an explicit new admin restore',async()=>{
      await seed({'lights/p1':{status:'고장',lastInspected:2000}});
      for(const db of [staff(),admin()])await assertFails(updateDoc(doc(db,'lights/p1'),{status:'정상',lastInspected:1000}));
      await assertSucceeds(updateDoc(doc(admin(),'lights/p1'),{status:'정상',lastInspected:1000,restoredAt:3000,restoredBy:'admin'}));
      await assertFails(updateDoc(doc(admin(),'lights/p1'),{lastInspected:500,restoredAt:3000,restoredBy:'admin'}));
    });

    test('join requests belong to the user and only an admin can approve with a staff role',async()=>{
      const outsider=env.authenticatedContext('joiner',{email:'joiner@example.invalid'}).firestore();
      await assertSucceeds(setDoc(doc(outsider,'joinRequests/joiner'),{uid:'joiner',email:'joiner@example.invalid',name:'신청자',message:'현장 업무',status:'pending',createdAt:1000,updatedAt:1000}));
      await assertFails(updateDoc(doc(outsider,'joinRequests/joiner'),{status:'approved'}));
      await assertFails(updateDoc(doc(staff(),'joinRequests/joiner'),{status:'approved'}));
      const db=admin(),batch=writeBatch(db);batch.set(doc(db,'roles/joiner'),{role:'inspector'});batch.update(doc(db,'joinRequests/joiner'),{status:'approved',reviewedBy:'admin',reviewedAt:2000,updatedAt:2000});await assertSucceeds(batch.commit());
      for(const db of [outsider,staff(),admin()])await assertFails(setDoc(doc(db,'auditEvents/fake'),{by:'admin',action:'fake'}));
    });

    test('work orders enforce assignment, immutable identity, evidence and admin verification',async()=>{
      const manager=admin(),db=staff();
      const work={schemaVersion:1,lightId:'p1',code:'산수동 1',dong:'산수동',title:'수리',description:'',type:'수리',priority:'보통',status:'assigned',assignedTo:'inspector-a',dueAt:0,createdAt:1000,createdBy:'admin',updatedAt:1000,updatedBy:'admin',revision:1,reportIds:[],inspectionIds:[],beforePhotos:[],afterPhotos:[],completionNote:'',verificationNote:'',parts:[],costTotal:0,measurements:[],stockApplied:{}};
      await assertSucceeds(setDoc(doc(manager,'workOrders/work'),work));
      await assertFails(updateDoc(doc(otherStaff(),'workOrders/work'),{status:'in_progress',revision:2,updatedAt:2000,updatedBy:'inspector-b'}));
      await assertSucceeds(updateDoc(doc(db,'workOrders/work'),{status:'in_progress',revision:2,updatedAt:2000,updatedBy:'inspector-a'}));
      await assertFails(updateDoc(doc(db,'workOrders/work'),{revision:3,stockApplied:{item:1}}));
      await assertFails(updateDoc(doc(manager,'workOrders/work'),{revision:3,updatedBy:'admin',stockApplied:{item:1}}));
      await assertFails(updateDoc(doc(db,'workOrders/work'),{lightId:'p2',revision:3,updatedAt:3000}));
      await assertFails(updateDoc(doc(db,'workOrders/work'),{status:'completed',revision:3,updatedAt:3000,completedBy:'inspector-a',completedAt:3000}));
      const batch=writeBatch(db);batch.set(doc(db,'photos/work-after'),photo({kind:'work',workId:'work'}));batch.update(doc(db,'workOrders/work'),{status:'completed',revision:3,updatedAt:3000,completedBy:'inspector-a',completedAt:3000,afterPhotos:['work-after']});batch.set(doc(db,'workEvents/complete'),{workId:'work',lightId:'p1',fromStatus:'in_progress',toStatus:'completed',type:'complete',note:'수리 완료',at:3000,by:'inspector-a',revision:3});await assertSucceeds(batch.commit());
      await assertFails(updateDoc(doc(db,'workOrders/work'),{status:'verified',revision:4,updatedAt:4000,verifiedBy:'inspector-a',verifiedAt:4000}));
      await assertSucceeds(updateDoc(doc(manager,'workOrders/work'),{status:'verified',revision:4,updatedAt:4000,updatedBy:'admin',verifiedBy:'admin',verifiedAt:4000}));
      await assertFails(updateDoc(doc(manager,'workEvents/complete'),{note:'rewritten'}));
    });

    test('maximum supported work verification atomically handles 12 evidence photos, 10 inventory items and 20 reports',async()=>{
      const manager=admin(),db=staff(),workId='large-work';
      const beforePhotos=Array.from({length:6},(_,i)=>'before-'+i),afterPhotos=Array.from({length:6},(_,i)=>'after-'+i);
      const reportIds=Array.from({length:20},(_,i)=>'report-'+i),itemIds=Array.from({length:10},(_,i)=>'item-'+i);
      const work={schemaVersion:1,lightId:'p1',code:'산수동 1',dong:'산수동',title:'여러 자재 수리',description:'',type:'수리',priority:'보통',status:'assigned',assignedTo:'inspector-a',dueAt:0,createdAt:1000,createdBy:'admin',updatedAt:1000,updatedBy:'admin',revision:1,reportIds,inspectionIds:[],beforePhotos,afterPhotos:[],completionNote:'',verificationNote:'',parts:itemIds.map(inventoryId=>({name:inventoryId,qty:1,unitCost:100,inventoryId})),costTotal:1000,accountedCost:0,measurements:[],stockApplied:{}};
      await seed(Object.fromEntries([
        ['lights/p1',{status:'고장',lastInspected:1000,updatedAt:1000}],
        ...reportIds.map(id=>['reports/'+id,{lightId:'p1',status:'접수',contact:'private'}]),
        ...itemIds.map(id=>['inventory/'+id,{name:id,unit:'개',quantity:20,unitCost:100,revision:1,updatedAt:1000,updatedBy:'admin'}])
      ]));
      const create=writeBatch(manager);create.set(doc(manager,'workOrders/'+workId),work);
      for(const id of beforePhotos)create.set(doc(manager,'photos/'+id),photo({kind:'work',workId,by:'admin'}));
      create.set(doc(manager,'workEvents/large-create'),{workId,lightId:'p1',fromStatus:'',toStatus:'assigned',type:'created',note:'',at:1000,by:'admin',revision:1,createdAt:1000,costTotal:1000,costDelta:0});await assertSucceeds(create.commit());
      await assertSucceeds(updateDoc(doc(db,'workOrders/'+workId),{status:'in_progress',revision:2,updatedAt:2000,updatedBy:'inspector-a'}));
      const complete=writeBatch(db);
      for(const id of afterPhotos)complete.set(doc(db,'photos/'+id),photo({kind:'work',workId}));
      complete.update(doc(db,'workOrders/'+workId),{status:'completed',revision:3,updatedAt:3000,completedBy:'inspector-a',completedAt:3000,afterPhotos});
      complete.set(doc(db,'workEvents/large-complete'),{workId,lightId:'p1',fromStatus:'in_progress',toStatus:'completed',type:'transition',note:'',at:3000,by:'inspector-a',revision:3,createdAt:1000,costTotal:1000,costDelta:0});await assertSucceeds(complete.commit());
      await assertSucceeds(runTransaction(manager,async transaction=>{
        const paths=['workOrders/'+workId,'workEvents/large-verify','lights/p1',...beforePhotos.concat(afterPhotos).map(id=>'photos/'+id),...itemIds.map(id=>'inventory/'+id),...reportIds.map(id=>'reports/'+id)];
        const records=new Map();for(const key of paths)records.set(key,(await transaction.get(doc(manager,key))).data());
        assert.equal(records.get('workEvents/large-verify'),undefined);
        for(const id of beforePhotos.concat(afterPhotos))assert.equal(records.get('photos/'+id).workId,workId);
        for(const id of itemIds){transaction.update(doc(manager,'inventory/'+id),{quantity:19,revision:2,updatedAt:4000,updatedBy:'admin'});transaction.set(doc(manager,'inventoryMoves/large-verify-'+id),{itemId:id,delta:-1,reason:'작업 검수',at:4000,by:'admin',revision:2,workId});}
        for(const id of reportIds)transaction.update(doc(manager,'reports/'+id),{status:'완료',contact:'',resolvedAt:4000,resolvedBy:'admin',workId});
        transaction.update(doc(manager,'lights/p1'),{status:'정상',updatedAt:4000,lastRepairedAt:4000,lastWorkId:workId});
        transaction.update(doc(manager,'workOrders/'+workId),{status:'verified',revision:4,updatedAt:4000,updatedBy:'admin',verifiedBy:'admin',verifiedAt:4000,accountedCost:1000,stockApplied:Object.fromEntries(itemIds.map(id=>[id,1]))});
        transaction.set(doc(manager,'workEvents/large-verify'),{workId,lightId:'p1',fromStatus:'completed',toStatus:'verified',type:'transition',note:'',at:4000,by:'admin',revision:4,createdAt:1000,costTotal:1000,costDelta:1000});
      }));
      assert.equal((await getDoc(doc(manager,'inventory/item-9'))).data().quantity,19);
      assert.equal((await getDoc(doc(manager,'reports/report-19'))).data().status,'완료');
    });

    test('accounted costs change only at admin verification and event snapshots preserve exact historical deltas',async()=>{
      const manager=admin(),db=staff(),workId='cost-work';
      const work={schemaVersion:1,lightId:'p1',code:'산수동 1',dong:'산수동',title:'수리',description:'',type:'수리',priority:'보통',status:'completed',assignedTo:'inspector-a',dueAt:0,createdAt:1000,createdBy:'admin',updatedAt:3000,updatedBy:'inspector-a',revision:3,reportIds:[],inspectionIds:[],beforePhotos:[],afterPhotos:['cost-photo'],completionNote:'완료',completedAt:3000,completedBy:'inspector-a',verificationNote:'',parts:[],costTotal:100,accountedCost:0,measurements:[],stockApplied:{}};
      await seed({'workOrders/cost-work':work,'photos/cost-photo':photo({kind:'work',workId})});
      await assertFails(updateDoc(doc(db,'workOrders/'+workId),{accountedCost:100,revision:4}));
      await assertFails(updateDoc(doc(manager,'workOrders/'+workId),{accountedCost:100,revision:4,updatedBy:'admin'}));
      function change(actor,id,old,target,patch={},eventPatch={}){
        const client=actor==='admin'?manager:db,revision=old.revision+1,at=revision*1000;
        const next={...old,...patch,status:target,revision,updatedAt:at,updatedBy:actor};
        if(target==='verified'){next.verifiedBy=actor;next.verifiedAt=at;}
        if(target==='completed'){next.completedBy=actor;next.completedAt=at;}
        const event={workId,lightId:'p1',fromStatus:old.status,toStatus:target,type:'transition',note:'',at,by:actor,revision,createdAt:1000,costTotal:next.costTotal,costDelta:target==='verified'?next.costTotal-(old.accountedCost||0):0,...eventPatch};
        const batch=writeBatch(client);batch.set(doc(client,'workOrders/'+workId),next);batch.set(doc(client,'workEvents/'+id),event);
        return {next,event,commit:()=>batch.commit()};
      }
      await assertFails(change('admin','wrong-account',work,'verified',{accountedCost:99}).commit());
      for(const invalid of [{createdAt:999},{costTotal:101},{costDelta:99},{costDelta:'100'},{fromStatus:'assigned'}])await assertFails(change('admin','invalid-event',work,'verified',{accountedCost:100},invalid).commit());
      const first=change('admin','first-verify',work,'verified',{accountedCost:100});await assertSucceeds(first.commit());
      for(const client of [manager,db])await assertFails(setDoc(doc(client,'workEvents/duplicate'),{...first.event,by:client===manager?'admin':'inspector-a',costDelta:0}));
      await assertFails(change('admin','erase-accounted-cost',first.next,'assigned',{accountedCost:0}).commit());
      const reopen=change('admin','reopen',first.next,'assigned');await assertSucceeds(reopen.commit());
      await assertFails(change('inspector-a','forged-start',reopen.next,'in_progress',{}, {costDelta:1}).commit());
      const start=change('inspector-a','start',reopen.next,'in_progress');await assertSucceeds(start.commit());
      await assertFails(change('inspector-a','forged-completion',start.next,'completed',{costTotal:60,accountedCost:60}).commit());
      const done=change('inspector-a','complete-again',start.next,'completed',{costTotal:60});await assertSucceeds(done.commit());
      const second=change('admin','second-verify',done.next,'verified',{accountedCost:60});await assertSucceeds(second.commit());
      assert.equal((await getDoc(doc(manager,'workEvents/first-verify'))).data().costTotal,100);
      assert.equal((await getDoc(doc(manager,'workEvents/second-verify'))).data().costDelta,-40);
      assert.equal((await getDoc(doc(manager,'workOrders/'+workId))).data().accountedCost,60);
    });

    test('operations retention settings and inventory revisions are bounded and admin-only',async()=>{
      const value={schemaVersion:1,inspectionDays:180,privacyDays:3650,updatedAt:1000,updatedBy:'admin'};
      await assertSucceeds(setDoc(doc(admin(),'settings/operations'),value));
      await assertFails(updateDoc(doc(staff(),'settings/operations'),{privacyDays:1,updatedBy:'inspector-a'}));
      await assertFails(updateDoc(doc(admin(),'settings/operations'),{privacyDays:3651}));
      const stock={name:'전구',unit:'개',quantity:3,unitCost:10,revision:1,updatedAt:1000,updatedBy:'admin'};
      await assertSucceeds(setDoc(doc(admin(),'inventory/item'),stock));
      await assertFails(updateDoc(doc(admin(),'inventory/item'),{quantity:2}));
      await assertSucceeds(updateDoc(doc(admin(),'inventory/item'),{quantity:2,revision:2}));
    });

    test('lighting context and operation receipts are visible only to staff and require an atomic pair', async () => {
      const db = staff(), record = lighting();
      await assertFails(setDoc(doc(db, 'lightingContext/external'), record));
      await assertFails(setDoc(doc(admin(), 'lightingContext/external'), lighting({ createdBy: 'admin', updatedBy: 'admin' })));
      await assertSucceeds(lightingWrite(db, 'external', record));
      await assertSucceeds(getDoc(doc(otherStaff(), 'lightingContext/external')));
      for (const client of [anonymous(), env.authenticatedContext('outsider').firestore(), env.authenticatedContext('anonymous-user', { firebase: { sign_in_provider: 'anonymous' } }).firestore()]) {
        await assertFails(getDoc(doc(client, 'lightingContext/external')));
        await assertFails(getDoc(doc(client, 'lightingOperations/lighting-create')));
        await assertFails(lightingWrite(client, 'new-record', lighting({ operationId: 'outsider-create' })));
      }
      for (const client of [db, admin()]) await assertFails(deleteDoc(doc(client, 'lightingContext/external')));
    });

    test('lighting edits require ownership or admin while preserving creation metadata and strict revisions', async () => {
      await assertSucceeds(lightingWrite(staff(), 'external', lighting()));
      const edited = lighting({ operationId: 'lighting-edit', updatedAt: 2000, revision: 2, label: '확인한 명칭' });
      await assertFails(lightingWrite(otherStaff(), 'external', { ...edited, updatedBy: 'inspector-b' }));
      await assertFails(lightingWrite(staff(), 'external', { ...edited, revision: 3 }));
      await assertFails(lightingWrite(staff(), 'external', { ...edited, createdBy: 'inspector-b' }));
      await assertFails(lightingWrite(admin(), 'external', { ...edited, updatedBy: 'admin', createdBy: 'admin' }));
      await assertFails(lightingWrite(admin(), 'external', { ...edited, updatedBy: 'admin', createdAt: 500 }));
      await assertSucceeds(lightingWrite(admin(), 'external', { ...edited, updatedBy: 'admin' }));
      const removed = { ...edited, operationId: 'lighting-remove', updatedAt: 3000, revision: 3, removed: true };
      await assertSucceeds(lightingWrite(staff(), 'external', removed));
      assert.equal((await getDoc(doc(staff(), 'lightingContext/external'))).data().removed, true);
      // Even byte-identical direct overwrites must not bypass the receipt/revision protocol.
      await assertFails(setDoc(doc(staff(), 'lightingContext/external'), removed));
    });

    test('lighting schema bounds reject invalid coordinates, unchecked lux, future times and malformed schedules', async () => {
      const invalid = [{ label: '' }, { category: 'not-a-category' }, { lat: NaN }, { lng: 181 }, { radius: 81 },
        { kind: 'observation', radius: 31 }, { validDays: 0 }, { validDays: 366 }, { validDays: 1.5 },
        { schedule: 'hours', startMinute: 0, endMinute: 0 }, { startMinute: 1440 }, { nightConfirmed: 'yes' },
        { lux: 0, instrument: '' }, { lux: -1, instrument: '조도계' }, { lux: 200001, instrument: '조도계' },
        { observedAt: 301001 }, { observedAt: Date.now() + 600000 }, { updatedAt: Date.now() + 600000 },
        { note: 'x'.repeat(1001) }, { removed: true }, { unknownField: true }];
      for (let i = 0; i < invalid.length; i++) await assertFails(lightingWrite(staff(), 'invalid-' + i, lighting({ ...invalid[i], operationId: 'invalid-operation-' + i })));
      const zero = lighting({ kind: 'observation', category: 'field', lux: 0, instrument: '조도계', validDays: 30, operationId: 'zero-lux' });
      await assertSucceeds(lightingWrite(staff(), 'measured-zero', zero));
      await assertSucceeds(lightingWrite(staff(), 'unknown-hours', lighting({ schedule: 'unknown', startMinute: 0, endMinute: 0, operationId: 'unknown-hours' })));
      for (const id of ['prototype', 'constructor']) await assertFails(lightingWrite(staff(), id, lighting({ operationId: 'reserved-' + id })));
    });

    test('lighting receipts cannot be detached, forged, edited, deleted or reused for another revision', async () => {
      const db = staff(), record = lighting();
      const receipt = { schemaVersion: 1, recordId: 'external', by: 'inspector-a', at: 1000, revision: 1, requestHash: 'a'.repeat(64) };
      await assertFails(setDoc(doc(db, 'lightingOperations/detached'), receipt));
      for (const invalid of [{ by: 'inspector-b' }, { revision: 2 }, { at: 999 }, { recordId: 'different' }, { requestHash: 'not-a-hash' }, { extra: true }]) await assertFails(lightingWrite(db, 'external', record, invalid));
      await assertSucceeds(lightingWrite(db, 'external', record));
      for (const client of [db, admin()]) {
        await assertFails(updateDoc(doc(client, 'lightingOperations/lighting-create'), { requestHash: 'b'.repeat(64) }));
        await assertFails(deleteDoc(doc(client, 'lightingOperations/lighting-create')));
      }
      await assertFails(lightingWrite(db, 'external', { ...record, revision: 2, updatedAt: 2000 }));
      await assertFails(setDoc(doc(db, 'lightingOperations/detached'), { ...receipt, revision: 2 }));
    });

    test('actual lighting transactions deduplicate concurrent submissions and old retries after newer edits', async () => {
      const commands = require('../../app/lighting-commands.js'), client = staff();
      const adapter = { doc: key => doc(client, key), runTransaction: fn => runTransaction(client, fn) };
      const context = { db: adapter, fb: adapter, user: 'inspector-a', admin: false };
      const raw = lighting();
      const first = { id: 'actual-create', recordId: 'actual-record', actor: 'inspector-a', at: 1000, expectedRevision: 0, data: raw };
      const results = await Promise.all([commands.execute(first, context), commands.execute(first, context)]);
      assert.equal(results.filter(result => result.alreadyApplied).length, 1);
      const edited = { ...first, id: 'actual-edit', at: 2000, expectedRevision: 1, data: { ...raw, status: 'off' } };
      await commands.execute(edited, context);
      await commands.execute({ ...edited, id: 'actual-remove', at: 3000, expectedRevision: 2, data: { ...edited.data, removed: true } }, context);
      assert.equal((await commands.execute(first, context)).alreadyApplied, true);
      assert.equal((await commands.execute(edited, context)).alreadyApplied, true);
      const latest = (await getDoc(doc(client, 'lightingContext/actual-record'))).data();
      assert.equal(latest.removed, true); assert.equal(latest.status, 'off'); assert.equal(latest.revision, 3);
      await assert.rejects(commands.execute({ ...edited, data: { ...raw, label: '다른 요청' } }, context), { code: 'conflict' });
      await assert.rejects(commands.execute({ ...edited, id: 'stale-update' }, context), { code: 'conflict' });
    });

    test('users without staff roles cannot read or write staff records or self-assign a role after setup', async () => {
      const outsider = env.authenticatedContext('outsider').firestore();
      await seed({ 'lights/p1': { status: '정상', updatedAt: 1 } });
      await assertFails(getDoc(doc(outsider, 'lights/p1')));
      await assertFails(setDoc(doc(outsider, 'lights/p2'), { status: '고장', updatedAt: 1 }));
      await assertFails(setDoc(doc(outsider, 'roles/outsider'), { role: 'admin' }));
      await assertFails(setDoc(doc(staff(), 'roles/inspector-a'), { role: 'admin' }));
    });

    test('server-owned restore receipts and health cannot be forged by client administrators',async()=>{
      await assertFails(setDoc(doc(admin(),'restoreOperations/forged'),{status:'applied',by:'admin'}));
      await assertFails(setDoc(doc(admin(),'systemHealth/retention'),{lastSuccessAt:Date.now()}));
      await seed({'restoreOperations/server':{status:'applied',by:'admin'},'systemHealth/retention':{lastSuccessAt:1}});
      await assertSucceeds(getDoc(doc(admin(),'restoreOperations/server')));
      await assertFails(getDoc(doc(staff(),'restoreOperations/server')));
      await assertFails(getDoc(doc(staff(),'systemHealth/retention')));
      await seed({'meta/operationalRestore':{status:'partial',operationId:'bulk'}});
      await assertFails(setDoc(doc(admin(),'inventory/during-restore'),{name:'램프',unit:'개',quantity:1,unitCost:1,revision:1,updatedAt:1,updatedBy:'admin'}));
    });
    test('imported external sources require admin and unconfirmed initial lighting conditions',async()=>{
      const source=lighting({sourceAgency:'타 기관',sourceRecordId:'lamp-1',sourceDataset:'공개 대장',sourceUpdatedAt:0,importedAt:1000,importBatchId:'import-1',status:'unknown',schedule:'unknown',nightConfirmed:false,level:'unknown',lux:null,distinct:false,linkedLightId:''});
      await assertFails(lightingWrite(staff(),'external-1',source));
      const imported={...source,createdBy:'admin',updatedBy:'admin',operationId:'import-admin'};
      await assertFails(lightingWrite(admin(),'external-lit',{...imported,status:'on',nightConfirmed:true}));
      await assertSucceeds(lightingWrite(admin(),'external-1',imported));
    });
    function workflowWrite(client,entity,id,record){const batch=writeBatch(client);batch.set(doc(client,(entity==='task'?'lightingTasks/':'lightingRuns/')+id),record);batch.set(doc(client,'lightingWorkflowOperations/'+record.operationId),{schemaVersion:1,entity,recordId:id,by:record.updatedBy,at:record.updatedAt,revision:record.revision,requestHash:'b'.repeat(64)});return batch.commit();}
    test('lighting tasks enforce assignment, bounded evidence and immutable completion receipts',async()=>{
      const now=Date.now(),task={schemaVersion:1,title:'밝기 재확인',lat:35.15,lng:126.92,radius:20,note:'',originKind:'manual',originId:'',evidenceIds:[],assignedTo:'inspector-a',dueAt:now+86400000,reviewMinute:1260,status:'open',observationId:'',completionNote:'',completedAt:0,completedBy:'',createdAt:now,createdBy:'inspector-a',updatedAt:now,updatedBy:'inspector-a',revision:1,operationId:'task-create'};
      await assertFails(workflowWrite(staff(),'task','other-task',{...task,assignedTo:'inspector-b'}));
      await assertSucceeds(workflowWrite(staff(),'task','task',task));
      const completed={...task,status:'completed',observationId:'observed',completionNote:'확인',completedAt:now+1000,completedBy:'inspector-a',updatedAt:now+1000,revision:2,operationId:'task-complete'};
      await assertFails(workflowWrite(staff(),'task','task',completed));
      await seed({'lightingContext/observed':lighting({kind:'observation',level:'dark',observedAt:now,schedule:'always',nightConfirmed:true,removed:false})});
      await assertFails(workflowWrite(otherStaff(),'task','task',{...completed,completedBy:'inspector-b',updatedBy:'inspector-b'}));
      await assertSucceeds(workflowWrite(staff(),'task','task',completed));
      await assertFails(workflowWrite(staff(),'task','task',{...task,revision:3,updatedAt:now+2000,operationId:'task-reopen'}));
      await assertSucceeds(workflowWrite(admin(),'task','task',{...task,revision:3,updatedAt:now+2000,updatedBy:'admin',operationId:'task-reopen-admin'}));
      await assertFails(deleteDoc(doc(admin(),'lightingTasks/task')));
      await assertFails(updateDoc(doc(admin(),'lightingWorkflowOperations/task-complete'),{at:123}));
    });
    test('saved lighting runs are bounded, receipt-backed and immutable',async()=>{
      const now=Date.now(),run={schemaVersion:1,modelVersion:'test-v1',reviewedAt:now,minute:1260,mode:'pairs',dong:'전체',facilityKind:'전체',registryCount:2,contextCount:0,roadCount:0,candidateCount:0,inputDigest:'a'.repeat(64),inputVersionsJson:'[]',settingsJson:'{}',candidatesJson:'[]',evaluationJson:'{}',payloadBytes:400,createdAt:now,createdBy:'inspector-a',updatedAt:now,updatedBy:'inspector-a',revision:1,operationId:'run-create'};
      await assertFails(setDoc(doc(staff(),'lightingRuns/run'),run));
      await assertSucceeds(workflowWrite(staff(),'run','run',run));
      await assertFails(updateDoc(doc(admin(),'lightingRuns/run'),{candidateCount:999}));
      await assertFails(workflowWrite(staff(),'run','large',{...run,payloadBytes:600001,operationId:'run-large'}));
    });
    test('report facility relinking preserves receipt, needs admin and writes its immutable event atomically',async()=>{
      await seed({'reports/relink':{lightId:null,code:'',dong:'',createdAt:1000,status:'접수',desc:'원문 유지',receipt:'R-original'}});
      const event={schemaVersion:1,type:'facility-linked',reportId:'relink',fromLightId:'',toLightId:'p1',reason:'표찰 확인',by:'admin',at:2000,revision:1,requestHash:'c'.repeat(64)};
      const patch={lightId:'p1',code:'산수동 1',dong:'산수동',linkRevision:1,linkEventId:'link-command',linkUpdatedBy:'admin',updatedAt:2000,workId:''};
      await assertFails(updateDoc(doc(admin(),'reports/relink'),patch));
      const manager=admin(),batch=writeBatch(manager);batch.update(doc(manager,'reports/relink'),patch);batch.set(doc(manager,'reportEvents/link-command'),event);await assertSucceeds(batch.commit());
      assert.equal((await getDoc(doc(admin(),'reports/relink'))).data().receipt,'R-original');
      await assertFails(updateDoc(doc(admin(),'reportEvents/link-command'),{reason:'변경'}));
      await assertFails(updateDoc(doc(staff(),'reports/relink'),{lightId:'p2'}));
    });

    test('admin can attach a report to a completed work without replacing its original completer',async()=>{
      const C=require('../../app/operations-core'),manager=admin(),work={...C.createOrder({title:'검수 대기',assignedTo:'inspector-a'}, {id:'p1',code:'산수동 1',dong:'산수동'},'admin',1000),status:'completed',revision:3,updatedAt:3000,updatedBy:'inspector-a',afterPhotos:['waiting-photo'],completedAt:3000,completedBy:'inspector-a',completionNote:'수리'};
      await seed({'workOrders/waiting':work,'photos/waiting-photo':photo({workId:'waiting',kind:'work'}),'reports/waiting-report':{createdAt:1000,status:'접수',lightId:'p1'}});
      const batch=writeBatch(manager);batch.update(doc(manager,'workOrders/waiting'),{reportIds:['waiting-report'],revision:4,updatedAt:4000,updatedBy:'admin'});batch.update(doc(manager,'reports/waiting-report'),{workId:'waiting',updatedAt:4000});batch.set(doc(manager,'workEvents/link-waiting'),{workId:'waiting',lightId:'p1',fromStatus:'completed',toStatus:'completed',type:'reports-linked',note:'',at:4000,by:'admin',revision:4,createdAt:1000,costTotal:0,costDelta:0,requestHash:'d'.repeat(64)});await assertSucceeds(batch.commit());
      assert.equal((await getDoc(doc(manager,'workOrders/waiting'))).data().completedBy,'inspector-a');
      await seed({'workOrders/other-work':{...work,status:'assigned',revision:1,reportIds:['waiting-report']}});
      await assertFails(updateDoc(doc(manager,'reports/waiting-report'),{workId:'other-work',updatedAt:5000}));
    });
  });
}
