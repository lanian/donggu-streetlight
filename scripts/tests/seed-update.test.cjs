// A new seed (demo data) version must never wipe records people wrote on this device. It may only take back
// demo documents an earlier seed placed, and only while they are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../app/data.js'), 'utf8');
function D() { const c = vm.createContext({ console, Date, Math, window: {}, structuredClone }); c.self = c; vm.runInContext(source, c); return c.DGData || c.window.DGData || c.self.DGData; }
function device(initial, files) {
  let data = JSON.stringify(initial);
  const fetch = async name => ({ json: async () => JSON.parse(JSON.stringify(files[name.replace(/^seed\//, '')])) });
  const db = D().createLocalDB({ indexedDB: null, storage: { getItem: () => data, setItem: (_, v) => { data = v; } }, fetch });
  return { db, state: () => JSON.parse(data) };
}
test('a purge seed bump keeps every record written on the device', async () => {
  // a device on seed v4 from before this change: no record of which documents the seed placed
  const d = device({ seedVersion: 4, lights: { p1: { status: '고장' } }, inspections: { i1: { lightId: 'p1', result: '고장' } }, reports: { r1: { issue: '꺼짐' } }, register: { x: { code: '새 등' } } },
    { 'manifest.json': { version: 5, purge: true, docs: [] } });
  await d.db.seed();
  const s = d.state();
  assert.equal(s.seedVersion, 5);
  assert.deepEqual(Object.keys(s.inspections), ['i1']); assert.deepEqual(Object.keys(s.reports), ['r1']);
  assert.deepEqual(Object.keys(s.lights), ['p1']); assert.deepEqual(Object.keys(s.register), ['x']);
});
test('only untouched demo documents from the previous seed are replaced or removed', async () => {
  const files = { 'manifest.json': { version: 1, purge: true, docs: [{ collection: 'inspections', doc_id: 'demo1', file: 'a.json' }, { collection: 'inspections', doc_id: 'demo2', file: 'b.json' }, { collection: 'inspections', doc_id: 'mine', file: 'c.json' }] },
    'a.json': { demo: 1 }, 'b.json': { demo: 2 }, 'c.json': { demo: 'would overwrite' } };
  const d = device({ inspections: { mine: { by: 'user' } } }, files);
  await d.db.seed();
  let s = d.state();
  assert.deepEqual(s.inspections.mine, { by: 'user' }, 'a seed never overwrites an existing record');
  assert.deepEqual(s.inspections.demo1, { demo: 1 });
  // the person edits demo2 and writes their own record
  const raw = s; raw.inspections.demo2 = { demo: 2, edited: true }; raw.inspections.own = { by: 'user' };
  const d2 = device(raw, { ...files, 'manifest.json': { version: 2, purge: true, docs: [] } });
  await d2.db.seed();
  s = d2.state();
  assert.equal(s.inspections.demo1, undefined, 'unchanged demo document taken back');
  assert.deepEqual(s.inspections.demo2, { demo: 2, edited: true }, 'edited demo document kept');
  assert.deepEqual(s.inspections.own, { by: 'user' }); assert.deepEqual(s.inspections.mine, { by: 'user' });
});
