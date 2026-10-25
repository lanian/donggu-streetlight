const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = name => fs.readFileSync(path.join(__dirname, '../..', name), 'utf8');

function fixture({ enabled = true, oversized = false, loseReply = false } = {}) {
  const calls = [], writes = [], records = new Map();
  const collections = {
    lights: [{ id: 'facility', code: '대장 패치' }],
    workOrders: oversized ? Array.from({ length: 201 }, (_, i) => ({ id: 'work-' + i })) : [{ id: 'work', beforePhotos: ['evidence'], afterPhotos: [], reportIds: ['report'], inspectionIds: [] }],
    photos: [{ id: 'evidence', workId: 'work', data: 'original' }], reports: [{ id: 'report', workId: 'work' }],
    lightingWorkflowOperations: [{ id: 'immutable-receipt' }]
  };
  const file = { text: async () => JSON.stringify({ app: 'donggu-streetlight', version: 2, complete: true, collections }) };
  const BK = { busy: false, file, preview: null, overwrite: false, roles: false, msg: '' };
  let serverApplied = false;
  const call = async (name, input) => {
    calls.push({ name, input: structuredClone(input) });
    if (name === 'previewOperationalRestore') return { operationId: input.operationId, token: 'preview-token', counts: { added: 3, replaced: 0, skipped: 0 }, handledPaths: ['workOrders/work', 'photos/evidence', 'reports/report'] };
    assert.equal(name, 'applyOperationalRestore');
    const replayed = serverApplied; serverApplied = true;
    if (loseReply && !replayed) throw new Error('서버 응답을 받지 못했어요');
    return { restored: 3, skipped: 0, replayed, operationId: input.payload.operationId };
  };
  const db = {
    doc: key => ({ path: key }),
    runTransaction: async fn => fn({
      get: async ref => ({ exists: records.has(ref.path), data: () => records.get(ref.path) }),
      set: (ref, value) => { writes.push(ref.path); records.set(ref.path, value); }
    })
  };
  const context = vm.createContext({ console, Date, Math, TextEncoder, crypto: webcrypto, BK, BK_COLS: Object.keys(collections), S: { me: 'admin' }, FB: { fs: db }, db,
    FIREBASE_CONFIG: { functionsEnabled: enabled }, DGSecurity: { call },
    listAllRecords: async () => [], render() {}, toast() {}, confirm: () => true,
    DGLighting: { load: async () => {} }, DGOperations: { load: async () => {} }, DGLightingWorkflows: { loadTasks: async () => {}, loadHistory: async () => {} }
  });
  vm.runInContext(source('app/data.js'), context); vm.runInContext(source('app/restore.js'), context);
  const html = source('index.html'), start = html.indexOf('async function backupPreview(){'), end = html.indexOf('/* ---------- period report:', start);
  vm.runInContext(html.slice(start, end), context);
  return { context, BK, calls, writes, records };
}

test('actual backup preview blocks all writes when shared restore functions are missing or the bundle is oversized', async () => {
  for (const options of [{ enabled: false }, { oversized: true }]) {
    const f = fixture(options); await f.context.backupPreview();
    assert.equal(f.BK.preview, null); assert.match(f.BK.msg, /서버 기능|200문서/);
    await f.context.backupImport();
    assert.equal(f.calls.length, 0); assert.deepEqual(f.writes, []);
  }
});

test('actual backup restores validated operational dependencies once before general documents and excludes receipts', async () => {
  const f = fixture(); await f.context.backupPreview();
  assert.equal(f.BK.preview.add, 4); assert.equal(f.BK.preview.excluded, 1);
  assert.deepEqual(Object.keys(f.BK.preview.collections), ['lights']);
  assert.deepEqual(f.writes, []);
  await f.context.backupImport();
  assert.deepEqual(f.calls.map(call => call.name), ['previewOperationalRestore', 'applyOperationalRestore']);
  assert.deepEqual(f.writes, ['lights/facility']);
  assert.match(f.BK.msg, /4건 저장, 0건 건너뜀, 0건 실패, 1건 제외/);
});

test('lost operational restore responses keep the exact plan for retry and do not start general writes', async () => {
  const f = fixture({ loseReply: true }); await f.context.backupPreview(); const plan = f.BK.preview;
  await f.context.backupImport();
  assert.equal(f.BK.preview, plan); assert.equal(f.BK.busy, false); assert.deepEqual(f.writes, []);
  assert.match(f.BK.msg, /일반 자료는 아직/);
  await f.context.backupImport();
  const attempts = f.calls.filter(call => call.name === 'applyOperationalRestore');
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].input, attempts[1].input);
  assert.deepEqual(f.writes, ['lights/facility']); assert.equal(f.BK.preview, null);
});

test('changing a backup file while it is being read cannot approve its contents as the newer file', async () => {
  const f = fixture(), read = f.BK.file.text; let resolve;
  f.BK.file.text = () => new Promise(done => { resolve = done; });
  const pending = f.context.backupPreview();
  f.BK.file = { text: async () => '{}' };
  resolve(await read()); await pending;
  assert.equal(f.BK.preview, null); assert.match(f.BK.msg, /선택이 바뀌었어요/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
});

test('an explicitly selected role restore processes the acting administrator last', async () => {
  const f = fixture();
  f.BK.roles = true; f.context.BK_COLS.push('roles');
  f.BK.file = { text: async () => JSON.stringify({ app: 'donggu-streetlight', collections: { roles: [{ id: 'admin', role: 'inspector' }, { id: 'replacement', role: 'admin' }], lights: [{ id: 'facility', code: '대장' }] } }) };
  await f.context.backupPreview(); await f.context.backupImport();
  assert.deepEqual(f.writes, ['lights/facility', 'roles/replacement', 'roles/admin']);
});
