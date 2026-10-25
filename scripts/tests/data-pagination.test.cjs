const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../app/data.js');

function firestore(rows, cache = () => false) {
  const calls = [];
  function query(options = {}) {
    return {
      where: (field, op, value) => query({ ...options, where: [...(options.where || []), [field, op, value]] }),
      orderBy: (field, dir) => query({ ...options, orderBy: [...(options.orderBy || []), [field, dir]] }),
      startAfter: snapshot => query({ ...options, after: snapshot.id }),
      limit: limit => query({ ...options, limit }),
      async get(request) {
        calls.push({ ...options, request });
        let selected = D.select(rows, options);
        if (options.after) selected = selected.slice(selected.findIndex(row => row.id === options.after) + 1);
        return { metadata: { fromCache: cache(calls.length) }, docs: selected.slice(0, options.limit).map(row => ({ id: row.id, data: () => { const { id, ...data } = row; return data; } })) };
      }
    };
  }
  return { collection: () => query(), calls };
}

test('cursor pages cover tied ordering exactly once and request only one page plus a lookahead', async () => {
  const rows = Array.from({ length: 105 }, (_, i) => ({ id: String(i).padStart(3, '0'), updatedAt: Math.floor(i / 3), status: 'assigned' }));
  const db = firestore(rows), result = [], query = { where: [['status', '==', 'assigned']], orderBy: [['updatedAt', 'desc']], pageSize: 40, requireServer: true };
  let cursor = null, page;
  do { page = await D.readPage(db, 'workOrders', { ...query, cursor }); result.push(...page.rows); cursor = page.nextCursor; } while (page.hasMore);
  assert.equal(result.length, 105);
  assert.equal(new Set(result.map(row => row.id)).size, 105);
  assert.deepEqual(result.map(row => row.id), D.select(rows, { ...query, orderBy: [['updatedAt', 'desc'], ['__name__', 'desc']] }).map(row => row.id));
  assert.equal(db.calls.length, 3);
  assert.ok(db.calls.every(call => call.limit === 41 && call.request.source === 'server'));
  assert.equal(page.source, 'server');
  assert.equal(page.complete, true);
});

test('cache provenance is retained and complete server reads reject cached pages', async () => {
  const db = firestore([{ id: 'a' }, { id: 'b' }], n => n === 1), metadata = [];
  const rows = await D.readAll(db, 'reports', { pageSize: 1, onMetadata: m => metadata.push(m) });
  assert.equal(rows.length, 2);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].source, 'mixed');
  assert.equal(metadata[0].complete, false);
  const cache = firestore([{ id: 'a' }], () => true);
  const page = await D.readPage(cache, 'reports');
  assert.equal(page.source, 'cache');
  assert.equal(page.complete, false);
  await assert.rejects(D.readPage(cache, 'reports', { requireServer: true }), { code: 'offline' });
});

test('a removed local cursor does not repeat earlier records and changing filters rejects a cursor', async () => {
  let rows = [{ id: 'a', at: 1 }, { id: 'b', at: 2 }, { id: 'c', at: 3 }, { id: 'd', at: 4 }];
  const db = { mode: 'local', collection: () => ({}), readAll: async (col, options) => D.select(rows, options) };
  const query = { pageSize: 2, orderBy: [['at', 'asc']] }, first = await D.readPage(db, 'reports', query);
  rows = rows.filter(row => row.id !== 'b');
  const second = await D.readPage(db, 'reports', { ...query, cursor: first.nextCursor });
  assert.deepEqual(second.rows.map(row => row.id), ['c', 'd']);
  assert.equal(second.source, 'local');
  await assert.rejects(D.readPage(db, 'reports', { ...query, where: [['at', '>', 0]], cursor: first.nextCursor }), { code: 'invalid-cursor' });
});

test('local subscriptions publish changed query results, keeping unrelated writes from invalidating open reviews', async () => {
  let stored = '{}';
  const db = D.createLocalDB({ indexedDB: null, storage: { getItem: () => stored, setItem: (key, value) => { stored = value; } } });
  const snapshots = [];
  const stop = db.collection('lights').where('status', '==', '고장').onSnapshot(value => snapshots.push(D.rowsOf(value)));
  await db.doc('lights/a').set({ status: '고장', note: '초기' });
  assert.equal(snapshots.length, 2);
  await db.doc('lightingRuns/review').set({ reviewedAt: Date.now() });
  await db.doc('lights/b').set({ status: '정상' });
  await db.doc('lights/a').set({ note: '초기', status: '고장' });
  assert.equal(snapshots.length, 2, 'unrelated collections, out-of-query records, and identical values do not notify');
  await db.doc('lights/a').update({ note: '현장 수정' });
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[2][0].note, '현장 수정');
  await db.doc('lights/a').update({ status: '정상' });
  assert.deepEqual(snapshots[3], []);
  stop();
  await db.doc('lights/b').update({ status: '고장' });
  assert.equal(snapshots.length, 4);
  db.close();
});
