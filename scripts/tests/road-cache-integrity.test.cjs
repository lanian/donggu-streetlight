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

function fixture(docs, cached = null) {
  let remoteReads = 0, sourceReads = 0;
  const saved = [];
  const context = vm.createContext({
    db: {
      collection: () => ({ get: async () => { remoteReads++; return { docs }; } }),
      doc: () => ({ set: async () => {} })
    },
    S: { me: 'staff-a', canWrite: true }, can: () => true,
    idbGet: async () => cached, idbSet: async (key, data) => { saved.push(data); },
    adongIndex() {}, DGData: { newId: () => 'streetlight-test-generation' },
    fetch: async () => {
      sourceReads++;
      return { ok: true, json: async () => ({ elements: [{ type: 'way', id: 'fresh-road', tags: { highway: 'residential' },
        geometry: [{ lat: 35.14, lon: 126.92 }, { lat: 35.14, lon: 126.93 }] }] }) };
    }
  });
  vm.runInContext(roadCode, context);
  return { read: (refresh = false) => vm.runInContext('roadsLoad(null, { refresh: ' + refresh + ' })', context),
    counts: () => [remoteReads, sourceReads], saved };
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
