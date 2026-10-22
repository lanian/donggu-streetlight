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

    test('users without staff roles cannot read or write staff records or self-assign a role after setup', async () => {
      const outsider = env.authenticatedContext('outsider').firestore();
      await seed({ 'lights/p1': { status: '정상', updatedAt: 1 } });
      await assertFails(getDoc(doc(outsider, 'lights/p1')));
      await assertFails(setDoc(doc(outsider, 'lights/p2'), { status: '고장', updatedAt: 1 }));
      await assertFails(setDoc(doc(outsider, 'roles/outsider'), { role: 'admin' }));
      await assertFails(setDoc(doc(staff(), 'roles/inspector-a'), { role: 'admin' }));
    });
  });
}
