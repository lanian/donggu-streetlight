const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../../app/operations-core.js');
const source = fs.readFileSync(path.join(__dirname, '../../app/lighting-review.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));

// Run the complete production review map view. Only the DOM and Leaflet drawing boundary are recorded.
function fixture() {
  const light = (id, extra = {}) => ({ id, code: id, dong: '동명동', lat: 35.15, lng: 126.92, status: '정상', ...extra });
  const lights = [light('precise', { posApprox: false }), light('legacy-precise'), light('approved', { posApprox: null }),
    light('distribution-estimate', { posApprox: true }), light('imported-estimate', { posApprox: 1 }),
    light('removed', { removed: true }), light('invalid', { lat: null }),
    light('other-dong', { dong: '산수동' }), light('far-away', { lat: 35.16 })];
  const candidate = { key: 'candidate', name: '현장 확인 후보', mid: { lat: 35.15, lng: 126.92 }, dong: '동명동',
    context: { classification: 'model_weak', base: .1, adjusted: .1, coverage: { unit: 'point' }, sources: [], observations: [], hints: [], obstructions: [] } };
  const record = { id: 'field-observation', kind: 'observation', label: '현장 관찰', lat: 35.15, lng: 126.92, radius: 10, observedAt: 1 };
  const state = { lights, review: { mode: 'pairs', dong: '동명동', minute: 1260, cands: [candidate], areas: [], inputRevision: 0, validUntil: Date.now() + 3600000 } };
  const groups = [], maps = [], timers = []; let html = '';
  function shape(type, coordinates, options) {
    return { type, coordinates: copy(coordinates), options: { ...options }, popup: '', handlers: {},
      bindPopup(value) { this.popup = value; return this; },
      on(event, handler) { this.handlers[event] = handler; return this; },
      addTo(group) { group.layers?.push(this); return this; }, setStyle(value) { Object.assign(this.options, value); return this; } };
  }
  const L = {
    map() { const map = { setView() { return this; }, fitBounds() { return this; }, invalidateSize() {}, stop() {}, remove() { this.removed = true; }, on() { return this; } }; maps.push(map); return map; },
    layerGroup() { const group = { layers: [], addTo() { return this; }, clearLayers() { this.layers.length = 0; }, eachLayer(fn) { this.layers.forEach(fn); } }; groups.push(group); return group; },
    circle: (point, options) => shape('circle', point, options),
    circleMarker: (point, options) => shape('marker', point, options),
    polyline: (points, options) => shape('polyline', points, options),
    polygon: (points, options) => shape('polygon', points, options),
    latLngBounds: () => ({ pad() { return this; } })
  };
  const context = vm.createContext({ console, S: state, L, gmap: null, gmapLayer: null, gmapMe: null, gmapPts: [],
    esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
    $: selector => selector === '#mapNote' ? { textContent: '' } : null,
    document: {}, setTimeout: fn => timers.push(fn), clearTimeout() {},
    openSheet: value => { html = value; }, meStop() {},
    inDong: (value, dong) => dong === '전체' || value.dong === dong,
    distM: (a, b) => Core.distance(a, b), reachOf: () => 24, onOf: value => value.status === '정상',
    DGLighting: { state: { records: [record] }, minuteText: () => '21:00', classification: () => '현장 확인', recordSummary: () => '야간 관찰', kstTime: () => '관찰 시각' },
    DongguPWA: { tileLayer: () => ({ addTo() {} }) },
    toast: message => { throw new Error(message); }
  });
  context.window = context;
  vm.runInContext(source, context, { filename: 'app/lighting-review.js' });
  const layers = () => groups.at(-1).layers;
  const coverageIds = () => layers().filter(layer => /data-map-open=/.test(layer.popup)).map(layer => /data-map-open="([^"]+)"/.exec(layer.popup)[1]).sort();
  return { state, record, maps, context, layers, coverageIds, html: () => html,
    open: index => context.openReviewMap(index) };
}

test('whole review map excludes approximate facilities from coverage while preserving current scope and registry records', () => {
  const f = fixture(), original = copy(f.state.lights);
  f.open('all');
  assert.deepEqual(f.coverageIds(), ['approved', 'far-away', 'legacy-precise', 'precise']);
  assert.deepEqual(f.state.lights, original, 'coverage rendering must not delete or alter registry/coordinate data');
  assert.match(f.html(), /추정 좌표[^<]*조명 범위[^<]*제외/);
});

test('single candidate review applies the same approximate exclusion and retains its distance boundary', () => {
  const f = fixture(); f.open(0);
  assert.deepEqual(f.coverageIds(), ['approved', 'legacy-precise', 'other-dong', 'precise']);
  assert.equal(f.layers().filter(layer => layer.type === 'marker').length, 1, 'the review candidate remains visible');
  assert.ok(f.layers().some(layer => layer.popup.includes('data-lc="edit"') && layer.popup.includes('field-observation')), 'independent field observations stay on the map');
});

test('a verified coordinate can rejoin the coverage view without retaining old map layers', () => {
  const f = fixture(); f.open('all');
  assert.equal(f.coverageIds().includes('distribution-estimate'), false);
  f.state.lights.find(light => light.id === 'distribution-estimate').posApprox = false;
  f.open('all');
  assert.equal(f.maps[0].removed, true);
  assert.deepEqual(f.coverageIds(), ['approved', 'distribution-estimate', 'far-away', 'legacy-precise', 'precise']);
});
