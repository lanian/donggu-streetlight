const { readSource } = require('./source.cjs');
/* Verify area clipping against the production light grid and review functions. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Model = require('../../app/lighting-model.js');
const Areas = require('../../app/lighting-area-core.js');
const Field = require('../../app/field.js');
const html = readSource(path.join(__dirname, '../../index.html'), 'utf8');
const grid = html.slice(html.indexOf('const LIGHT_MODEL='), html.indexOf('/* ---------- road network:'));
const roadConstants = html.slice(html.indexOf('const ROAD_BBOX='), html.indexOf('let ROADS=null;'));
const roadAreas = html.slice(html.indexOf('function roadAreas(G)'), html.indexOf('/* ---------- street map'));
const review = readSource(path.join(__dirname, '../../app/lighting-review.js'), 'utf8');
const NOW = Date.UTC(2026, 9, 26, 12), latitude = 35.14, longitude = 126.93;
const kx = 111320 * Math.cos(latitude * Math.PI / 180), ky = 110540;
const xy = (x, y = 0) => ({ lat: latitude + y / ky, lng: longitude + x / kx });
const pair = (p) => [p.lat, p.lng];
const copy = value => JSON.parse(JSON.stringify(value));
const approx = (actual, expected, epsilon = .15) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≈ ${expected}`);
const zone = (id, extra = {}) => ({ id, label: '산속 검토 제외', effect: 'exclude', reason: 'mountain', note: '', shape: 'circle', ...xy(0), radius: 10, vertices: [], disabled: false, revision: 1, ...extra });
const road = (id = 'road-a', x = 0, extra = {}) => ({ id, name: '산 아래 보행길', type: 'residential', pts: [pair(xy(x - 50)), pair(xy(x + 50))], ...extra });
const square = (x0, y0, x1, y1) => [xy(x0, y0), xy(x1, y0), xy(x1, y1), xy(x0, y1)].map(pair);
const observation = (extra = {}) => ({ id: 'dark-observation', kind: 'observation', label: '현장 어두움 확인', category: 'field', operator: '', ...xy(0), radius: 10, strength: 'medium', status: 'unknown', level: 'dark', schedule: 'hours', startMinute: 1080, endMinute: 360, observedAt: NOW - 1000, validDays: 30, nightConfirmed: true, lux: null, instrument: '', note: '', linkedLightId: '', distinct: false, removed: false, ...extra });
const light = (id, x, extra = {}) => ({ id, kind: '가로등', code: id, dong: '지산동', lampType: 'LED일반형', status: '정상', ...xy(x), ...extra });
class ReviewDate extends Date { static now() { return NOW; } }
function fixture(options = {}) {
  const data = { lights: options.lights || [], records: options.records || [], areas: options.areas || [] };
  const S = { lights: data.lights, rvMinute: 1260 };
  const roads = { ways: options.ways || [road()], areas: options.automatic || [], bounds: options.bounds || [] };
  const ctx = vm.createContext({ S, ROADS: roads, KINDS: ['가로등', '보안등', '공원등', '특이등'], Date: ReviewDate,
    DongguField: Field, DGLightingModel: Model, DGLightingAreaCore: Areas,
    DGLightingAreas: { context: () => Areas.compile(data.areas), snapshot: () => copy(data.areas), state: { loaded: true, error: '' } },
    DGLighting: { context: options => Model.createContext(data.records, data.lights, options), state: { loaded: true, records: data.records } },
    inDong: (l, dong) => !dong || dong === '전체' || l.dong === dong.replace(/^a:/, ''),
  });
  vm.runInContext(grid + '\n' + roadConstants + '\n' + roadAreas + '\n' + review, ctx);
  return { ctx, data, S, roads, roadsReview: (dong = '전체', kind = '전체') => ctx.roadReview(dong, kind), pairsReview: (dong = '전체', kind = '전체') => ctx.lightReview(dong, kind) };
}

test('a 20 m mountain exclusion clips a 100 m road into two usable 40 m candidates', () => {
  const f = fixture({ areas: [zone('mountain')] }), result = f.roadsReview();
  assert.equal(result.length, 2);
  assert.deepEqual(Array.from(result, c => c.len), [40, 40]);
  approx(result.areaSummary.manualMeters, 20);
  approx(result.areaSummary.byArea.mountain.meters, 20);
  approx(result.reduce((n, c) => n + c.context.coverage.total, 0) + result.areaSummary.manualMeters, 100, .0001);
  for (const candidate of result) {
    assert.equal(candidate.wayId, 'road-a');
    for (const p of candidate.pts.slice(1, -1)) assert.equal(Areas.decision(Areas.compile(f.data.areas), p).excluded, false);
    assert.equal(candidate.context.classification, 'data_gap');
  }
});

test('a matching inclusion reconnects the complete road instead of leaving two clipped fragments', () => {
  const f = fixture({ areas: [zone('mountain'), zone('walkway', { effect: 'include', reason: 'public_path' })] });
  const result = f.roadsReview();
  assert.equal(result.length, 1); assert.equal(result[0].len, 100);
  assert.equal(result.areaSummary.manualMeters, 0); approx(result.areaSummary.includedMeters, 20);
  assert.deepEqual(copy(result[0].scopeException), []);
});

test('an explicit walking corridor restores only its span inside automatic woodland', () => {
  const f = fixture({ areas: [zone('walkway', { effect: 'include', reason: 'public_path', radius: 20 })], automatic: [{ t: 'forest', name: '산림 영역', pts: square(-100, -50, 100, 50) }] });
  const result = f.roadsReview();
  assert.equal(result.length, 1); assert.equal(result[0].len, 40);
  approx(result.areaSummary.includedMeters, 40); approx(result.skip.forest, 60, .6);
  assert.equal(result.areaSummary.manualMeters, 0);
  assert.deepEqual(copy(result[0].scopeException), []);
});

test('an explicit walking corridor also overrides a private-way tag without reviving the entire way', () => {
  const f = fixture({ ways: [road('private-road', 0, { priv: 1 })], areas: [zone('walkway', { effect: 'include', reason: 'public_path', radius: 20 })] });
  const result = f.roadsReview();
  assert.equal(result.length, 1); assert.equal(result[0].len, 40);
  assert.equal(result.skip.ways, 1); approx(result.areaSummary.includedMeters, 40);
});

test('pair midpoint exclusions and their disabled state use the same persistent area geometry', () => {
  const f = fixture({ lights: [light('a', -35), light('b', 35)], areas: [zone('mountain')] });
  const before = f.pairsReview();
  assert.equal(before.length, 0); assert.equal(before.areaSummary.manualPoints, 1);
  assert.equal(before.areaSummary.byArea.mountain.points, 1);
  f.data.areas[0] = { ...f.data.areas[0], disabled: true, revision: 2 };
  const restored = f.pairsReview();
  assert.equal(restored.length, 1); assert.equal(restored[0].d, 70); assert.equal(restored.areaSummary.manualPoints, 0);
  f.data.areas[0] = { ...f.data.areas[0], disabled: false, revision: 3 };
  f.data.areas.push(zone('walkway', { effect: 'include', reason: 'public_path' }));
  assert.equal(f.pairsReview().length, 1);
});

test('valid dark observations survive manual exclusions in both review modes with an explicit exception', () => {
  const f = fixture({ lights: [light('a', -35), light('b', 35)], areas: [zone('mountain', { radius: 100 })], records: [observation()] });
  const inputs = copy(f.data);
  for (const result of [f.roadsReview(), f.pairsReview()]) {
    assert.equal(result.length, 1);
    assert.equal(result[0].context.classification, 'observed_dark');
    assert.ok(result[0].context.observations.some(o => o.id === 'dark-observation'));
    assert.deepEqual(copy(result[0].scopeException), ['mountain']);
  }
  assert.deepEqual(copy(f.data), inputs, 'review exclusion must never modify a facility or field observation');
});

test('a short dark observation inside automatic woodland survives as an explicit exception point', () => {
  const f = fixture({ automatic: [{ t: 'forest', name: '산림 영역', pts: square(-100, -50, 100, 50) }], records: [observation()] });
  const result = f.roadsReview();
  assert.equal(result.length, 1);
  assert.equal(result[0].point, true, 'the observed span is shorter than the 24 m road-candidate threshold');
  assert.equal(result[0].context.classification, 'observed_dark');
  assert.deepEqual(copy(result[0].scopeException), ['automatic']);
  assert.ok(result[0].context.observations.some(o => o.id === 'dark-observation'));
  assert.ok(result.skip.forest > 70 && result.skip.forest < 90);
});

test('expired or unconfirmed dark records cannot silently override an excluded area', () => {
  for (const patch of [{ nightConfirmed: false }, { observedAt: NOW - 31 * 86400000 }, { removed: true }, { startMinute: 600, endMinute: 800 }]) {
    const f = fixture({ areas: [zone('mountain', { radius: 100 })], records: [observation(patch)] });
    const result = f.roadsReview();
    assert.equal(result.length, 0); approx(result.areaSummary.manualMeters, 100);
  }
});

test('disabling a road exclusion restores the full candidate and leaves prior output intact', () => {
  const f = fixture({ areas: [zone('mountain')] }), before = f.roadsReview();
  f.data.areas[0] = { ...f.data.areas[0], disabled: true, revision: 2 };
  const after = f.roadsReview();
  assert.equal(after.length, 1); assert.equal(after[0].len, 100);
  assert.equal(after.areaSummary.manualMeters, 0);
  assert.equal(before.length, 2); approx(before.areaSummary.manualMeters, 20);
});

test('excluded metre counts and area reasons stay inside the selected administrative district', () => {
  const bounds = [{ name: '선택동', polygons: [{ outer: square(-100, -100, 100, 100), holes: [] }] }, { name: '다른동', polygons: [{ outer: square(400, -100, 600, 100), holes: [] }] }];
  const f = fixture({ ways: [road('selected-road'), road('outside-road', 500)], bounds, areas: [zone('selected-zone'), zone('outside-zone', xy(500))] });
  const selected = f.roadsReview('a:선택동');
  assert.equal(selected.length, 2); assert.ok(selected.every(c => c.wayId === 'selected-road'));
  approx(selected.areaSummary.manualMeters, 20);
  assert.deepEqual(Object.keys(selected.areaSummary.byArea), ['selected-zone']);
  const all = f.roadsReview();
  assert.equal(all.length, 4); approx(all.areaSummary.manualMeters, 40);
  const outside = f.roadsReview('a:다른동');
  assert.equal(outside.length, 2); assert.deepEqual(Object.keys(outside.areaSummary.byArea), ['outside-zone']);
});

test('pair exclusions count the reviewed midpoint district, including a pair crossing the boundary', () => {
  const bounds = [{ name: '선택동', polygons: [{ outer: square(-100, -100, 0, 100), holes: [] }] }];
  const f = fixture({ bounds, lights: [light('a', -5, { dong: '선택동' }), light('b', 65, { dong: '다른동' })], areas: [zone('outside-zone', xy(30))] });
  const selected = f.pairsReview('a:선택동');
  assert.equal(selected.length, 0); assert.equal(selected.areaSummary.manualPoints, 0);
  assert.deepEqual(copy(selected.areaSummary.byArea), {});
  const all = f.pairsReview();
  assert.equal(all.length, 0); assert.equal(all.areaSummary.manualPoints, 1);
  f.data.areas = [];
  assert.equal(f.pairsReview('a:선택동').length, 0, 'an out-of-district midpoint must not become a displayed candidate either');
  assert.equal(f.pairsReview().length, 1);
  const inside = fixture({ bounds, lights: [light('a', -65, { dong: '선택동' }), light('b', 5, { dong: '다른동' })], areas: [zone('inside-zone', xy(-30))] });
  assert.equal(inside.pairsReview('a:선택동').areaSummary.manualPoints, 1);
});

test('facility-kind filters exclude mixed-kind pair statistics while retaining all-kind review', () => {
  const f = fixture({ lights: [light('a', -30), light('b', 30, { kind: '공원등' })], areas: [zone('mountain')] });
  assert.equal(f.pairsReview('전체', '전체').areaSummary.manualPoints, 1);
  for (const kind of ['가로등', '공원등']) {
    const result = f.pairsReview('전체', kind);
    assert.equal(result.length, 0); assert.equal(result.areaSummary.manualPoints, 0);
  }
});

test('automatic forest exclusions and inclusion counts also respect selected district boundaries', () => {
  const f = fixture({ ways: [road('selected-road'), road('outside-road', 500)], bounds: [{ name: '선택동', polygons: [{ outer: square(-100, -100, 100, 100), holes: [] }] }], automatic: [{ t: 'forest', name: '외곽 산림', pts: square(400, -100, 600, 100) }], areas: [zone('outside-include', { ...xy(500), effect: 'include', reason: 'public_path', radius: 20 })] });
  const selected = f.roadsReview('a:선택동');
  assert.equal(selected.length, 1); assert.equal(selected[0].len, 100);
  assert.equal(selected.skip.forest, 0); assert.equal(selected.areaSummary.includedMeters, 0);
});

function candidate(name, classification, score, length, extra = {}) {
  return { name, dong: '지산동', typeLabel: '생활도로', len: length, score, mid: xy(0), context: { classification }, ...extra };
}
test('search, evidence filter and sort combine without changing archived candidate order', () => {
  const f = fixture(), candidates = [
    candidate('가람 산책로', 'observed_dark', 250, 40, { near: [{ code: '등-A19' }] }),
    candidate('나무 산책로', 'observed_bright', -160, 80),
    candidate('다리 진입로', 'conflict', 280, 60, { dong: '학동' }),
    candidate('라온 산책로', 'partial_supported', 30, 120, { nolight: true }),
    candidate('마을 골목', 'data_gap', 80, 100, { nolight: true })
  ];
  const original = copy(candidates), rv = { cands: candidates };
  f.S.rvQuery = ' 산책로 '; f.S.rvEvidence = 'attention'; f.S.rvSort = 'length';
  assert.deepEqual(Array.from(f.ctx.rvList(rv), c => c.name), ['라온 산책로', '가람 산책로']);
  f.S.rvEvidence = 'supported';
  assert.deepEqual(Array.from(f.ctx.rvList(rv), c => c.name), ['라온 산책로', '나무 산책로']);
  f.S.rvEvidence = 'dark'; f.S.rvQuery = ''; f.S.rvSort = 'name';
  assert.deepEqual(Array.from(f.ctx.rvList(rv), c => c.name), ['가람 산책로', '다리 진입로']);
  f.S.rvQuery = '등-a19';
  assert.deepEqual(Array.from(f.ctx.rvList(rv), c => c.name), ['가람 산책로']);
  f.S.rvQuery = ''; f.S.rvEvidence = 'gap'; f.S.rvSort = 'length';
  assert.deepEqual(Array.from(f.ctx.rvList(rv), c => c.name), ['라온 산책로', '마을 골목']);
  f.S.rvEvidence = 'all'; f.S.rvQuery = '없는 위치';
  assert.equal(f.ctx.rvList(rv).length, 0);
  assert.deepEqual(candidates, original);
});

test('search includes pair facility IDs displayed as codes, and clearing controls restores the complete view', () => {
  const f = fixture(), a = light('facility-a', -35, { code: '충장-ABC' }), b = light('facility-b', 35, { code: '충장-XYZ' });
  const rv = { cands: [candidate('일반 도로', 'data_gap', 80, 50), candidate('', 'model_weak', 100, undefined, { a, b })] };
  f.S.rvQuery = 'abc'; f.S.rvEvidence = 'all';
  assert.equal(f.ctx.rvList(rv).length, 1); assert.equal(f.ctx.rvList(rv)[0].a.id, a.id);
  f.S.rvQuery = ''; f.S.rvSort = ''; f.S.rvEvidence = 'all';
  assert.equal(f.ctx.rvList(rv).length, 2);
});

test('roads outside the 동구 boundary are not predicted and their length is reported', () => {
  const gu = { name: '동구', polygons: [{ outer: square(-200, -200, 0, 200), holes: [] }] };
  const f = fixture({ ways: [road('inside', -100), road('outside', 120)] }); f.roads.gu = gu;
  const result = f.roadsReview();
  assert.deepEqual([...new Set(result.map(c => c.wayId))], ['inside'], 'only the road inside 동구 is reviewed');
  approx(result.skip.outside, 100, 1); assert.equal(result.skip.guSource, 'gu');
  // a dark observation beyond the boundary does not become a candidate either
  const g = fixture({ ways: [], records: [observation(xy(150))] }); g.roads.gu = gu;
  assert.equal(g.roadsReview().length, 0);
  const h = fixture({ ways: [], records: [observation(xy(-150))] }); h.roads.gu = gu;
  assert.equal(h.roadsReview().length, 1, 'the same observation inside 동구 is kept');
  // without the 동구 boundary all 13 행정동 boundaries together stand in for it
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ name: '시험' + i + '동', polygons: i ? [] : gu.polygons }));
  const k = fixture({ ways: [road('inside', -100), road('outside', 120)], bounds: thirteen });
  assert.deepEqual([...new Set(k.roadsReview().map(c => c.wayId))], ['inside']); assert.equal(k.roadsReview().skip.guSource, 'dongs');
  // with only some 행정동 boundaries nothing is cut by them (the 300 m registry rule applies instead)
  const partial = fixture({ lights: [light('near', 120)], ways: [road('inside', -100), road('outside', 120)], bounds: thirteen.slice(0, 5) });
  assert.equal(partial.roadsReview().skip.guSource, 'registry');
  assert.ok(partial.roadsReview().some(c => c.wayId === 'outside'), 'a road beside a registered light is kept without a full boundary');
});

test('a 가림·가설물 turns a lit stretch and a well-spaced pair into checked candidates; nearby crossings raise priority', () => {
  const lights = [-54, -18, 18, 54].map((x, i) => light('lit-' + i, x));
  const block = (extra = {}) => ({ id: 'scaffold', kind: 'obstruction', label: '신축 공사 가림막', category: 'construction', operator: '', ...xy(0), radius: 20, strength: 'high', observedAt: NOW - 1000, validDays: 180, note: '', removed: false, revision: 1, ...extra });
  assert.equal(fixture({ lights }).roadsReview().length, 0, 'well lit without the obstruction');
  const roads = fixture({ lights, records: [block()] }).roadsReview();
  assert.equal(roads.length, 1); assert.equal(roads[0].context.classification, 'obstructed');
  assert.ok(roads[0].len >= 24 && roads[0].len <= 41, 'only the obstructed span: ' + roads[0].len);
  assert.deepEqual(copy(roads[0].context.obstructions.map(o => o.id)), ['scaffold']); assert.ok(roads[0].context.registryBase > roads[0].context.base);
  const pairsBefore = fixture({ lights, ways: [] }).pairsReview();
  assert.equal(pairsBefore.length, 0);
  const pairs = fixture({ lights, ways: [], records: [block()] }).pairsReview();
  assert.ok(pairs.length >= 1 && pairs.every(c => c.context.obstructions.length), 'pairs whose midpoint is blocked are reviewed despite their spacing');
  // the same candidate next to a crossing gets the crossing listed and a higher score; the brightness index stays the same
  const plain = fixture({ lights, records: [block()] }).roadsReview()[0];
  const near = fixture({ lights, records: [block()] }); near.roads.pois = [{ t: 'crossing', name: '', ...xy(5, 3) }, { t: 'bus', name: '동구청', ...xy(200) }];
  const withPoi = near.roadsReview()[0];
  assert.deepEqual(copy(withPoi.pois).map(p => p.t), ['crossing']); assert.ok(withPoi.pois[0].d <= 30);
  assert.equal(withPoi.score, plain.score + 25); assert.equal(withPoi.context.base, plain.context.base);
  assert.deepEqual(copy(plain.pois), [], 'no POI data means no bonus');
});

test('a large school ground gives the school priority to a candidate near its edge far from its centre', () => {
  const f = fixture({ ways: [road('edge', 0)] });
  f.roads.pois = [{ t: 'school', name: '넓은 학교', ...xy(0, 480), r: 420 }]; // centre 480 m away, grounds reach to 60 m
  const c = f.roadsReview()[0];
  assert.deepEqual(copy(c.pois.map(p => p.t)), ['school']); assert.ok(c.pois[0].d <= 100, 'counted from the edge: ' + c.pois[0].d);
  const g = fixture({ ways: [road('edge', 0)] }); g.roads.pois = [{ t: 'school', name: '먼 학교', ...xy(0, 700), r: 420 }];
  assert.deepEqual(copy(g.roadsReview()[0].pois), [], '280 m from the edge is not near');
});
