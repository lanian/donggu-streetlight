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
  const { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch } = require('firebase/firestore');
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

    test('anonymous reports accept an empty optional description and the stable QR id', async () => {
      const db = anonymous();
      await assertSucceeds(setDoc(doc(db, 'citizen_reports/blank'), citizen({ lightId: 'p2872307', code: '산수동 642' })));
      const oldClient = citizen(); delete oldClient.desc;
      await assertSucceeds(setDoc(doc(db, 'citizen_reports/legacy-empty'), oldClient));
      await assertFails(getDoc(doc(db, 'citizen_reports/blank')));
      await assertFails(updateDoc(doc(db, 'citizen_reports/blank'), { imported: true }));
      await assertFails(setDoc(doc(db, 'citizen_reports/wrong-type'), citizen({ desc: 42 })));
      await assertFails(setDoc(doc(db, 'citizen_reports/unknown-field'), citizen({ status: '완료' })));
      await assertFails(setDoc(doc(db, 'citizen_reports/no-consent'), citizen({ contact: '01012345678', consent: false })));
      await assertSucceeds(setDoc(doc(db, 'citizen_reports/with-consent'), citizen({ contact: '01012345678', consent: true })));
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
