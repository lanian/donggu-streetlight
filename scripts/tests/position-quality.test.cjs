const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { readSource } = require('./source.cjs');
const C = require('../../app/operations-core.js');

test('registry quality counts active approximate positions without inventing coordinates', () => {
  const lights = [{ id: 'precise', lat: 35.14, lng: 126.92 }, { id: 'estimate', posApprox: true, dongGuess: true, noPlate: true }, { id: 'removed', removed: true, posApprox: true }];
  const before = structuredClone(lights);
  assert.deepEqual(C.registryQuality(lights), { total: 3, active: 2, removed: 1, approximate: 1, inferredDong: 1, noPlate: 1 });
  assert.deepEqual(lights, before);
});

test('visit order excludes distribution-box estimates and reports which facilities need coordinates', () => {
  const lights = [{ id: 'precise', code: 'real', lat: 35.14, lng: 126.92 }, { id: 'estimate', code: 'check position', lat: 35.14, lng: 126.92, posApprox: true }];
  const plan = C.planVisits(lights);
  assert.deepEqual(plan.stops.map(row => row.id), ['precise']);
  assert.deepEqual(plan.excludedApproximate.map(row => row.id), ['estimate']);
  assert.equal(lights[1].posApprox, true);
});

test('opening a map for an estimated position requires acknowledging the location limitation', async () => {
  const source = readSource(path.join(__dirname, '../../index.html'), 'utf8');
  const code = source.slice(source.indexOf('async function mapRoute(id){'), source.indexOf('function mapNorm('));
  let warnings = 0, mapChoices = 0;
  const sandbox = { byId: () => ({ id: 'estimate', code: 'E', lat: 35.14, lng: 126.92, posApprox: true }), DEV: { field: true }, dgConfirm: async () => { warnings++; return false; }, DGDialog: { choose: async () => { mapChoices++; } } };
  await vm.runInNewContext(code + '\nmapRoute("estimate")', sandbox);
  assert.equal(warnings, 1); assert.equal(mapChoices, 0);
});

test('saved plans recheck current facilities and preserve visited state while excluding newly approximate stops', () => {
  const saved = { createdAt: 1000, stops: [{ id: 'a', code: 'A', lat: 35.1, lng: 126.9, visited: true, workIds: ['w'] }, { id: 'b', code: 'B', lat: 35.2, lng: 126.9, visited: false }] };
  const current = { a: { id: 'a', code: 'A', lat: 35.11, lng: 126.91 }, b: { id: 'b', code: 'B', lat: 35.2, lng: 126.9, posApprox: true } };
  const plan = C.reconcilePlan(saved, id => current[id]);
  assert.deepEqual(plan.stops.map(s => s.id), ['a']); assert.equal(plan.stops[0].visited, true);
  assert.deepEqual(plan.stops[0].workIds, ['w']); assert.equal(plan.stops[0].lat, 35.11); assert.equal(plan.createdAt, 1000);
  assert.deepEqual(plan.excludedApproximate.map(s => s.id), ['b']); assert.equal(saved.stops.length, 2);
});

test('a plan containing only excluded positions is awaiting verification rather than completed', () => {
  const source = readSource(path.join(__dirname, '../../app/operations.js'), 'utf8');
  const code = source.slice(source.indexOf('  function planView('), source.indexOf('  async function refreshQueue('));
  const plan = { stops: [], distance: 0, excludedApproximate: [{ id: 'a', code: 'A' }] };
  const html = vm.runInNewContext(code + '\nplanView(plan)', { plan, state: { pos: null }, root: {}, api: { byId: () => null }, E: String, fmtM: String, stopDone: () => false, remaining: () => ({ open: [], meters: 0 }) });
  assert.doesNotMatch(html, /모든 방문지를 마쳤어요/); assert.match(html, /좌표.*확인/);
});

test('a delayed Firebase facility snapshot cannot erase saved visits, work links, or order', () => {
  const saved = { createdAt: 1000, stops: [{ id: 'field-created', code: 'F', lat: 35.1, lng: 126.9, visited: true, workIds: ['original-work'] }, { id: 'corrected', code: 'C', lat: 35.12, lng: 126.92, visited: false }] };
  const waiting = C.reconcilePlan(saved, id => id === 'corrected' ? { id, code: 'C', lat: 35.14, lng: 126.94, posApprox: true } : null);
  assert.equal(waiting.stops.length, 0);
  const provisional = C.reconcilePlan(waiting, id => ({ id, code: id, lat: 35.14, lng: 126.94, posApprox: true }));
  assert.equal(provisional.excludedUnavailable.length, 0);
  const arrived = C.reconcilePlan(provisional, id => ({ id, code: id, lat: 35.13, lng: 126.93 }));
  assert.deepEqual(arrived.stops.map(s => s.id), ['field-created', 'corrected']);
  assert.equal(arrived.stops[0].visited, true); assert.deepEqual(arrived.stops[0].workIds, ['original-work']);
  assert.equal(arrived.createdAt, 1000); assert.equal(arrived.excludedApproximate.length, 0); assert.equal(arrived.excludedUnavailable.length, 0);
});
