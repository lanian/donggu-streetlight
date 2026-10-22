/* VM regression tests for the legacy-to-module ownership boundary. No network or real storage. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.DONGGU_TEST_ROOT || path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const sources = ['app/operations-core.js', 'app/operations.js', 'app/integration.js', 'app/legacy-bridge.js'].map(file => [file, read(file)]);
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await turn(); } assert.fail('Expected lifecycle transition did not complete'); }
const patrol = sessionId => ({ sessionId, on: false, start: 1, end: 10, dong: '전체', total: 1, track: [{ lat: 35.1, lng: 126.9, at: 1 }], passed: new Map([['L1', 1]]), marks: [{ id: 'L1', code: '등1', result: '고장', at: 2 }], spots: [], dist: 10, pos: null, last: null, heading: null });
const emptyPatrol = () => ({ ...patrol('empty'), track: [], passed: new Map(), marks: [] });

function harness() {
  const storage = new Map(), subscribers = [], listeners = new Map(), submitted = [], resets = [], opened = [], toasts = [];
  let sequence = 0, putGate = null, submitGate = null, draftReadGate = null;
  const snapshotKey = d => JSON.stringify({ lightId: d.lightId, checks: d.checks, result: d.result, memo: d.memo, photos: d.photos });
  const context = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, confirm: () => true,
    document: { querySelector: () => null, addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); } },
    addEventListener() {}, navigator: { onLine: true }, CSS: { escape: String },
    S: { me: 'local', canWrite: true, lights: [], reports: [], asec: null }, FB: null, BASE: [], OV: {}, DRAFTS: {}, draft: null, pt: emptyPatrol(),
    PATROL_JOBS: new Map(), ADMIN_SECTIONS: {}, ADONGS: [], CHECKS: [], dl: null,
    $: () => null, esc: String, fmtDT: String, can: () => true, inDong: () => true, dongOptions: () => '', render() {},
    toast: message => toasts.push(message), listAllRecords: async () => [], getPhoto() {},
    db: { collection: () => ({ onSnapshot() {} }) },
    byId: id => ({ id, code: id, dong: '동' }), draftDirty: d => !!(d && (d.memo || d.result || d.photos?.length || Object.keys(d.checks || {}).length)),
    inspectionDraftKey: snapshotKey, suggestResult() {},
    newInspectionJob: (light, d) => ({ id: 'inspection-' + ++sequence, key: snapshotKey(d), rec: { lightId: light.id, photos: copy(d.photos) } }),
    commitInspectionJob: async () => {}, commitPatrolJob: async () => {},
    DGData: { clone: copy, newId: prefix => prefix + '-' + ++sequence },
    DGManagement: { attach() {} }, DGWorkCommands: { execute: async () => {} },
    openSheet() {}, openMap() {}, renderPhotoStrip() {}, openAdminSection() {}, refreshAdminSection() {}, saveInspection() {}, ptSave() {}, ptFinish() {}, reportCard: () => '<div></div>', ptDraw() {},
    stashDraft() { if (context.draft && context.draftDirty(context.draft)) context.DRAFTS[context.draft.lightId] = context.draft; },
    closeSheet() { context.draft = null; },
    openLight(id) { opened.push(id); context.draft = context.DRAFTS[id] || { lightId: id, checks: {}, result: '', memo: '', photos: [] }; },
    ptReset() { resets.push(context.pt.sessionId); Object.assign(context.pt, { on: false, track: [], marks: [], spots: [], passed: new Map(), dist: 0 }); },
    openPatrol() { context.pt = patrol('new'); }
  };
  const emit = event => { for (const callback of subscribers) callback(event); };
  context.DGOffline = {
    ready: true, durable: true, configure: async () => {}, register() {}, subscribe(callback) { subscribers.push(callback); },
    jobs: async () => [], flush: async () => {},
    list: async kind => { if (kind === 'draft' && draftReadGate) await draftReadGate.promise; return [...storage.values()].filter(entry => entry.kind === kind).map(copy); },
    get: async (kind, id) => copy(storage.get(kind + ':' + id)?.value || null),
    put: async (kind, id, value) => { const saved = copy(value), gate = putGate; putGate = null; if (gate) { gate.entered.resolve(); await gate.release.promise; } storage.set(kind + ':' + id, { kind, id, value: saved, updatedAt: 1 }); emit({ type: 'draft', kind, id }); },
    remove: async (kind, id) => { storage.delete(kind + ':' + id); emit({ type: 'removed', kind, id }); },
    submit: async (kind, payload) => { submitted.push({ kind, payload: copy(payload) }); const gate = submitGate; submitGate = null; if (gate) { gate.entered.resolve(); await gate.release.promise; } return { state: 'synced' }; },
    discard: async id => { const job = context.DGOperations.state.jobs.find(job => job.id === id); emit({ type: 'discarded', id, job: copy(job) }); }
  };
  context.window = context;
  vm.createContext(context);
  const begin = html.indexOf('function patrolDraftKey('), end = html.indexOf('\nasync function commitPatrolJob', begin);
  vm.runInContext(html.slice(begin, end), context, { filename: 'index.html:patrol job creation' });
  const finish = html.indexOf('function finishPatrolJob('), finishEnd = html.indexOf('\nasync function ptSave(', finish);
  vm.runInContext(html.slice(finish, finishEnd), context, { filename: 'index.html:finishPatrolJob' });
  for (const [file, source] of sources) vm.runInContext(source, context, { filename: file });
  context.initializeOperations();
  return {
    context, storage, submitted, resets, opened, toasts, emit,
    putDraft(kind, id, value) { storage.set(kind + ':' + id, { kind, id, value: copy(value), updatedAt: 1 }); },
    holdPut() { const gate = { entered: deferred(), release: deferred() }; putGate = gate; return gate; },
    holdSubmit() { const gate = { entered: deferred(), release: deferred() }; submitGate = gate; return gate; },
    holdRecovery() { draftReadGate = deferred(); return draftReadGate; },
    click(action, dataset = {}) {
      const button = { dataset: { dg: action, ...dataset } };
      const event = { target: { closest: selector => selector === '[data-dg]' ? button : null } };
      for (const callback of listeners.get('click') || []) callback(event);
    }
  };
}

test('patrol save captures the clicked session before a delayed draft write', async () => {
  const h = harness(), c = h.context; c.pt = patrol('old-session');
  const gate = h.holdPut(), saving = c.DGIntegration.savePatrol(); await gate.entered.promise;
  c.pt = patrol('new-session'); gate.release.resolve(); await saving;
  assert.equal(h.submitted[0].payload.sessionId, 'old-session');
  assert.equal(c.pt.sessionId, 'new-session'); assert.equal(c.pt.marks.length, 1); assert.deepEqual(h.resets, []);
});

test('discarding a finished patrol draft releases the matching in-memory session', async () => {
  const h = harness(), c = h.context; c.pt = patrol('finished'); await c.DGIntegration.persistPatrol();
  h.click('discard-draft', { kind: 'patrol', id: 'current' });
  await until(() => !h.storage.has('patrol:current') && h.resets.length === 1);
  assert.equal(c.pt.marks.length, 0); assert.equal(await c.DGIntegration.hasUnsaved(), false);
});

test('discarding an older patrol draft leaves a different current session intact', async () => {
  const h = harness(), c = h.context; c.pt = patrol('older'); await c.DGIntegration.persistPatrol(); c.pt = patrol('current');
  h.click('discard-draft', { kind: 'patrol', id: 'current' }); await until(() => !h.storage.has('patrol:current'));
  assert.equal(c.pt.sessionId, 'current'); assert.equal(c.pt.marks.length, 1); assert.deepEqual(h.resets, []);
});

test('discarded patrol jobs release only their own cached identity', async () => {
  const h = harness(), c = h.context; c.pt = patrol('session'); const old = c.preparePatrolJob();
  c.DGOperations.state.jobs = [{ id: old.id, kind: 'patrol', payload: old, state: 'failed' }];
  h.click('discard-job', { id: old.id }); await until(() => !c.PATROL_JOBS.has('session'));
  c.pt.marks.push({ id: 'L2', code: '등2', result: '고장', at: 3 }); const next = c.preparePatrolJob();
  assert.notEqual(next.id, old.id); assert.equal(next.rec.marks.length, 2);
  h.emit({ type: 'discarded', id: old.id, job: { kind: 'patrol', payload: old } });
  assert.equal(c.PATROL_JOBS.get('session').id, next.id);
});

test('opening a facility waits for recovered drafts, not just storage readiness', async () => {
  const h = harness(), c = h.context, saved = { lightId: 'L1', checks: {}, result: '', memo: '사진과 함께 복구할 내용', photos: [{ id: 'photo-original', data: 'data:image/png;base64,AAAA' }] };
  h.putDraft('draft', 'L1', saved); const gate = h.holdRecovery();
  const loading = c.DGIntegration.ready(), opening = c.openLight('L1'); await turn();
  assert.equal(c.DGOffline.ready, true); assert.equal(c.DGIntegration.initialized, false); assert.deepEqual(h.opened, []);
  gate.resolve(); await loading; await opening;
  assert.equal(await c.DGIntegration.whenReady(), true); assert.deepEqual(copy(c.draft), saved); assert.deepEqual(h.opened, ['L1']);
});

test('discarding an inspection draft waits out older queued autosaves', async () => {
  const h = harness(), c = h.context; c.draft = { lightId: 'L1', checks: {}, result: '', memo: '이전', photos: [] };
  const gate = h.holdPut(), first = c.DGIntegration.persistDraft(); await gate.entered.promise;
  c.draft.memo = '최신'; const second = c.DGIntegration.persistDraft();
  h.click('discard-draft', { kind: 'draft', id: 'L1' }); await turn(); gate.release.resolve(); await first; await second;
  await until(() => !h.storage.has('draft:L1') && !c.DRAFTS.L1 && c.draft === null);
  assert.equal(await c.DGIntegration.hasUnsaved(), false);
});

test('a photo added while an inspection is saving remains in the newer draft', async () => {
  const h = harness(), c = h.context;
  c.draft = { lightId: 'L1', checks: {}, result: '정상', memo: '점검', photos: [{ id: 'before' }] };
  const gate = h.holdSubmit(), saving = c.DGIntegration.saveInspection(); await gate.entered.promise;
  c.draft.photos.push({ id: 'after' }); gate.release.resolve(); await saving;
  assert.deepEqual(h.submitted[0].payload.rec.photos.map(p => p.id), ['before']);
  assert.deepEqual(c.draft.photos.map(p => p.id), ['before', 'after']);
  assert.deepEqual(h.storage.get('draft:L1').value.photos.map(p => p.id), ['before', 'after']);
});
