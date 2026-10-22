const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Model = require('../../app/lighting-model.js');

const DAY = 86400000, EARTH = 6371000, RAD = Math.PI / 180;
const now = Date.UTC(2026, 9, 22, 12), origin = { lat: 35.14, lng: 126.93 };
const options = { now, minute: 1260, weak: .3 };
const north = (metres, p = origin) => ({ lat: p.lat + metres / EARTH / RAD, lng: p.lng });
const source = (extra = {}) => ({
  id: 'external-1', kind: 'source', label: '다른 기관 조명', category: 'other_public', operator: '별도 관리기관',
  ...origin, radius: 20, strength: 'medium', status: 'on', level: 'unknown', schedule: 'hours',
  startMinute: 1080, endMinute: 360, observedAt: now - 1000, validDays: 90, nightConfirmed: true,
  lux: null, instrument: '현장 조도계', note: '', linkedLightId: '', distinct: true, removed: false, ...extra
});
const observation = (extra = {}) => source({ id: 'observation-1', kind: 'observation', category: 'field', label: '야간 현장 관찰', radius: 10, level: 'bright', validDays: 30, ...extra });
const evaluate = (records, point = origin, base = 0, extra = {}) => Model.evaluate(Model.createContext(records, [], options), point, base, extra);
const approximately = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
}

test('CommonJS and browser UMD expose the same public API without dependencies', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/lighting-model.js'), 'utf8'), context);
  for (const key of ['createContext', 'evaluate', 'splitSegment', 'normalizeRecord', 'normalize', 'recordState', 'minuteOfKst']) {
    assert.equal(typeof Model[key], 'function'); assert.equal(typeof context.DGLightingModel[key], 'function');
  }
  assert.equal(Model.normalize, Model.normalizeRecord);
});

test('normalization returns uniform domain fields and preserves explicit zero lux', () => {
  const normalized = Model.normalizeRecord(source({ lat: '35.14', lng: '126.93', lux: '0', label: '  정문 조명  ', revision: 7, createdBy: 'staff' }), { now });
  assert.equal(normalized.lat, 35.14); assert.equal(normalized.lng, 126.93); assert.equal(normalized.lux, 0); assert.equal(normalized.label, '정문 조명');
  assert.equal(Object.hasOwn(normalized, 'id'), false); assert.equal(Object.hasOwn(normalized, 'revision'), false); assert.equal(Object.hasOwn(normalized, 'createdBy'), false);
  assert.equal(normalized.removed, false);
  for (const lux of [undefined, null, '', '  ']) assert.equal(Model.normalizeRecord(source({ lux }), { now }).lux, null);
  assert.equal(Model.normalizeRecord(source({ validDays: undefined }), { now }).validDays, 90);
  assert.equal(Model.normalizeRecord(observation({ validDays: undefined }), { now }).validDays, 30);
});

test('invalid coordinates, enum values, booleans, dates and unsafe numeric coercions are rejected', () => {
  const changes = [
    { label: '   ' }, { label: 'x'.repeat(101) }, { operator: 'x'.repeat(101) }, { note: 'x'.repeat(1001) },
    { kind: 'lamp' }, { category: 'government' }, { strength: 'very_high' }, { status: 'normal' }, { level: 'dim' },
    { lat: null }, { lat: '' }, { lat: true }, { lat: [] }, { lat: Infinity }, { lat: 90.1 }, { lng: -180.1 },
    { radius: 4.99 }, { radius: 80.01 }, { radius: false }, { observedAt: null }, { observedAt: 0 },
    { observedAt: now + 300001 }, { observedAt: now - .5 }, { validDays: 0 }, { validDays: 366 }, { validDays: 1.5 },
    { startMinute: -1 }, { endMinute: 1440 }, { startMinute: 1.5 }, { startMinute: 30, endMinute: 30 },
    { nightConfirmed: 'true' }, { distinct: 1 }, { removed: null }, { lux: false }, { lux: -1 }, { lux: NaN }, { lux: 200001 },
    { lux: 0, instrument: '' }, { lux: 1, instrument: '  ' }, { linkedLightId: 'collection/id' }
  ];
  for (const change of changes) assert.throws(() => Model.normalizeRecord(source(change), { now }), { code: 'invalid-argument' }, JSON.stringify(change));
  assert.throws(() => Model.normalizeRecord(observation({ radius: 30.01 }), { now }), { code: 'invalid-argument' });
  assert.doesNotThrow(() => Model.normalizeRecord(source({ observedAt: now + 300000 }), { now }));
  assert.doesNotThrow(() => Model.normalizeRecord(source({ schedule: 'always', startMinute: 0, endMinute: 0 }), { now }));
});

test('KST conversion and overnight hours include the start and exclude the end', () => {
  assert.equal(Model.minuteOfKst(0), 540);
  assert.equal(Model.minuteOfKst(now), 1260);
  assert.equal(Model.minuteOfKst(Date.UTC(2026, 9, 22, 16)), 60);
  const r = source();
  for (const minute of [1080, 1260, 0, 359]) assert.equal(Model.recordState(r, { now, minute }).active, true);
  for (const minute of [360, 540, 1079]) assert.equal(Model.recordState(r, { now, minute }).reason, 'outside_schedule');
  const daytime = source({ startMinute: 500, endMinute: 600 });
  assert.equal(Model.recordState(daytime, { now, minute: 500 }).active, true);
  assert.equal(Model.recordState(daytime, { now, minute: 600 }).active, false);
});

test('unconfirmed, unknown, off, future and expired sources remain hints only', () => {
  const cases = [
    [{ nightConfirmed: false }, 'not_night_confirmed'], [{ status: 'off' }, 'off'], [{ status: 'unknown' }, 'unknown_status'],
    [{ schedule: 'unknown' }, 'unknown_schedule'], [{ startMinute: 600, endMinute: 800 }, 'outside_schedule'],
    [{ observedAt: now + 1 }, 'future'], [{ observedAt: now - 90 * DAY }, 'stale']
  ];
  for (const [change, reason] of cases) {
    const out = evaluate([source(change)], origin, .1);
    assert.equal(out.external, 0); assert.equal(out.adjusted, .1); assert.equal(out.sources.length, 0); assert.equal(out.hints[0].reason, reason);
    assert.equal(out.staleCount, reason === 'stale' ? 1 : 0);
  }
  assert.equal(evaluate([source({ removed: true })]).hints.length, 0);
  assert.equal(Model.recordState(source({ observedAt: now - 90 * DAY + 1 }), options).active, true);
});

test('external contributions use a bounded relative kernel and never measured lux', () => {
  for (const [strength, value] of Object.entries({ low: .6, medium: 1, high: 1.4 })) {
    const out = evaluate([source({ strength, lux: 200000 })], origin, .05);
    approximately(out.external, value); approximately(out.adjusted, value + .05);
    assert.equal(out.unit, 'relative_index'); assert.equal(out.sources[0].category, 'other_public');
  }
  const edge = evaluate([source()], north(20));
  approximately(edge.external, 1 / (1 + (1 / .6) ** 2));
  const outside = evaluate([source()], north(20.001));
  assert.equal(outside.external, 0); assert.equal(outside.hints.length, 0);
  const mid = evaluate([source()], north(12));
  approximately(mid.external, .5);
});

test('linked registry lights and unresolved explicit links never add a second light', () => {
  const managed = [{ id: 'registry-1', ...north(50), status: '고장' }];
  for (const [id, reason] of [['registry-1', 'linked_registry'], ['missing-registry-id', 'unresolved_link']]) {
    const ctx = Model.createContext([source({ linkedLightId: id })], managed, options);
    const out = Model.evaluate(ctx, origin, .1);
    assert.equal(out.external, 0); assert.equal(out.hints[0].reason, reason);
  }
});

test('a source within 5 m of a registry light needs explicit confirmation that it is distinct', () => {
  const managed = [{ id: 'registry-1', ...origin }];
  const near = source({ ...north(5), distinct: false });
  const duplicate = Model.evaluate(Model.createContext([near], managed, options), origin, 0);
  assert.equal(duplicate.external, 0); assert.equal(duplicate.hints[0].reason, 'possible_registry_duplicate');
  const separate = Model.evaluate(Model.createContext([{ ...near, distinct: true }], managed, options), origin, 0);
  assert.ok(separate.external > 0);
  const beyond = Model.evaluate(Model.createContext([source({ ...north(5.01), distinct: false })], managed, options), origin, 0);
  assert.ok(beyond.external > 0);
  const removed = Model.evaluate(Model.createContext([source({ distinct: false })], [{ ...managed[0], removed: true }], options), origin, 0);
  assert.equal(removed.external, 1);
});

test('same-label/operator sources within 2 m use the newest evidence even when it is off', () => {
  const older = source({ id: 'older', observedAt: now - DAY, label: ' 정문 조명 ', operator: '공공  기관' });
  const newer = source({ id: 'newer', ...north(1), label: '정문 조명', operator: '공공 기관', status: 'off' });
  const out = evaluate([older, newer]);
  assert.equal(out.external, 0); assert.deepEqual(out.hints.map(x => x.reason), ['duplicate_source', 'off']);
  const lit = evaluate([older, { ...newer, status: 'on' }]);
  assert.equal(lit.sources.length, 1); assert.equal(lit.sources[0].id, 'newer');
  assert.deepEqual(lit, evaluate([{ ...newer, status: 'on' }, older]));
});

test('duplicate groups are transitive but genuinely separate labels or operators remain separate', () => {
  const cluster = [0, 1.5, 3].map((n, i) => source({ id: 'same-' + i, ...north(n), observedAt: now - (i + 1) * 1000 }));
  assert.equal(evaluate(cluster).sources.length, 1);
  assert.equal(evaluate([source(), source({ id: 'different-name', label: '건너편 조명' })]).sources.length, 2);
  assert.equal(evaluate([source(), source({ id: 'different-operator', operator: '별도 학교' })]).sources.length, 2);
  assert.equal(evaluate([source(), source({ id: 'outside-duplicate-radius', ...north(2.01) })]).sources.length, 2);
});

test('a newer revision or tombstone for the same ID replaces an older list entry', () => {
  const first = source({ revision: 1, observedAt: now - 1 });
  const changed = source({ revision: 2, observedAt: now - 1000, status: 'off' });
  assert.equal(evaluate([first, changed]).external, 0);
  assert.equal(evaluate([changed, first]).external, 0);
  assert.equal(Model.createContext([first, { ...changed, removed: true }], [], options).sourceCount, 0);
  const obs1 = observation({ revision: 1, level: 'bright' });
  const obs2 = observation({ revision: 2, level: 'dark' });
  assert.equal(evaluate([obs1, obs2]).fieldLevel, 'dark');
});

test('field observations and measured lux annotate the model without increasing or decreasing its index', () => {
  for (const [level, lux] of [['bright', 1000], ['adequate', null], ['dark', 0], ['unknown', 0]]) {
    const out = evaluate([observation({ level, lux })], origin, .05);
    assert.equal(out.external, 0); assert.equal(out.base, .05); assert.equal(out.adjusted, .05);
    assert.equal(out.observations[0].lux, lux); assert.equal(out.fieldLevel, level === 'unknown' ? null : level);
  }
  const dark = evaluate([observation({ level: 'dark' })], origin, 10);
  assert.equal(dark.classification, 'observed_dark'); assert.equal(dark.adjusted, 10);
});

test('opposing recent field observations are a conflict rather than latest-wins', () => {
  const dark = observation({ id: 'dark', level: 'dark', observedAt: now - 2000 });
  for (const level of ['bright', 'adequate']) {
    const out = evaluate([dark, observation({ id: 'newer', level })]);
    assert.equal(out.fieldLevel, 'conflict'); assert.equal(out.classification, 'conflict'); assert.equal(out.observations.length, 2);
  }
  const supporting = evaluate([observation({ id: 'a', level: 'adequate' }), observation({ id: 'b', level: 'bright' })]);
  assert.equal(supporting.fieldLevel, 'bright'); assert.equal(supporting.classification, 'observed_bright');
});

test('observation evidence is limited to its radius, schedule and freshness', () => {
  const record = observation();
  assert.equal(evaluate([record], north(10)).fieldLevel, 'bright');
  assert.equal(evaluate([record], north(10.001)).fieldLevel, null);
  assert.equal(evaluate([record], north(30)).observations.length, 0);
  for (const change of [{ observedAt: now - 30 * DAY }, { nightConfirmed: false }, { schedule: 'unknown' }, { startMinute: 0, endMinute: 60 }]) {
    const out = evaluate([observation(change)]);
    assert.equal(out.observations.length, 0); assert.equal(out.fieldLevel, null); assert.equal(out.hints.length, 1);
  }
});

test('classification distinguishes registry gaps, weak models and externally supported scenarios', () => {
  assert.equal(evaluate([], origin, 0, { registryNearby: false }).classification, 'data_gap');
  assert.equal(evaluate([], origin, 0, { registryNearby: true }).classification, 'model_weak');
  assert.equal(evaluate([], origin, .3).classification, 'model_lit');
  assert.equal(evaluate([source()], origin, 0).classification, 'external_supported');
  assert.equal(evaluate([source()], origin, .5).classification, 'model_lit');
  const small = source({ strength: 'low' });
  assert.equal(evaluate([small], north(20), .01, { registryNearby: true }).classification, 'model_weak');
  assert.equal(evaluate([small], north(20), .01, { registryNearby: false }).classification, 'data_gap');
  assert.equal(evaluate([observation()], origin, 0, { registryNearby: false }).classification, 'observed_bright');
});

test('a context uses its fixed evaluation time and rebuilding expires evidence without a DB change', () => {
  const record = source({ observedAt: now - DAY + 1000, validDays: 1 });
  const before = Model.createContext([record], [], options);
  const after = Model.createContext([record], [], { ...options, now: now + 1000 });
  assert.equal(Model.evaluate(before, origin, 0).external, 1);
  assert.equal(Model.evaluate(after, origin, 0).external, 0);
  assert.equal(Model.evaluate(after, origin, 0).staleCount, 1);
});

test('invalid stored records are ignored numerically and expose a diagnostic hint', () => {
  const ctx = Model.createContext([null, source({ id: 'bad', nightConfirmed: 'true' }), source({ id: 'good' })], [], options);
  assert.equal(ctx.invalidCount, 2);
  const out = Model.evaluate(ctx, origin, 0);
  assert.equal(out.external, 1); assert.equal(out.sources[0].id, 'good'); assert.equal(out.hints[0].reason, 'invalid_record');
  assert.equal(Model.recordState(source({ radius: Infinity }), options).reason, 'invalid_record');
  assert.throws(() => Model.createContext({}, []), { code: 'invalid-argument' });
  assert.throws(() => Model.createContext([], null), { code: 'invalid-argument' });
  assert.throws(() => Model.createContext([], [], { ...options, minute: 1440 }), { code: 'invalid-argument' });
  assert.throws(() => Model.createContext([], [], { ...options, weak: 0 }), { code: 'invalid-argument' });
  for (const invalid of [NaN, Infinity, -1, '0']) assert.throws(() => Model.evaluate(ctx, origin, invalid), { code: 'invalid-argument' });
  assert.throws(() => Model.evaluate(ctx, { lat: NaN, lng: 0 }, 0), { code: 'invalid-argument' });
});

test('model creation never modifies the management registry, its spacing data, or records', () => {
  const managed = freeze([{ id: 'registry-1', ...origin, status: '정상', r: 17 }]);
  const records = freeze([source(), observation({ lux: 0 })]);
  const previous = JSON.stringify({ managed, records });
  const context = Model.createContext(records, managed, options);
  Model.evaluate(context, origin, .1);
  assert.equal(JSON.stringify({ managed, records }), previous);
  assert.equal(context.sourceCount, 1); assert.equal(context.observationCount, 1);
  assert.equal(Object.isFrozen(context.records[0]), true);
});

test('spatial indexing handles date-line crossings and polar longitudes', () => {
  const p = { lat: 0, lng: 179.99999 }, r = source({ lat: 0, lng: -179.99999, radius: 5 });
  assert.ok(evaluate([r], p).external > 0);
  const pole = { lat: 89.999, lng: 179.9 };
  assert.ok(evaluate([source({ lat: 89.999, lng: -179.9, radius: 5 })], pole).external > .9);
  const ctx = Model.createContext([r], [{ id: 'date-line-registry', ...p }], options);
  assert.ok(Model.evaluate(ctx, p, 0).external > 0); // distinct confirmation permits it.
  const duplicate = Model.createContext([{ ...r, distinct: false }], [{ id: 'date-line-registry', ...p }], options);
  assert.equal(Model.evaluate(duplicate, p, 0).external, 0);
});

test('spatial results agree with a direct spherical reference calculation', () => {
  const records = Array.from({ length: 100 }, (_, i) => source({ id: 's-' + i, label: 'source ' + i, ...north((i % 10) * 25), lng: origin.lng + Math.floor(i / 10) * .0002, radius: 5 + i % 76 }));
  const ctx = Model.createContext(records, [], options);
  const referenceDistance = (a, b) => {
    const lat = (b.lat - a.lat) * RAD, lng = (b.lng - a.lng) * RAD;
    const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(lng / 2) ** 2;
    return EARTH * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  for (let i = 0; i < 30; i++) {
    const point = { ...north(i * 7), lng: origin.lng + i * .00004 };
    const expected = records.reduce((sum, r) => { const d = referenceDistance(point, r); return sum + (d <= r.radius ? 1 / (1 + (d / (.6 * r.radius)) ** 2) : 0); }, 0);
    approximately(Model.evaluate(ctx, point, 0).external, expected, 1e-7);
  }
});

test('road fragments split at actual circle crossings instead of assigning a midpoint to the whole 8 m', () => {
  const east = metres => metres / (EARTH * RAD * Math.cos(origin.lat * RAD));
  const records = [4, 12, 20].map((metres, i) => observation({ id: 'observation-' + i, ...north(metres), lng: origin.lng + east(4.9), radius: 5 }));
  const ctx = Model.createContext(records, [], options);
  let covered = 0, uncovered = 0;
  for (const start of [0, 8, 16]) {
    const pieces = Model.splitSegment(ctx, north(start), north(start + 8));
    approximately(pieces.reduce((sum, p) => sum + p.fraction, 0), 1);
    assert.equal(pieces.length, 3);
    for (const piece of pieces) {
      if (Model.evaluate(ctx, piece.point, 0).fieldLevel === 'bright') covered += 8 * piece.fraction;
      else uncovered += 8 * piece.fraction;
    }
  }
  approximately(covered, 3 * 2 * Math.sqrt(25 - 4.9 ** 2), .001);
  approximately(covered + uncovered, 24);
  assert.ok(covered < 6 && uncovered > 18, `${covered} m covered / ${uncovered} m unobserved`);
});

test('tangent evidence circles never gain positive road coverage', () => {
  // Equatorial longitude/latitude symmetry makes the perpendicular distance exact.
  const p = { lat: 0, lng: 0 }, n = metres => north(metres, p);
  const record = observation({ ...n(4), lng: 5 / EARTH / RAD, radius: 5 });
  const ctx = Model.createContext([record], [], options), pieces = Model.splitSegment(ctx, n(0), n(8));
  assert.equal(pieces.length, 2);
  approximately(pieces.reduce((sum, piece) => sum + piece.fraction, 0), 1);
  assert.ok(pieces.every(piece => Model.evaluate(ctx, piece.point, 0).fieldLevel === null));
});

test('circle segmentation retains overlapping evidence changes, endpoint boundaries and complete coverage', () => {
  const ctx = Model.createContext([
    observation({ id: 'bright', ...north(0), radius: 5 }),
    observation({ id: 'dark', ...north(8), radius: 5, level: 'dark' })
  ], [], options);
  const pieces = Model.splitSegment(ctx, north(0), north(8));
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces.map(piece => Model.evaluate(ctx, piece.point, 0).fieldLevel), ['bright', 'conflict', 'dark']);
  approximately(pieces[0].fraction * 8, 3, 1e-6);
  approximately(pieces[1].fraction * 8, 2, 1e-6);
  const fully = Model.createContext([observation({ ...north(4), radius: 10 })], [], options);
  assert.equal(Model.splitSegment(fully, north(0), north(8)).length, 1);
  const endpoint = Model.createContext([observation({ ...north(-5), radius: 5 })], [], options);
  const endpointPieces = Model.splitSegment(endpoint, north(0), north(8));
  assert.equal(endpointPieces.length, 1);
  assert.equal(Model.evaluate(endpoint, endpointPieces[0].point, 0).fieldLevel, null);
});

test('source-circle edges and date-line fragments are split with finite, ordered fractions', () => {
  const p = { lat: 0, lng: 179.99999 }, end = { lat: 0, lng: -179.99994 };
  const ctx = Model.createContext([source({ ...p, radius: 5 })], [], options);
  const pieces = Model.splitSegment(ctx, p, end);
  assert.equal(pieces.length, 2);
  assert.ok(Model.evaluate(ctx, pieces[0].point, 0).external > 0);
  assert.equal(Model.evaluate(ctx, pieces[1].point, 0).external, 0);
  approximately(pieces.reduce((sum, piece) => sum + piece.fraction, 0), 1);
  assert.ok(pieces.every(piece => piece.fraction > 0 && Number.isFinite(piece.point.lat) && Number.isFinite(piece.point.lng)));
  assert.throws(() => Model.splitSegment(ctx, p, { lat: NaN, lng: 0 }), { code: 'invalid-argument' });
  assert.throws(() => Model.splitSegment(ctx, p, north(1001, p)), { code: 'invalid-argument' });
  assert.deepEqual(Model.splitSegment(ctx, p, p), [{ start: p, end: p, point: p, fraction: 1 }]);
});

test('30,000 road samples use the spatial model without scanning every source', { timeout: 15000 }, t => {
  const records = Array.from({ length: 1200 }, (_, i) => source({ id: 'source-' + i, label: 'source ' + i, lat: origin.lat + (i % 40) * .0005, lng: origin.lng + Math.floor(i / 40) * .0006, radius: 25 }));
  const managed = Array.from({ length: 5553 }, (_, i) => ({ id: 'managed-' + i, lat: origin.lat + (i % 100) * .0002, lng: origin.lng + Math.floor(i / 100) * .0003 }));
  const started = performance.now(), ctx = Model.createContext(records, managed, options);
  let total = 0;
  for (let i = 0; i < 30000; i++) {
    const point = { lat: origin.lat + (i % 200) * .0001, lng: origin.lng + Math.floor(i / 200) * .00012 };
    for (const piece of Model.splitSegment(ctx, point, north(8, point))) total += Model.evaluate(ctx, piece.point, .1).adjusted * piece.fraction;
  }
  assert.ok(Number.isFinite(total) && total > 3000);
  t.diagnostic(`1,200 external records / 5,553 managed lights / 30,000 split and evaluated samples: ${Math.round(performance.now() - started)} ms`);
});
