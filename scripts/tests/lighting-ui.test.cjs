const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = process.env.DG_LIGHTING_ROOT || path.resolve(__dirname, '../..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const Commands = require(path.join(root, 'app/lighting-commands.js'));
const Model = require(path.join(root, 'app/lighting-model.js'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check, detail = () => '') {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail('The expected asynchronous UI state was not reached. ' + detail());
}

async function fixture(options = {}) {
  let fields = {}, closes = 0, saved = '{}';
  const listeners = {}, toasts = [], invalidations = [], positionRequests = [], control = { failDraft: false };
  const document = { querySelector: selector => fields[selector] || null, addEventListener: (name, fn) => (listeners[name] ||= []).push(fn) };
  const context = vm.createContext({ console, Date, Math, TextEncoder, structuredClone, setTimeout, clearTimeout, crypto: webcrypto,
    document, navigator: { geolocation: { getCurrentPosition: (success, failure) => positionRequests.push({ success, failure }) } },
    confirm: message => options.confirm ? options.confirm(message) : true, DongguField: require('../../app/field.js'), DGLightingCommands: Commands, DGLightingModel: Model });
  vm.runInContext(source('app/data.js'), context);
  const db = context.DGData.createLocalDB({ storage: { getItem: () => saved, setItem: (_, value) => { saved = value; } }, indexedDB: null, locks: { request: (_, run) => run() } });
  vm.runInContext(source('app/offline.js'), context);
  const offline = context.DGOffline, adapter = options.adapter || offline.memoryStore();
  if (!options.adapter) {
    const compareAndSet = adapter.compareAndSet;
    adapter.compareAndSet = async (key, ...args) => {
      if (control.failDraft && key.startsWith('lightingDraft:')) throw new Error('draft quota failure');
      return compareAndSet(key, ...args);
    };
  }
  await offline.configure({ namespace: 'lighting-ui/local', durable: true, networkRequired: false, adapter });
  if (options.beforeAttach) await options.beforeAttach(offline);
  vm.runInContext(source('app/lighting.js'), context);
  function close() {
    closes++;
    if (fields['#lcForm']) fields['#lcForm'].isConnected = false;
    if (fields['#lcSave']) fields['#lcSave'].isConnected = false;
    fields = {};
  }
  function mount() {
    if (fields['#lcForm']) fields['#lcForm'].isConnected = false;
    if (fields['#lcSave']) fields['#lcSave'].isConnected = false;
    const draft = context.DGLighting.state.draft, d = draft.data;
    const fieldset = { disabled: draft.readonly || !!draft.pending }, status = { textContent: '' };
    const form = { id: 'lcForm', dataset: { recordId: draft.recordId }, isConnected: true,
      querySelector: selector => selector === 'fieldset' ? fieldset : fields[selector] || null };
    const value = v => ({ value: v == null ? '' : String(v), closest: selector => selector === '#lcForm' ? form : null });
    fields = { '#lcForm': form, '#lcSave': { disabled: !!draft.pending, isConnected: true }, '#lcSaveState': status, '#lcTimeWarning': { textContent: '' }, '#lcPosition': { textContent: '' }, fieldset };
    const mapping = { lcLabel: 'label', lcLat: 'lat', lcLng: 'lng', lcRadius: 'radius', lcSchedule: 'schedule', lcValidDays: 'validDays',
      lcNote: 'note', lcCategory: 'category', lcOperator: 'operator', lcStrength: 'strength', lcStatus: 'status', lcLinked: 'linkedLightId',
      lcLevel: 'level', lcLux: 'lux', lcInstrument: 'instrument' };
    for (const [id, key] of Object.entries(mapping)) fields['#' + id] = value(d[key]);
    fields['#lcObservedAt'] = value(new Date(d.observedAt + 9 * 3600000).toISOString().slice(0, 16));
    fields['#lcStart'] = value(context.DGLighting.minuteText(d.startMinute)); fields['#lcEnd'] = value(context.DGLighting.minuteText(d.endMinute));
    fields['#lcNight'] = { checked: d.nightConfirmed }; fields['#lcDistinct'] = { checked: d.distinct };
  }
  const api = { state: () => ({ me: 'local', canWrite: true, lights: [] }), can: () => true, database: () => db, firebase: () => null,
    readAll: options.readAll || (collection => db.readAll(collection)), esc: String, render() {}, toast: message => toasts.push(message),
    invalidateLighting: reason => invalidations.push(reason), navigate: mount, closeSheet: close };
  context.DGLighting.attach(api);
  return { context, ui: context.DGLighting, offline, db, adapter, control, toasts, invalidations,
    field: key => fields[key], closed: () => closes,
    async open(label = '새 외부 광원') { await context.DGLighting.openEditor('source', { lat: 35.15, lng: 126.92 }); fields['#lcLabel'].value = label; return context.DGLighting.state.draft; },
    click(action) {
      const triggered = { dataset: { lc: action }, disabled: false };
      for (const fn of listeners.click || []) fn({ target: { closest: selector => selector === '[data-lc]' ? triggered : null } });
    },
    async requestGps() {
      this.click('gps');
      await until(() => positionRequests.length > 0); return positionRequests.shift();
    },
    submit() { for (const fn of listeners.submit || []) fn({ target: fields['#lcForm'], preventDefault() {} }); },
    input(id, value) { fields[id].id = id.slice(1); fields[id].value = value; for (const fn of listeners.input || []) fn({ target: fields[id] }); }
  };
}

test('a draft quota error releases pending state and fields without submitting an orphan job', async () => {
  const f = await fixture(), draft = await f.open('공간 오류 후 재시도');
  f.control.failDraft = true; f.submit();
  assert.equal(f.field('fieldset').disabled, true, 'lock the form before the first asynchronous write');
  await until(() => f.toasts.some(message => message.includes('quota')));
  assert.equal(draft.pending, null); assert.equal(f.field('fieldset').disabled, false); assert.equal(f.field('#lcSave').disabled, false);
  assert.equal(draft.data.label, '공간 오류 후 재시도'); assert.equal((await f.offline.jobs()).length, 0);
  f.control.failDraft = false; f.submit();
  await until(async () => (await f.offline.jobs()).some(job => job.state === 'synced'), () => f.toasts.join(' / '));
  assert.equal((await f.db.doc('lightingContext/' + draft.recordId).get()).data().label, '공간 오류 후 재시도');
  await until(async () => await f.offline.get('lightingDraft', draft.recordId) === null);
});

test('pending fields stay locked until completion and the captured command remains fixed', async () => {
  const f = await fixture(), gate = deferred(); let payload;
  f.offline.register('lighting', async value => { payload = value; await gate.promise; });
  const draft = await f.open('전송할 원래 기록'); f.submit();
  assert.equal(f.field('fieldset').disabled, true); assert.equal(f.field('#lcSave').disabled, true);
  await until(() => !!payload);
  assert.equal(payload.data.label, '전송할 원래 기록'); assert.equal(payload.id, draft.pending);
  assert.equal((await f.offline.get('lightingDraft', draft.recordId)).pending, payload.id);
  gate.resolve();
  await until(async () => await f.offline.get('lightingDraft', draft.recordId) === null);
  assert.equal(f.closed(), 1, 'the queue event and submit completion must not close another sheet twice');
  assert.equal((await f.offline.jobs())[0].payload, undefined, 'the actual queue removes successful payloads');
});

test('ready recovers a synced job without payload and an orphan pending draft after restart', async () => {
  const f = await fixture({ beforeAttach: async offline => {
    offline.register('lighting', async () => {});
    await offline.submit('lighting', { id: 'completed-before-close', recordId: 'completed', actor: 'local' }, { id: 'completed-before-close' });
    assert.equal((await offline.jobs())[0].payload, undefined);
    const data = Model.normalizeRecord({ kind: 'source', label: '종료 직전 기록', lat: 35.15, lng: 126.92, radius: 20, observedAt: 1000 });
    await offline.put('lightingDraft', 'completed', { recordId: 'completed', data, expectedRevision: 0, readonly: false, pending: 'completed-before-close' });
    await offline.put('lightingDraft', 'orphan', { recordId: 'orphan', data, expectedRevision: 0, readonly: false, pending: 'never-queued' });
  } });
  await f.ui.ready();
  assert.equal(await f.offline.get('lightingDraft', 'completed'), null);
  assert.equal((await f.offline.get('lightingDraft', 'orphan')).pending, null);
  assert.equal(f.ui.state.draft.recordId, 'orphan'); assert.equal(f.ui.state.draft.pending, null);
});

test('finishing an older save preserves and does not close the newer active editor', async () => {
  const f = await fixture(), gate = deferred(); let active;
  f.offline.register('lighting', async value => { active = value; await gate.promise; });
  const older = await f.open('먼저 저장'); f.submit(); await until(() => !!active);
  const newer = await f.open('다른 지점의 다음 기록'); await f.ui.persistDraft();
  const form = f.field('#lcForm'); assert.notEqual(older.recordId, newer.recordId);
  gate.resolve(); await until(async () => await f.offline.get('lightingDraft', older.recordId) === null);
  assert.equal(f.ui.state.draft, newer); assert.equal(f.field('#lcForm'), form); assert.equal(form.isConnected, true); assert.equal(f.closed(), 0);
  assert.equal((await f.offline.get('lightingDraft', newer.recordId)).data.label, '다른 지점의 다음 기록');
});

test('input from an old form cannot overwrite a new record while its draft is being persisted', async () => {
  const f = await fixture(), old = await f.open('이전 지점'), gate = deferred(), started = deferred();
  const put = f.offline.putIfCurrent; let blocked = false;
  f.offline.putIfCurrent = async (kind, id, ...args) => {
    if (!blocked && kind === 'lightingDraft' && id !== old.recordId) { blocked = true; started.resolve(); await gate.promise; }
    return put(kind, id, ...args);
  };
  const opening = f.ui.openEditor('source', { lat: 35.17, lng: 126.95 }); await started.promise;
  const next = f.ui.state.draft; assert.notEqual(next.recordId, old.recordId);
  assert.equal(f.field('#lcForm').dataset.recordId, old.recordId, 'the previous DOM is still visible during the storage await');
  f.input('#lcLabel', '이전 화면의 늦은 입력'); gate.resolve(); await opening; await f.ui.persistDraft(false);
  assert.equal(next.data.lat, 35.17); assert.equal(next.data.lng, 126.95); assert.equal(next.data.label, '');
  assert.equal((await f.offline.get('lightingDraft', next.recordId)).data.lat, 35.17);
});

test('load follows an update received during an in-flight read and can retry after a read failure', async () => {
  const first = deferred(); let calls = 0, failNext = false;
  const f = await fixture({ readAll: async () => { calls++; if (failNext) { failNext = false; throw new Error('read failed'); } return calls === 1 ? first.promise : [{ id: 'current', revision: calls }]; } });
  const started = f.ui.load(); await until(() => calls === 1); const repeated = f.ui.load();
  first.resolve([{ id: 'old', revision: 1 }]); await Promise.all([started, repeated]);
  assert.equal(calls, 2); assert.equal(f.ui.state.records[0].id, 'current'); assert.equal(f.ui.state.records[0].revision, 2);
  failNext = true; await f.ui.load(); assert.equal(f.ui.state.error, 'read failed');
  await f.ui.load(); assert.equal(f.ui.state.error, ''); assert.equal(f.ui.state.records[0].revision, 4);
});

test('changing a historical observation time follows the untouched default window across midnight', async () => {
  const f = await fixture(); await f.ui.openEditor('observation', { lat: 35.15, lng: 126.92 });
  f.input('#lcObservedAt', '2026-01-01T23:30');
  assert.equal(f.field('#lcStart').value, '22:30'); assert.equal(f.field('#lcEnd').value, '00:30');
  assert.equal(f.ui.state.draft.data.startMinute, 1350); assert.equal(f.ui.state.draft.data.endMinute, 30);
  assert.equal(f.field('#lcTimeWarning').textContent, '');
  await f.ui.persistDraft(); const saved = await f.offline.get('lightingDraft', f.ui.state.draft.recordId);
  assert.equal(saved.timeWindowManual, false); assert.equal(saved.data.startMinute, 1350);
});

test('a manually chosen observation window survives a date change and requires mismatch acknowledgement', async () => {
  const confirmations = [], f = await fixture({ confirm: text => { confirmations.push(text); return false; } });
  await f.ui.openEditor('observation', { lat: 35.15, lng: 126.92 });
  f.input('#lcLabel', '전날 관찰'); f.input('#lcStart', '20:00'); f.input('#lcEnd', '22:00');
  f.input('#lcObservedAt', '2026-01-01T01:00');
  assert.equal(f.field('#lcStart').value, '20:00'); assert.equal(f.field('#lcEnd').value, '22:00');
  assert.equal(f.ui.state.draft.timeWindowManual, true); assert.match(f.field('#lcTimeWarning').textContent, /시간대 밖/);
  f.submit(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(confirmations.length, 1); assert.equal((await f.offline.jobs()).length, 0);
  assert.equal(f.ui.state.draft.pending, null);
});

const patrolObservation = () => ({
  label: '검사용 순찰 관찰', lat: 35.14, lng: 126.92, observedAt: Date.now(),
  originKind: 'patrol', originId: 'test-patrol', originPointId: '1', positionAccuracy: 8
});
const gpsPosition = (accuracy, latitude = 35.145) => ({
  timestamp: Date.now(), coords: { latitude, longitude: 126.925, accuracy }
});

test('moving a linked observation manually removes only the accuracy of the old position', async () => {
  const f = await fixture(), original = patrolObservation();
  await f.ui.openObservation(original);
  f.input('#lcNote', '위치는 그대로 둔 메모');
  assert.equal(f.ui.state.draft.data.positionAccuracy, 8);
  f.input('#lcLat', 35.145);
  await f.ui.persistDraft();
  const saved = await f.offline.get('lightingDraft', f.ui.state.draft.recordId);
  assert.equal(saved.data.positionAccuracy, 0);
  assert.equal(saved.data.originId, original.originId);
  assert.equal(saved.data.originPointId, original.originPointId);
  f.submit();
  await until(async () => (await f.offline.jobs()).some(job => job.state === 'synced'));
  const record = (await f.db.doc('lightingContext/' + saved.recordId).get()).data();
  assert.equal(record.positionAccuracy, 0);
  assert.equal(record.originId, original.originId);
});

test('coarse brightness GPS cannot move a linked observation or mislabel its accuracy', async () => {
  const f = await fixture();
  await f.ui.openObservation(patrolObservation());
  const request = await f.requestGps();
  request.success(gpsPosition(3000));
  await f.ui.persistDraft();
  const saved = await f.offline.get('lightingDraft', f.ui.state.draft.recordId);
  assert.equal(saved.data.lat, 35.14);
  assert.equal(saved.data.positionAccuracy, 8);
});

test('fresh accepted brightness GPS associates its own accuracy with the new coordinates', async () => {
  const f = await fixture();
  await f.ui.openObservation(patrolObservation());
  const request = await f.requestGps();
  request.success(gpsPosition(12.4));
  await f.ui.persistDraft();
  const saved = await f.offline.get('lightingDraft', f.ui.state.draft.recordId);
  assert.equal(saved.data.lat, 35.145);
  assert.equal(saved.data.positionAccuracy, 12.4);
  f.submit();
  await until(async () => (await f.offline.jobs()).some(job => job.state === 'synced'));
  const record = (await f.db.doc('lightingContext/' + saved.recordId).get()).data();
  assert.equal(record.lat, 35.145);
  assert.equal(record.positionAccuracy, 12.4);
});

test('brightness GPS returning after a manual coordinate change does not overwrite it', async () => {
  const f = await fixture();
  await f.ui.openObservation(patrolObservation());
  const request = await f.requestGps();
  f.input('#lcLat', 35.142);
  request.success(gpsPosition(10));
  await f.ui.persistDraft();
  assert.equal(f.ui.state.draft.data.lat, 35.142);
  assert.equal(f.ui.state.draft.data.positionAccuracy, 0);
});

test('locking the account stops late brightness records and queued draft writes', async () => {
  const records = deferred();
  let reads = 0;
  const f = await fixture({ readAll: () => ++reads === 1 ? [] : records.promise });
  const draft = await f.open('기존 계정에서 저장한 내용');
  await f.ui.persistDraft();
  f.field('#lcLabel').value = '계정 전환 도중 늦게 도착한 내용';
  const pending = f.ui.persistDraft(), loading = f.ui.load();
  f.ui.suspend();
  records.resolve([{ id: 'old-account-record' }]);
  await Promise.all([pending, loading]);
  assert.equal(f.ui.state.draft, null);
  assert.equal(f.ui.state.records.length, 0);
  assert.equal((await f.offline.get('lightingDraft', draft.recordId)).data.label, '기존 계정에서 저장한 내용');
});


async function twoObservationTabs() {
  const first = await fixture();
  await first.ui.openObservation(patrolObservation());
  const id = first.ui.state.draft.recordId;
  const second = await fixture({ adapter: first.adapter });
  await second.ui.openEditor(null, null, id, true);
  return { first, second, id };
}

test('a stale observation tab preserves the shared draft and blocks submitting a conflicting edit', async () => {
  const { first, second, id } = await twoObservationTabs();
  first.input('#lcNote', '먼저 저장한 관찰 내용'); await first.ui.persistDraft();
  second.input('#lcNote', '오래된 화면에서 쓴 관찰 내용');
  await assert.rejects(second.ui.persistDraft(), { code: 'conflict' });
  assert.equal(second.field('#lcNote').value, '오래된 화면에서 쓴 관찰 내용');
  assert.equal((await first.offline.get('lightingDraft', id)).data.note, '먼저 저장한 관찰 내용');
  second.submit();
  await until(() => !second.field('fieldset').disabled);
  assert.equal((await second.offline.jobs()).length, 0);
  assert.equal((await first.offline.get('lightingDraft', id)).data.note, '먼저 저장한 관찰 내용');
});

test('discarding a stale observation draft cannot delete a newer tab’s draft or close the stale editor', async () => {
  const { first, second, id } = await twoObservationTabs(), owner = second.ui.state.draft;
  first.input('#lcNote', '보존해야 할 최신 초안'); await first.ui.persistDraft();
  await assert.rejects(second.ui.clearDraft(owner), { code: 'conflict' });
  assert.equal(second.ui.state.draft, owner);
  assert.equal((await first.offline.get('lightingDraft', id)).data.note, '보존해야 할 최신 초안');
});

test('delivery cleanup compares the pending draft atomically and preserves another tab’s replacement', async () => {
  const first = await fixture(), gate = deferred(); let command;
  await first.ui.openObservation(patrolObservation());
  const id = first.ui.state.draft.recordId;
  first.offline.register('lighting', async value => { command = value; await gate.promise; });
  first.submit(); await until(() => !!command);
  const peer = await fixture({ adapter: first.adapter }), get = first.offline.get;
  let replaced = false;
  first.offline.get = async (kind, key) => {
    const value = await get(kind, key);
    if (!replaced && kind === 'lightingDraft' && value?.pending === command.id) {
      replaced = true;
      await peer.offline.putIfCurrent(kind, key, { ...value, pending: null, data: { ...value.data, note: '새 편집 초안' } }, value.draftRevision ?? 0, value);
    }
    return value;
  };
  gate.resolve();
  await until(() => first.toasts.some(toast => toast.includes('기록했어요')));
  assert.equal(replaced, true);
  assert.equal((await get('lightingDraft', id))?.data.note, '새 편집 초안');
});


test('the latest observation draft can be opened explicitly after a conflict', async () => {
  const { first, second } = await twoObservationTabs();
  first.input('#lcNote', '다른 탭의 최신 관찰'); await first.ui.persistDraft();
  second.input('#lcNote', '저장되지 않은 자체 관찰');
  await assert.rejects(second.ui.persistDraft(), { code: 'conflict' });
  assert.match(second.field('#lcSaveState').textContent, /화면에 남아/);
  assert.equal(second.field('#lcNote').value, '저장되지 않은 자체 관찰');
  second.click('reload-draft');
  await until(() => second.field('#lcNote').value === '다른 탭의 최신 관찰');
  second.input('#lcNote', '최신 초안 확인 후 수정'); await second.ui.persistDraft();
  assert.equal((await second.offline.get('lightingDraft', second.ui.state.draft.recordId)).data.note, '최신 초안 확인 후 수정');
});
