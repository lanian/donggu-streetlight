const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// DG_OPERATIONS_ROOT permits the isolated reviewer to validate the integration tree.
const root = process.env.DG_OPERATIONS_ROOT || path.resolve(__dirname, '../..');
const C = require(path.join(root, 'app/operations-core.js'));
const W = require(path.join(root, 'app/work-commands.js'));
const R = require(path.join(root, 'app/registry-commands.js'));
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const failure = (message, code = 'unavailable') => Object.assign(new Error(message), { code });

function local(initial = {}) {
  let value = JSON.stringify(initial);
  const storage = { fail: false, getItem: () => value, setItem(key, next) { if (this.fail) throw failure('quota', 'quota-exceeded'); value = next; }, dump: () => JSON.parse(value) };
  const context = vm.createContext({ console, Date, Math, crypto: webcrypto });
  vm.runInContext(source('app/data.js'), context);
  return { db: context.DGData.createLocalDB({ storage, indexedDB: null }), storage, data: context.DGData };
}

function firebase(initial = {}) {
  let records = clone(initial), serial = Promise.resolve(), commits = 0;
  const doc = key => ({ path: key, get: async () => snap(key, records), set: async (value, options) => { records[key] = options && (options.merge || options.mergeFields) ? { ...records[key], ...clone(value) } : clone(value); } });
  const snap = (key, values) => ({ id: key.split('/')[1], exists: Object.hasOwn(values, key), data: () => clone(values[key]) });
  const db = { doc, runTransaction(fn) {
    const pending = serial.then(async () => {
      const staged = clone(records); let writesStarted = false;
      const result = await fn({
        get: async ref => { assert.equal(writesStarted, false, 'Firestore must finish reads before writes'); return snap(ref.path, staged); },
        set: (ref, value, options) => { writesStarted = true; staged[ref.path] = options && (options.merge || options.mergeFields) ? { ...staged[ref.path], ...clone(value) } : clone(value); }
      });
      records = staged; commits++; return result;
    });
    serial = pending.catch(() => {}); return pending;
  } };
  return { db, dump: () => clone(records), commits: () => commits };
}

function offline(extra = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, structuredClone, TextEncoder, crypto: webcrypto, navigator: { onLine: true }, ...extra });
  vm.runInContext(source('app/offline.js'), context);
  return { queue: context.DGOffline, context };
}

// Asynchronous IDB requests exercise the actual offline indexedStore namespace keys.
// Browser transaction serialization itself is separately checked with real Chromium.
function indexedDBFixture() {
  const stores = new Map(); let created = false;
  const database = {
    createObjectStore() { created = true; return { createIndex() {} }; }, close() {},
    transaction() {
      const tx = { error: null }; let pending = 0, aborted = false;
      const request = fn => {
        const r = {}; pending++;
        queueMicrotask(() => {
          if (aborted) return;
          try { r.result = fn(); if (r.onsuccess) r.onsuccess(); }
          catch (error) { tx.error = error; aborted = true; if (tx.onerror) tx.onerror(); return; }
          if (--pending === 0) queueMicrotask(() => { if (!pending && !aborted && tx.oncomplete) tx.oncomplete(); });
        }); return r;
      };
      const store = {
        get: key => request(() => clone(stores.get(key))),
        put: value => request(() => { stores.set(value.key, clone(value)); }),
        delete: key => request(() => stores.delete(key)),
        index: () => ({ getAll: ns => request(() => [...stores.values()].filter(v => v.namespace === ns).map(clone)) })
      };
      tx.objectStore = () => store; tx.abort = () => { aborted = true; if (tx.onabort) tx.onabort(); }; return tx;
    }
  };
  return { open() { const r = {}; queueMicrotask(() => { r.result = database; if (!created && r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); }); return r; }, records: stores };
}

function photo(id, workId = 'w', lightId = 'p', by = 'local') {
  return { id, data: { workId, lightId, kind: 'work', by, at: 1, label: '증빙', data: 'data:image/jpeg;base64,AA==', w: 1, h: 1 } };
}
function workFixture({ photographs = 1, stocks = 1, reports = 1, quantity = 10 } = {}) {
  const before = Array.from({ length: photographs }, (_, i) => photo('before' + i));
  const after = Array.from({ length: photographs }, (_, i) => photo('after' + i));
  const parts = Array.from({ length: stocks }, (_, i) => ({ inventoryId: 'stock' + i, name: '자재' + i, qty: 2, unitCost: 100 }));
  const reportIds = Array.from({ length: reports }, (_, i) => 'report' + i);
  const order = { ...C.createOrder({ title: '안전 점검 후 수리', assignedTo: 'local', beforePhotos: before.map(p => p.id), reportIds }, { id: 'p', code: 'P', dong: '동명동' }, 'local', 1),
    status: 'completed', revision: 3, afterPhotos: after.map(p => p.id), parts, costTotal: C.costTotal(parts), completionNote: '배선 및 램프 교체', completedAt: 2, completedBy: 'local' };
  const state = { workOrders: { w: order }, photos: Object.fromEntries([...before, ...after].map(p => [p.id, p.data])),
    inventory: Object.fromEntries(parts.map(p => [p.inventoryId, { name: p.name, quantity, unit: '개', unitCost: 100, revision: 1 }])),
    reports: Object.fromEntries(reportIds.map(id => [id, { lightId: 'p', status: '접수', contact: 'private', createdAt: 1, updatedAt: 10 }])), lights: { p: { status: '고장', updatedAt: 10 } } };
  const job = { id: 'verify', kind: 'transition', workId: 'w', target: 'verified', actor: 'local', at: 20,
    input: { expectedRevision: 3, verificationNote: '원본과 조치 확인' }, photos: [], facilityStatus: '정상', lightUpdatedAt: 10,
    closeReports: true, reportVersions: Object.fromEntries(reportIds.map(id => [id, 10])) };
  return { state, job, order, before, after };
}
const localContext = db => ({ db, user: 'local', admin: true });
const flat = state => Object.fromEntries(Object.entries(state).flatMap(([collection, docs]) => Object.entries(docs).map(([id, value]) => [collection + '/' + id, clone(value)])));

test('work state machine requires the assignee, original evidence and completion details', () => {
  const order = C.createOrder({ title: '램프 교체', assignedTo: 'worker', beforePhotos: ['b'] }, { id: 'p', code: 'P' }, 'admin', 1);
  assert.equal(order.status, 'assigned'); assert.equal(order.revision, 1);
  assert.deepEqual(C.actions(order, 'other', false), []);
  assert.throws(() => C.transition(order, 'in_progress', { expectedRevision: 0 }, 'worker', false, 2), { code: 'conflict' });
  const started = C.transition(order, 'in_progress', { expectedRevision: 1 }, 'worker', false, 2);
  assert.throws(() => C.transition(started, 'completed', { expectedRevision: 2, completionNote: 'done', afterPhotos: [] }, 'worker', false, 3));
  const completed = C.transition(started, 'completed', { expectedRevision: 2, completionNote: '교체', afterPhotos: ['a'] }, 'worker', false, 3);
  assert.deepEqual(C.actions(completed, 'worker', false), []);
  assert.equal(C.transition(completed, 'verified', { expectedRevision: 3 }, 'admin', true, 4).status, 'verified');
  assert.equal(order.status, 'assigned', 'transitions must not mutate the source');
});

for (const mode of ['local', 'firebase']) test(mode + ': 6 before + 6 after photos, 10 stocks and 20 linked reports verify exactly once', async () => {
  const { state, job } = workFixture({ photographs: 6, stocks: 10, reports: 20 });
  const localDB = mode === 'local' && local(state), remote = mode === 'firebase' && firebase(flat(state));
  const context = localDB ? localContext(localDB.db) : { db: remote.db, fb: remote.db, user: 'local', admin: true };
  const read = () => localDB ? flat(localDB.storage.dump()) : remote.dump();
  await W.execute(job, context); const once = read();
  const replay = await W.execute(clone(job), context); assert.equal(replay.alreadyApplied, true); assert.deepEqual(read(), once);
  assert.equal(once['workOrders/w'].status, 'verified'); assert.equal(once['workOrders/w'].revision, 4);
  assert.equal(Object.keys(once).filter(k => k.startsWith('workEvents/')).length, 1);
  assert.equal(Object.keys(once).filter(k => k.startsWith('inventoryMoves/')).length, 10);
  for (let i = 0; i < 10; i++) assert.equal(once['inventory/stock' + i].quantity, 8);
  for (let i = 0; i < 20; i++) { assert.equal(once['reports/report' + i].status, '완료'); assert.equal(once['reports/report' + i].contact, ''); }
  assert.equal(once['lights/p'].status, '정상'); assert.equal(Object.keys(once).filter(k => k.startsWith('photos/')).length, 12);
});

test('the 10 linked-stock ceiling preserves 30 manual parts and rejects an oversized reconciliation', async () => {
  const manual = Array.from({ length: 30 }, (_, i) => ({ name: '직접기록' + i, qty: 1, unitCost: 0 }));
  assert.equal(C.parts(manual).length, 30);
  assert.throws(() => C.parts(manual.slice(0, 11).map((p, i) => ({ ...p, inventoryId: 's' + i }))), /10/);
  const { state, job } = workFixture({ stocks: 6, reports: 0 });
  state.workOrders.w.stockApplied = Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['old' + i, 1]));
  for (let i = 0; i < 6; i++) state.inventory['old' + i] = { name: '기존자재', quantity: 1, revision: 1 };
  const l = local(state); await assert.rejects(W.execute(job, localContext(l.db)), /10/);
  assert.deepEqual(l.storage.dump(), state);
});

test('quota failure aborts work, photos, stock, facility and reports, then the same command retries once', async () => {
  const { state, job } = workFixture(); const l = local(state); l.storage.fail = true;
  await assert.rejects(W.execute(job, localContext(l.db)), { code: 'quota-exceeded' }); assert.deepEqual(l.storage.dump(), state);
  l.storage.fail = false; await W.execute(job, localContext(l.db)); await W.execute(job, localContext(l.db));
  assert.equal(l.storage.dump().inventory.stock0.quantity, 8); assert.equal(Object.keys(l.storage.dump().workEvents).length, 1);
});

test('a stale work revision or concurrent stock change cannot partially verify a work order', async () => {
  const { state, job } = workFixture(); const l = local(state);
  await assert.rejects(W.execute({ ...job, input: { ...job.input, expectedRevision: 2 } }, localContext(l.db)), { code: 'conflict' });
  const original = l.db.commitMany; let changed = false;
  l.db.commitMany = async (ops, opts) => { if (!changed) { changed = true; await l.db.doc('inventory/stock0').update({ quantity: 5, revision: 2 }); } return original(ops, opts); };
  await assert.rejects(W.execute(job, localContext(l.db)), { code: 'conflict' });
  const result = l.storage.dump(); assert.equal(result.workOrders.w.status, 'completed'); assert.equal(result.inventory.stock0.quantity, 5);
  assert.equal(result.workEvents, undefined); assert.equal(result.inventoryMoves, undefined); assert.equal(result.reports.report0.status, '접수');
});

test('existing photo deletion between evidence validation and local CAS aborts verification', async () => {
  const { state, job } = workFixture(); const l = local(state), original = l.db.commitMany; let removed = false;
  l.db.commitMany = async (ops, opts) => { if (!removed) { removed = true; await l.db.doc('photos/after0').delete(); } return original(ops, opts); };
  await assert.rejects(W.execute(job, localContext(l.db)), { code: 'conflict' });
  assert.equal(l.storage.dump().workOrders.w.status, 'completed'); assert.equal(l.storage.dump().inventory.stock0.quantity, 10);
});

test('missing, cross-work or cross-light originals reject completion without committing uploaded photos', async () => {
  for (const variant of ['missing', 'other-work', 'other-light']) {
    const { state, job } = workFixture();
    if (variant === 'missing') delete state.photos.after0;
    if (variant === 'other-work') state.photos.after0.workId = 'other';
    if (variant === 'other-light') state.photos.after0.lightId = 'other';
    const l = local(state); await assert.rejects(W.execute(job, localContext(l.db)), { code: 'failed-precondition' }); assert.deepEqual(l.storage.dump(), state);
  }
});

test('an identical existing photo remains valid when its stored object keys are in another order', async () => {
  const { state, after } = workFixture({ reports: 0, stocks: 0 });
  state.workOrders.w.status = 'in_progress'; state.workOrders.w.revision = 2; state.workOrders.w.afterPhotos = [];
  state.photos.after0 = Object.fromEntries(Object.entries(after[0].data).reverse());
  const l = local(state), job = { id: 'complete', kind: 'transition', target: 'completed', workId: 'w', actor: 'local', at: 3,
    input: { expectedRevision: 2, completionNote: '조치 완료', afterPhotos: ['after0'], parts: [], measurements: [] }, photos: [after[0]] };
  await W.execute(job, localContext(l.db)); assert.equal(l.storage.dump().workOrders.w.status, 'completed');
  assert.equal(Object.keys(l.storage.dump().photos).length, 2);
});

test('report preview versions and commit-time report changes both prevent silent closure', async () => {
  const { state, job } = workFixture(); const l = local(state);
  await assert.rejects(W.execute({ ...job, reportVersions: { report0: 9 } }, localContext(l.db)), { code: 'conflict' });
  assert.deepEqual(l.storage.dump(), state);
  const original = l.db.commitMany; let changed = false;
  l.db.commitMany = async (ops, opts) => { if (!changed) { changed = true; await l.db.doc('reports/report0').update({ updatedAt: 11, status: '처리중' }); } return original(ops, opts); };
  await assert.rejects(W.execute(job, localContext(l.db)), { code: 'conflict' });
  assert.equal(l.storage.dump().reports.report0.status, '처리중'); assert.equal(l.storage.dump().workOrders.w.status, 'completed');
});

test('reopening and verifying again applies only the new stock difference', async () => {
  const { state, job, after } = workFixture(); const l = local(state), context = localContext(l.db);
  await W.execute(job, context);
  for (const [target, input] of [['assigned', { assignedTo: 'local' }], ['in_progress', {}], ['completed', { completionNote: '추가 교체', afterPhotos: after.map(p => p.id), parts: [{ name: '자재0', inventoryId: 'stock0', qty: 3, unitCost: 100 }] }], ['verified', {}]]) {
    const current = l.storage.dump().workOrders.w;
    await W.execute({ id: 'reopen-' + target, kind: 'transition', workId: 'w', target, actor: 'local', at: 30 + current.revision, input: { expectedRevision: current.revision, ...input }, photos: [] }, context);
  }
  const result = l.storage.dump(); assert.equal(result.inventory.stock0.quantity, 7); assert.equal(result.workOrders.w.stockApplied.stock0, 3);
  assert.equal(Object.keys(result.inventoryMoves).length, 2);
});

test('an inventory retry is idempotent and a stale revision or account cannot write', async () => {
  const l = local({ inventory: { s: { name: '램프', quantity: 5, revision: 1 } } }), context = localContext(l.db);
  const job = { id: 'stock-move', kind: 'inventory-move', actor: 'local', itemId: 's', delta: -2, expectedRevision: 1, at: 2, reason: '출고' };
  await W.execute(job, context); await W.execute(job, context);
  assert.equal(l.storage.dump().inventory.s.quantity, 3); assert.equal(Object.keys(l.storage.dump().inventoryMoves).length, 1);
  await assert.rejects(W.execute({ ...job, id: 'stale' }, context), { code: 'conflict' });
  await assert.rejects(W.execute({ ...job, id: 'wrong-account', actor: 'other' }, context), { code: 'permission-denied' });
  await assert.rejects(W.execute({ ...job, id: 'unsupported', actor: 'artifact-user' }, { db: { doc() {} }, user: 'artifact-user', admin: true }), { code: 'unsupported-backend' });
});

function registryJob(entries, id = 'registry-one') { return { id, entries, actor: 'local', at: 100, source: 'new.json', counts: { changed: entries.length }, preserveOverrides: true, markMissingRemoved: false }; }

test('registry CAS compares document structure, preserves unrelated evidence and rejects a raced nested change', async () => {
  const original = { code: 'A', status: '고장', reps: { wide: { id: 'photo', at: 3 } }, lastInspected: 50, aliases: ['older'] };
  const l = local({ lights: { p: original }, inspections: { i: { lightId: 'p', date: 50 } } });
  const job = registryJob([{ id: 'p', before: { code: 'A' }, patch: { code: 'B' }, oldCode: 'A', registryValues: { id: 'p', code: 'B', lat: 35, lng: 126 } }]);
  const prepared = await R.prepare(job, job.entries, async key => (await l.db.doc(key).get()).data());
  await l.db.doc('lights/p').set({ aliases: ['older'], lastInspected: 50, reps: { wide: { at: 3, id: 'photo' } }, status: '고장', code: 'A' });
  await l.db.commitMany(prepared.ops, { expected: prepared.expected });
  const result = l.storage.dump(); assert.equal(result.lights.p.code, 'B'); assert.equal(result.lights.p.status, '고장'); assert.equal(result.lights.p.reps.wide.id, 'photo');
  assert.deepEqual(result.lights.p.aliases, ['older', 'A']); assert.deepEqual(result.inspections.i, { lightId: 'p', date: 50 });
  assert.equal(result.lights.p.registryValues.code, 'B');
  const next = registryJob([{ id: 'p', before: { code: 'B' }, patch: { code: 'C' } }], 'registry-two');
  const preview = await R.prepare(next, next.entries, async key => (await l.db.doc(key).get()).data());
  await l.db.doc('lights/p').update({ reps: { wide: { id: 'replacement', at: 51 } } });
  await assert.rejects(l.db.commitMany(preview.ops, { expected: preview.expected }), { code: 'conflict' });
  assert.equal(l.storage.dump().lights.p.code, 'B');
});

test('an 81-facility registry job resumes after the second chunk fails without replaying the first chunk', async () => {
  const lights = Object.fromEntries(Array.from({ length: 81 }, (_, i) => ['p' + i, { code: 'A' + i, status: '정상' }]));
  const job = registryJob(Object.keys(lights).map(id => ({ id, before: { code: lights[id].code }, patch: { code: 'B' + id }, oldCode: lights[id].code })));
  const l = local({ lights }), original = l.db.commitMany; let failSecond = true, attempted = [];
  l.db.commitMany = async (ops, opts) => { attempted.push(ops.map(op => op.path)); if (failSecond && ops.some(op => op.path === 'lights/p80')) throw failure('interrupted second chunk'); return original(ops, opts); };
  await assert.rejects(R.execute(job, localContext(l.db)), { code: 'unavailable' });
  assert.equal(l.storage.dump().lights.p79.code, 'Bp79'); assert.equal(l.storage.dump().lights.p80.code, 'A80'); assert.equal(l.storage.dump().settings, undefined);
  await l.db.doc('lights/p0').update({ code: '현장 최신값' }); failSecond = false; attempted = [];
  await R.execute(job, localContext(l.db));
  assert.equal(l.storage.dump().lights.p0.code, '현장 최신값'); assert.equal(l.storage.dump().lights.p80.code, 'Bp80');
  assert.equal(attempted.flat().filter(key => key.startsWith('lights/')).length, 1); assert.equal(l.storage.dump().settings['registry-' + job.id].count, 81);
});

test('an import remembers its registry baseline so a second import is not mistaken for a field override', () => {
  const base = [{ id: 'p', code: 'A', lat: 35, lng: 126, lampType: 'old' }];
  const first = { id: 'p', code: 'B', lat: 35, lng: 126, lampType: 'LED' };
  const overrides = { p: { code: 'B', lampType: 'LED', status: '고장', registryJobId: 'one', registryValues: first } };
  const next = { ...first, code: 'C' }, diff = C.registryDiff(base, [next], overrides);
  assert.equal(diff.changed.length, 1); assert.deepEqual(diff.changed[0].changes, { code: 'C' }); assert.deepEqual(diff.changed[0].conflicts, []);
  assert.equal(diff.changed[0].registryValues.code, 'C'); assert.deepEqual(diff.changed[0].overrideBefore, overrides.p);
  const edited = clone(overrides); edited.p.code = '직원이 바꾼 값';
  assert.deepEqual(C.registryDiff(base, [next], edited).changed[0].conflicts, ['code']);
  assert.equal(overrides.p.code, 'B', 'comparison must not mutate the source snapshot');
});

test('real registry normalization retains all facility IDs and coordinates without mutating its original JSON', () => {
  const original = JSON.parse(source('data/lights.json')), frozen = JSON.stringify(original), values = C.normalizeRegistry(original);
  assert.equal(values.length, original.count); assert.equal(new Set(values.map(row => row.id)).size, original.count);
  const idColumn = original.cols.indexOf('id'), latColumn = original.cols.indexOf('lat'), lngColumn = original.cols.indexOf('lng');
  values.forEach((row, i) => { assert.equal(row.id, original.rows[i][idColumn]); assert.equal(row.lat, original.rows[i][latColumn]); assert.equal(row.lng, original.rows[i][lngColumn]); });
  const same = C.registryDiff(values, values, {}); assert.equal(same.unchanged, values.length); assert.equal(same.changed.length, 0);
  assert.equal(JSON.stringify(original), frozen);
  assert.throws(() => C.normalizeRegistry({ ...original, count: original.count + 1 }));
  assert.throws(() => C.normalizeRegistry([{ id: 'p', code: 'P', lat: '', lng: 126 }]));
  assert.throws(() => C.normalizeRegistry([{ id: 'p', code: 'P', lat: 35, lng: 126 }, { id: 'p', code: 'P2', lat: 35, lng: 126 }]));
});

test('analytics uses the entire selected date range and separates period totals from current backlog', async () => {
  const start = Date.UTC(2026, 0, 1), end = Date.UTC(2026, 1, 1) - 1;
  const inspections = Object.fromEntries(Array.from({ length: 1201 }, (_, i) => ['i' + i, { lightId: i % 2 ? 'p' : 'q', result: '고장', date: start + i }]));
  inspections.end = { lightId: 'r', result: '정상', date: end }; inspections.before = { lightId: 'old', result: '고장', date: start - 1 };
  for (let i = 0; i < 1300; i++) inspections['later' + i] = { lightId: 'later', result: '정상', date: end + 1 + i };
  const l = local({ inspections }), rows = await l.data.readAll(l.db, 'inspections', { where: [['date', '>=', start], ['date', '<=', end]], orderBy: [['date', 'desc']] });
  const orders = [{ status: 'verified', createdAt: start - 86400000, verifiedAt: start, costTotal: 100 }, { status: 'verified', createdAt: start, verifiedAt: end + 1, costTotal: 999 }, { status: 'assigned', createdAt: start, dueAt: start - 1 }, { status: 'cancelled', createdAt: start - 1 }];
  const result = C.analytics(rows, orders, [{ status: '접수' }, { status: '완료' }], [{ id: 'p', sw: 'A' }, { id: 'q', sw: 'A' }], start, end);
  assert.equal(result.inspectionCount, 1202); assert.equal(result.uniqueInspected, 3); assert.equal(result.opened, 2); assert.equal(result.verified, 1);
  assert.equal(result.cost, 100); assert.equal(result.averageDays, 1); assert.equal(result.unresolved, 1); assert.equal(result.pendingReports, 1);
  assert.equal(result.circuits[0][1], 1201); assert.deepEqual(result.repeated.map(x => x[1]).sort((a, b) => a - b), [600, 601]);
});

test('offline timeout retains one running immutable command and eventually removes its sensitive payload', async () => {
  const { queue } = offline(); await queue.configure({ namespace: 'firebase:one:alice', durable: false });
  const gate = deferred(); let runs = 0, completed;
  queue.register('work', async () => { runs++; await gate.promise; }); queue.subscribe(e => { if (e.type === 'synced') completed = e.job; });
  const payload = { id: 'j', contact: 'private', photos: ['data:image/jpeg;base64,AA=='] };
  const waiting = await queue.submit('work', payload, { id: 'j', waitMs: 1 }); assert.equal(waiting.state, 'sending');
  const duplicate = await queue.submit('work', clone(payload), { id: 'j', waitMs: 1 }); assert.equal(duplicate.state, 'sending'); assert.equal(runs, 1);
  gate.resolve(); await queue.flush();
  const [done] = await queue.jobs(); assert.equal(done.state, 'synced'); assert.equal(done.attempts, 1); assert.equal(done.payload, undefined); assert.deepEqual(clone(completed.payload), payload);
  await queue.submit('work', { photos: payload.photos, contact: 'private', id: 'j' }, { id: 'j' }); assert.equal(runs, 1, 'equivalent key order is the same payload');
  await assert.rejects(queue.submit('work', { ...payload, contact: 'changed' }, { id: 'j' }), { code: 'conflict' });
});

test('offline and transient failure retry the stable payload, while a conflict waits for an explicit retry', async () => {
  const { queue, context } = offline(); await queue.configure({ namespace: 'firebase:one:alice', durable: false });
  context.navigator.onLine = false; let calls = 0, code = 'unavailable';
  queue.register('work', async payload => { calls++; assert.equal(payload.value, 1); if (code) throw failure('interrupted', code); });
  assert.equal((await queue.submit('work', { id: 'j', value: 1 }, { id: 'j' })).state, 'queued'); assert.equal(calls, 0);
  context.navigator.onLine = true; await queue.flush(); assert.equal((await queue.jobs())[0].state, 'queued'); assert.equal(calls, 1);
  code = 'conflict'; await queue.flush(); assert.equal((await queue.jobs())[0].state, 'conflict'); await queue.flush(); assert.equal(calls, 2);
  code = ''; assert.equal((await queue.retry('j')).state, 'synced'); assert.equal(calls, 3);
});

test('concurrent submissions cannot both accept different payloads under the same immutable command ID', async () => {
  const { queue } = offline({ navigator: { onLine: false } }), store = queue.memoryStore(), originalRead = store.read;
  store.read = async key => { const snapshot = await originalRead(key); await new Promise(resolve => setTimeout(resolve, 10)); return snapshot; };
  await queue.configure({ namespace: 'firebase:p:alice', durable: false, adapter: store });
  const results = await Promise.allSettled([queue.submit('work', { id: 'j', memo: 'first' }, { id: 'j' }), queue.submit('work', { id: 'j', memo: 'second' }, { id: 'j' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'conflict');
  assert.equal((await queue.jobs()).length, 1);
});

test('a caller edit during asynchronous fingerprinting cannot change the queued payload', async () => {
  const { queue } = offline({ navigator: { onLine: false } }); await queue.configure({ namespace: 'firebase:p:alice', durable: false });
  const payload = { id: 'j', input: { memo: 'original' } }, pending = queue.submit('work', payload, { id: 'j' });
  payload.input.memo = 'new draft'; await pending;
  assert.equal((await queue.jobs())[0].payload.input.memo, 'original');
  await queue.submit('work', { id: 'j', input: { memo: 'original' } }, { id: 'j' });
});

test('durable drafts are scoped by backend, project and account, and another instance can restore the same account', async () => {
  const idb = indexedDBFixture(), a = offline({ indexedDB: idb }), b = offline({ indexedDB: idb });
  await a.queue.configure({ namespace: 'firebase:project-a:alice', durable: true }); await a.queue.put('draft', 'p', { memo: 'private A' });
  await a.queue.configure({ namespace: 'firebase:project-a:bob', durable: true }); assert.equal(await a.queue.get('draft', 'p'), null);
  await a.queue.configure({ namespace: 'firebase:project-b:alice', durable: true }); assert.equal(await a.queue.get('draft', 'p'), null);
  await a.queue.configure({ namespace: 'artifact:alice', durable: true }); assert.equal(await a.queue.get('draft', 'p'), null);
  await b.queue.configure({ namespace: 'firebase:project-a:alice', durable: true }); assert.deepEqual(clone(await b.queue.get('draft', 'p')), { memo: 'private A' });
  assert.equal(idb.records.size, 1);
});

test('a shared-device memory session never reuses the previous account or reload session drafts', async () => {
  const { queue } = offline(); await queue.configure({ namespace: 'firebase:p:alice', durable: false });
  await queue.put('draft', 'p', { memo: 'private' }); assert.equal(queue.durable, false);
  await queue.configure({ namespace: 'firebase:p:bob', durable: false }); assert.equal(await queue.get('draft', 'p'), null);
  await queue.configure({ namespace: 'firebase:p:alice', durable: false }); assert.equal(await queue.get('draft', 'p'), null);
  const next = offline().queue; await next.configure({ namespace: 'firebase:p:alice', durable: false }); assert.equal(await next.get('draft', 'p'), null);
});

test('switching account during the sending write prevents the old executor from running in the new account', async () => {
  const { queue } = offline(), store = queue.memoryStore(), entered = deferred(), release = deferred();
  const originalWrite = store.write;
  store.write = async (key, value) => { if (value.state === 'sending') { entered.resolve(); await release.promise; } return originalWrite(key, value); };
  await queue.configure({ namespace: 'firebase:p:alice', durable: false, adapter: store }); let runs = 0;
  queue.register('work', async () => { runs++; });
  const pending = queue.submit('work', { id: 'j' }, { id: 'j', waitMs: 100 });
  await entered.promise; await queue.configure({ namespace: 'firebase:p:bob', durable: false }); release.resolve();
  await pending.catch(error => { assert.match(error.code || error.message, /account|session|changed|계정/i); });
  assert.equal(runs, 0); assert.equal((await queue.jobs()).length, 0);
});

test('switching account during submit lookup cannot run or report success for a new account job with the same ID', async () => {
  const { queue } = offline(), a = queue.memoryStore(), b = queue.memoryStore(), entered = deferred(), release = deferred();
  let blocked = false;
  for (const method of ['read', 'claim', 'putIfAbsent']) if (typeof a[method] === 'function') {
    const original = a[method];
    a[method] = async (key, ...args) => { const result = await original(key, ...args); if (!blocked && key === 'job:j') { blocked = true; entered.resolve(); await release.promise; } return result; };
  }
  await b.write('job:j', { id: 'j', kind: 'work', payload: { id: 'j', owner: 'bob' }, state: 'queued', attempts: 0, createdAt: 1 });
  await queue.configure({ namespace: 'firebase:p:alice', durable: false, adapter: a }); const executed = [];
  queue.register('work', async value => executed.push(value.owner));
  const pending = queue.submit('work', { id: 'j', owner: 'alice' }, { id: 'j', waitMs: 100 });
  await entered.promise; await queue.configure({ namespace: 'firebase:p:bob', durable: false, adapter: b }); release.resolve();
  const result = await pending.catch(error => ({ state: 'account-changed', error }));
  assert.notEqual(result.state, 'synced'); assert.deepEqual(executed, []); assert.equal((await b.read('job:j')).state, 'queued');
});

test('failure to durably enqueue prevents execution and retains a retryable caller payload', async () => {
  const { queue } = offline(), store = queue.memoryStore(); store.write = store.claim = async () => { throw failure('disk full', 'quota-exceeded'); };
  await queue.configure({ namespace: 'local:local', durable: false, adapter: store, networkRequired: false }); let calls = 0;
  queue.register('work', async () => { calls++; }); const payload = { id: 'j', memo: 'keep this draft' };
  await assert.rejects(queue.submit('work', payload, { id: 'j' }), { code: 'quota-exceeded' }); assert.equal(calls, 0); assert.equal(payload.memo, 'keep this draft');
});
