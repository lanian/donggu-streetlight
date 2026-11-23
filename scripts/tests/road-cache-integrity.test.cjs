const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../app/staff-app.js'), 'utf8');
const roadCode = source.slice(source.indexOf('const ROAD_BBOX='), source.indexOf('/* assign every light')).split(/\r?\n/)
  .filter(line => !/^(async )?function idb(Open|Get|Set)\(/.test(line)).join('\n');
const road = id => ({ id, type: 'residential', pts: [[35.14, 126.92], [35.14, 126.93]] });
const doc = (id, value) => ({ id, data: () => value });
const metadata = { ver: 4, at: 10, parts: 2, count: 2, areas: 0, pois: 0 };
const chunk = id => ({ ways: [road(id)], areas: [], pois: [] });

function fixture(docs, cached = null, { failCommit = false, sourceResult } = {}) {
  let remoteReads = 0, sourceReads = 0;
  const saved = [], published = [], attempts = [];
  const context = vm.createContext({
    db: {
      collection: () => ({ get: async () => { remoteReads++; return { docs }; } }),
      doc: path => path,
      batch() {
        const writes = [];
        return { set: (path, data) => writes.push({ path, data }), async commit() {
          attempts.push(writes);
          if (failCommit) throw new Error('batch failure');
          published.push(...writes);
        } };
      }
    },
    S: { me: 'staff-a', canWrite: true }, can: () => true,
    idbGet: async () => cached, idbSet: async (key, data) => { saved.push(data); },
    adongIndex() {}, DGData: { newId: () => 'streetlight-test-generation' },
    fetch: async () => {
      sourceReads++;
      if (sourceResult && sourceReads === 1) return { ok: true, json: async () => sourceResult };
      return { ok: true, json: async () => ({ elements: [{ type: 'way', id: 'fresh-road', tags: { highway: 'residential' },
        geometry: [{ lat: 35.14, lon: 126.92 }, { lat: 35.14, lon: 126.93 }] }] }) };
    }
  });
  vm.runInContext(roadCode, context);
  return { read: (refresh = false) => vm.runInContext('roadsLoad(null, { refresh: ' + refresh + ' })', context),
    counts: () => [remoteReads, sourceReads], saved, published, attempts };
}

test('a missing shared road chunk is never published as a local complete road network', async () => {
  const f = fixture([doc('meta', metadata), doc('part-0', chunk('wrong-partial'))]);
  const roads = await f.read();
  assert.deepEqual(Array.from(roads.ways, w => w.id), ['fresh-road']);
  assert.deepEqual(f.counts(), [1, 1]);
  assert.ok(f.saved.every(entry => !entry || entry.ways.every(w => w.id !== 'wrong-partial')));
});

test('complete legacy shared road parts remain readable', async () => {
  const f = fixture([doc('meta', metadata), doc('part-1', chunk('second')), doc('part-0', chunk('first'))]);
  assert.deepEqual(Array.from((await f.read()).ways, w => w.id), ['first', 'second']);
  assert.deepEqual(f.counts(), [1, 0]);
});

test('a refresh bypasses the known local package and the shared road snapshot', async () => {
  const f = fixture([doc('meta', metadata), doc('part-1', chunk('second')), doc('part-0', chunk('first'))]);
  await f.read();
  assert.deepEqual(Array.from((await f.read(true)).ways, w => w.id), ['fresh-road']);
  assert.deepEqual(f.counts(), [1, 1]);
});

test('an old database cache without completeness data cannot silently outrank the source', async () => {
  const f = fixture([], { ver: 4, src: 'db', ways: [road('previous-partial')] });
  assert.deepEqual(Array.from((await f.read()).ways, w => w.id), ['fresh-road']);
});

test('shared road parts from separate publishes cannot be combined', async () => {
  const f = fixture([doc('meta', { ...metadata, generation: 'new' }),
    doc('part-0', { ...chunk('first'), generation: 'new' }),
    doc('part-1', { ...chunk('second'), generation: 'old' })]);
  assert.deepEqual(Array.from((await f.read()).ways, w => w.id), ['fresh-road']);
});

test('a road refresh commits metadata and chunks together using Firestore-compatible data', async () => {
  const f = fixture([]);
  await f.read(true);
  assert.equal(f.attempts.length, 1);
  const meta = f.published.find(entry => entry.path === 'roads/meta').data;
  assert.equal(f.published.length, meta.parts + 1);
  const parts = f.published.filter(entry => entry.path !== 'roads/meta');
  assert.ok(parts.every(entry => entry.data.generation === meta.generation && typeof entry.data.payload === 'string'));
  const reader = fixture(f.published.map(({ path, data }) => doc(path.split('/')[1], data)));
  assert.deepEqual(Array.from((await reader.read()).ways, w => w.id), ['fresh-road']);
  assert.deepEqual(reader.counts(), [1, 0]);
});

test('a failed shared commit leaves the new local road network usable', async () => {
  const f = fixture([], null, { failCommit: true });
  const roads = await f.read(true);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.published.length, 0);
  assert.equal(roads.shareFailed, true);
  assert.deepEqual(Array.from((await f.read()).ways, w => w.id), ['fresh-road']);
});

test('an Overpass timeout remark makes even a successful HTTP response ineligible', async () => {
  const f = fixture([], null, { sourceResult: { elements: [], remark: 'runtime error: timed out' } });
  const roads = await f.read();
  assert.deepEqual(Array.from(roads.ways, w => w.id), ['fresh-road']);
  assert.deepEqual(f.counts(), [1, 2]);
});
