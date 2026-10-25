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
const Data = require(path.join(root, 'app/data.js'));
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const record = (id, extra = {}) => ({ id, schemaVersion: 1, kind: 'source', label: '외부 공원등', category: 'other_public', operator: '',
  lat: 35.15, lng: 126.92, radius: 20, strength: 'medium', status: 'on', level: 'unknown', schedule: 'hours',
  startMinute: 1080, endMinute: 360, observedAt: 1000, validDays: 90, nightConfirmed: true, lux: null,
  instrument: '', note: '', linkedLightId: '', distinct: true, removed: false,
  createdAt: 1000, createdBy: 'original-author', updatedAt: 1000, updatedBy: 'original-author', revision: 1, operationId: 'historical-operation', ...extra });
const withoutId = ({ id, ...value }) => value;

function local(initial) {
  let saved = JSON.stringify(initial || {});
  const context = vm.createContext({ console, Date, Math, crypto: webcrypto });
  vm.runInContext(source('app/data.js'), context);
  const db = context.DGData.createLocalDB({ storage: { getItem: () => saved, setItem: (_, value) => { saved = value; } }, indexedDB: null });
  const writes = [], original = db.commitMany;
  db.commitMany = async (ops, options) => { writes.push(clone(ops)); return original(ops, options); };
  return { db, writes, dump: () => JSON.parse(saved), user: 'local' };
}
function firebase(initial = {}) {
  let records = clone(initial);
  const writes = [], reads = [], control = { beforeTransaction: null, failServerRead: false };
  const snapshot = (key, from = records) => ({ exists: Object.hasOwn(from, key), data: () => clone(from[key]) });
  const db = {
    doc(key) { return { path: key, get: async options => {
      reads.push({ key, options });
      if (control.failServerRead) throw Object.assign(new Error('server unavailable'), { code: 'unavailable' });
      return snapshot(key);
    }, set: async () => { throw new Error('Lighting restore must not use raw set'); } }; },
    readAll: async collection => Object.entries(records).filter(([key]) => key.startsWith(collection + '/')).map(([key, value]) => ({ ...clone(value), id: key.split('/')[1] })),
    async runTransaction(fn) {
      if (control.beforeTransaction) { const run = control.beforeTransaction; control.beforeTransaction = null; run(records); }
      const next = clone(records), pending = []; let started = false;
      const result = await fn({
        get: async ref => { assert.equal(started, false); return snapshot(ref.path, next); },
        set: (ref, value) => { started = true; next[ref.path] = clone(value); pending.push({ path: ref.path, data: clone(value) }); }
      });
      records = next; if (pending.length) writes.push(pending); return result;
    }
  };
  return { db, fb: db, user: 'admin', reads, writes, control, dump: () => clone(records) };
}

function fixture(backend, collections, overwrite = false) {
  let id = 0;
  const downloads = [], file = { text: async () => JSON.stringify({ app: 'donggu-streetlight', version: 2, complete: true, collections }) };
  const BK = { busy: false, msg: '', photos: true, overwrite, roles: false, file, preview: null };
  const state = { me: backend.user, canWrite: true, lights: [] };
  const context = vm.createContext({ console, Date, Math, Blob, setTimeout, clearTimeout,
    document: { querySelector: () => null, addEventListener() {} },
    DGData: { ...Data, newId: prefix => prefix + '-test-' + (++id) }, DGLightingCommands: Commands, DGLightingModel: Model,
    DGOffline: { ready: true, durable: false, register() {}, subscribe() {}, get: async () => null, list: async () => [], jobs: async () => [] },
    BK, BK_COLS: ['lightingContext', 'lightingOperations'], FB: backend.fb ? { fs: backend.fb } : null, db: backend.db, S: state,
    listAllRecords: (collection, options) => backend.db.readAll(collection, options), confirm: () => true, render() {}, toast() {},
    dl: { save: async value => { downloads.push(value); } }
  });
  vm.runInContext(source('app/restore.js'), context);
  vm.runInContext(source('app/lighting.js'), context);
  context.DGLighting.attach({ state: () => state, can: () => true, database: () => backend.db, firebase: () => backend.fb || null,
    readAll: (collection, options) => backend.db.readAll(collection, options), esc: String, render() {}, toast() {}, invalidateLighting() {} });
  const html = source('index.html'), start = html.indexOf('async function backupPreview(){'), end = html.indexOf('/* ---------- period report:', start);
  assert.ok(start >= 0 && end > start, 'extract the actual preview/import implementation');
  vm.runInContext(html.slice(start, end), context);
  return { context, BK, downloads, preview: () => context.backupPreview(), restore: () => context.backupImport() };
}

test('lighting backup preview excludes immutable receipts and absent tombstones; restore uses a fresh local command', async () => {
  const existing = withoutId(record('existing', { revision: 3, label: '현재 기록' }));
  const backend = local({ lightingContext: { existing } });
  const f = fixture(backend, {
    lightingContext: [record('existing', { label: '백업 기록' }), record('new'), record('removed', { removed: true })],
    lightingOperations: [{ id: 'historical-operation', recordId: 'new', requestHash: 'historical-hash' }]
  });
  await f.preview();
  assert.equal(f.BK.preview.add, 1); assert.equal(f.BK.preview.skip, 1); assert.equal(f.BK.preview.excluded, 2);
  assert.equal(f.BK.preview.collections.lightingOperations, undefined);
  await f.restore();
  const saved = backend.dump(), next = saved.lightingContext.new;
  assert.deepEqual(saved.lightingContext.existing, existing);
  assert.equal(next.createdBy, 'local'); assert.equal(next.updatedBy, 'local'); assert.equal(next.revision, 1); assert.ok(next.createdAt > 1000);
  assert.match(next.operationId, /^lighting-restore-/); assert.equal(saved.lightingContext.removed, undefined);
  assert.equal(saved.lightingOperations['historical-operation'], undefined);
  assert.equal(saved.lightingOperations[next.operationId].recordId, 'new');
  assert.deepEqual(backend.writes.map(ops => ops.map(op => op.path)), [['lightingContext/new', 'lightingOperations/' + next.operationId]]);
  assert.match(f.BK.msg, /1건 저장, 1건 건너뜀, 0건 실패, 2건 제외/);
});

test('Firebase lighting overwrite reads the server revision and preserves current creation metadata', async () => {
  const current = withoutId(record('existing', { revision: 7, label: '최신 기록', createdAt: 2000, createdBy: 'current-owner', updatedAt: 3000 }));
  const backend = firebase({ 'lightingContext/existing': current });
  const f = fixture(backend, { lightingContext: [record('existing', { label: '복원할 내용', kind: 'observation', category: 'field', radius: 10, lux: 0, instrument: '조도계' })] }, true);
  await f.preview(); await f.restore();
  const saved = backend.dump(), value = saved['lightingContext/existing'];
  assert.equal(value.label, '복원할 내용'); assert.equal(value.lux, 0); assert.equal(value.revision, 8);
  assert.equal(value.createdAt, 2000); assert.equal(value.createdBy, 'current-owner'); assert.equal(value.updatedBy, 'admin');
  assert.ok(backend.reads.some(read => read.key === 'lightingContext/existing' && read.options.source === 'server'));
  assert.equal(saved['lightingOperations/' + value.operationId].revision, 8);
  assert.equal(backend.writes.length, 1); assert.equal(backend.writes[0].length, 2); assert.match(f.BK.msg, /1건 저장, 0건 건너뜀, 0건 실패/);
});

test('a raced Firebase revision keeps the newer observation and reports the failed backup row', async () => {
  const backend = firebase({ 'lightingContext/existing': withoutId(record('existing', { revision: 7 })) });
  const f = fixture(backend, { lightingContext: [record('existing', { label: '오래된 백업' })] }, true);
  await f.preview();
  backend.control.beforeTransaction = values => { values['lightingContext/existing'].revision = 8; values['lightingContext/existing'].note = '다른 직원의 최신 관찰'; };
  await f.restore();
  assert.equal(backend.dump()['lightingContext/existing'].revision, 8);
  assert.equal(backend.dump()['lightingContext/existing'].note, '다른 직원의 최신 관찰'); assert.equal(backend.writes.length, 0);
  assert.match(f.BK.msg, /0건 저장, 0건 건너뜀, 1건 실패/); assert.notEqual(f.BK.file, null);
  assert.equal(f.downloads.length, 1);
  const failure = JSON.parse(await f.downloads[0].data.text()).failures[0];
  assert.equal(failure.collection, 'lightingContext'); assert.equal(failure.id, 'existing');
});

test('an unavailable Firebase server cannot turn a backup restore into a cached or raw overwrite', async () => {
  const backend = firebase(), f = fixture(backend, { lightingContext: [record('new')] }, true);
  await f.preview(); backend.control.failServerRead = true; await f.restore();
  assert.deepEqual(backend.dump(), {}); assert.equal(backend.writes.length, 0);
  assert.match(f.BK.msg, /0건 저장, 0건 건너뜀, 1건 실패/);
  assert.deepEqual(clone(backend.reads[0].options), { source: 'server' });
});
