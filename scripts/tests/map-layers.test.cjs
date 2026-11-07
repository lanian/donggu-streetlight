const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = path.resolve(__dirname, '../../app/map-layers.js');

function evented(obj = {}) {
  const handlers = new Map();
  obj.on = (type, fn) => { for (const t of type.split(' ')) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); } return obj; };
  obj.off = (type, fn) => { if (!type) handlers.clear(); else for (const t of type.split(' ')) { if (fn) handlers.get(t)?.delete(fn); else handlers.delete(t); } return obj; };
  obj.fire = (type, data = {}) => { for (const fn of [...(handlers.get(type) || [])]) fn({ ...data, type, target: obj }); return obj; };
  obj.listeners = type => [...(handlers.get(type) || [])];
  return obj;
}
function harness(config = { apiKey: 'browser-only-fake-key', maxNativeZoom: 18 }, saved) {
  assert.ok(fs.existsSync(source), 'map-layer controller must exist');
  const store = new Map(saved ? [['dg-map-background-v1', saved]] : []), writes = [], controls = [];
  function element(tag) {
    return { tagName: tag, children: [], listeners: new Map(), attributes: {}, hidden: false, appendChild(child) { this.children.push(child); return child; }, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, v) { this.listeners.set(k, v); }, removeEventListener(k, v) { if (this.listeners.get(k) === v) this.listeners.delete(k); } };
  }
  const panes = {}, mapContainer = element('div'); mapContainer.closest = () => null;
  const map = evented({ layers: new Set(), controls, center: [35.14, 126.92], zoom: 20, getContainer: () => mapContainer, getPane: name => panes[name], createPane: name => panes[name] = { style: {} }, setView() { throw new Error('background switch must not change view'); }, addLayer(l) { this.layers.add(l); l._map = this; l.onAdd?.(this); return this; }, removeLayer(l) { if (this.layers.delete(l)) { l.onRemove?.(this); l._map = null; } return this; } });
  const L = {
    layerGroup() { const g = evented({ layers: [], addTo(m) { m.addLayer(this); return this; }, remove() { this._map?.removeLayer(this); return this; }, addLayer(l) { this.layers.push(l); if (this._map) this._map.addLayer(l); return this; }, clearLayers() { for (const l of this.layers) this._map?.removeLayer(l); this.layers = []; return this; }, getLayers() { return this.layers.slice(); }, onAdd(m) { for (const l of this.layers) m.addLayer(l); }, onRemove(m) { for (const l of this.layers) m.removeLayer(l); } }); return g; },
    tileLayer(url, options) { return evented({ _url: url, options }); },
    control(options) { return { options, addTo(m) { this._map = m; this.element = this.onAdd(m); controls.push(this); return this; }, remove() { if (this._map) { this.onRemove?.(this._map); controls.splice(controls.indexOf(this), 1); this._map = null; } return this; } }; },
    DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {}, stopPropagation() {}, off() {} }
  };
  const outsideHandlers = new Set();
  const context = { document: { createElement: element, addEventListener(type, fn) { if (type === 'click') outsideHandlers.add(fn); }, removeEventListener(type, fn) { if (type === 'click') outsideHandlers.delete(fn); } }, DONGGU_SATELLITE_CONFIG: config, localStorage: { getItem: k => store.get(k) || null, setItem: (k, v) => { store.set(k, v); writes.push([k, v]); } } };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), context);
  const street = { urlTemplate: 'https://street.invalid/{z}/{x}/{y}.png', attribution: 'Street credit', maxZoom: 21 };
  return { ...context, L, map, panes, mapContainer, store, writes, controls, outsideHandlers, create(extra) { return context.DongguMapLayers.create(L, street, extra); } };
}
function picker(box) { const [toggle, panel] = box.children, [label, note] = panel.children; return { toggle, panel, label, select: label.children[1], note }; }

test('unconfigured imagery stays on ordinary map with disabled explained choices', () => {
  const h = harness({ apiKey: '' }, 'hybrid'), group = h.create().addTo(h.map);
  assert.equal(group.getMode(), 'street'); assert.equal(group.getLayers().length, 1);
  const { toggle, panel, label, select, note } = picker(h.controls[0].element);
  assert.equal(toggle.attributes['aria-expanded'], 'false'); assert.equal(panel.hidden, true);
  assert.equal(label.children[0].textContent, '지도 배경'); assert.equal(select.attributes['aria-label'], '지도 배경');
  assert.deepEqual(select.children.map(o => !!o.disabled), [false, true, true]); assert.match(note.textContent, /연결 준비 중/);
  group.setMode('satellite'); assert.equal(group.getMode(), 'street'); assert.equal(h.writes.length, 0);
});

test('three modes create exactly ordinary, imagery, or imagery and labels without changing map state', () => {
  const h = harness(), group = h.create({ maxZoom: 22 }).addTo(h.map), marker = {}, route = {}, gps = {}, editor = {};
  for (const item of [marker, route, gps, editor]) h.map.addLayer(item);
  const changes = []; group.on('mapmodechange', e => changes.push(e.mode));
  group.setMode('satellite'); assert.equal(group.getLayers().length, 1); assert.match(group.getLayers()[0]._url, /\/Satellite\/\{z\}\/\{y\}\/\{x\}\.jpeg$/);
  group.setMode('hybrid'); assert.equal(group.getLayers().length, 2); assert.match(group.getLayers()[1]._url, /\/Hybrid\/.*\.png$/);
  for (const layer of group.getLayers()) { assert.equal(layer.options.maxZoom, 22); assert.equal(layer.options.maxNativeZoom, 18); assert.equal(layer.options.offlineAllowed, false); }
  assert.notEqual(group.getLayers()[0].options.pane, 'tilePane');
  assert.equal(h.panes[group.getLayers()[0].options.pane].style.filter, 'none');
  assert.ok(group.getLayers()[1].options.zIndex > group.getLayers()[0].options.zIndex);
  group.setMode('street'); assert.equal(group.getLayers()[0].options.attribution, 'Street credit');
  assert.equal(h.map.zoom, 20); assert.deepEqual(h.map.center, [35.14, 126.92]);
  for (const item of [marker, route, gps, editor]) assert.ok(h.map.layers.has(item));
  assert.deepEqual(changes, ['satellite', 'hybrid', 'street']);
});

test('key is a safely encoded single URL segment and invalid keys never reach imagery URLs', () => {
  const h = harness({ apiKey: 'a/b?c#d%{}' }), group = h.create(); group.setMode('satellite');
  assert.equal(group.getLayers()[0]._url, 'https://api.vworld.kr/req/wmts/1.0.0/a%2Fb%3Fc%23d%25%7B%7D/Satellite/{z}/{y}/{x}.jpeg');
  group.setMode('hybrid'); assert.equal(group.getLayers()[1]._url, 'https://api.vworld.kr/req/wmts/1.0.0/a%2Fb%3Fc%23d%25%7B%7D/Hybrid/{z}/{y}/{x}.png');
  for (const apiKey of [' ', 'bad\nkey', 'bad\u007fkey', 'bad\u0085key', '.', '..', 'a'.repeat(257), 42, '\ud800']) {
    const x = harness({ apiKey }), g = x.create(); g.setMode('hybrid'); assert.equal(g.getMode(), 'street');
  }
});

test('only valid manual display selections persist and a saved mode initializes each new map', () => {
  const h = harness(), group = h.create().addTo(h.map); group.setMode('hybrid');
  assert.deepEqual(h.writes, [['dg-map-background-v1', 'hybrid']]); group.setMode('wrong'); assert.equal(group.getMode(), 'hybrid');
  assert.equal(h.create().getMode(), 'hybrid'); assert.equal(h.writes.length, 1);
  assert.equal(harness(undefined, '{"secret":"not-a-mode"}').create().getMode(), 'street');
});

test('current generation fourth consecutive imagery failure falls back while keeping saved preference and view', () => {
  const h = harness(), group = h.create().addTo(h.map), changes = [], errors = [];
  group.on('mapmodechange', e => changes.push({ mode: e.mode, reason: e.reason })); group.on('tileerror', e => errors.push(e));
  group.setMode('hybrid'); const [image, labels] = group.getLayers();
  image.fire('tileerror'); image.fire('tileerror'); image.fire('tileload');
  image.fire('tileerror'); image.fire('tileerror'); image.fire('tileerror'); assert.equal(group.getMode(), 'hybrid');
  image.fire('tileerror', { error: new Error('raw key URL'), tile: { src: 'secret' } }); assert.equal(group.getMode(), 'street');
  assert.equal(h.store.get('dg-map-background-v1'), 'hybrid'); assert.match(picker(h.controls[0].element).note.textContent, /일반 지도/);
  assert.deepEqual(changes.at(-1), { mode: 'street', reason: 'tile-failure' }); assert.equal(errors.at(-1).error, undefined); assert.equal(errors.at(-1).tile, undefined);
});

test('Hybrid imagery success cannot hide four consecutive label failures', () => {
  const h = harness(), group = h.create().addTo(h.map); group.setMode('hybrid'); const [image, labels] = group.getLayers();
  for (let i = 0; i < 4; i++) { image.fire('tileload'); labels.fire('tileerror'); }
  assert.equal(group.getMode(), 'street'); assert.equal(h.store.get('dg-map-background-v1'), 'hybrid');
});

test('late prior-mode and disposed events and detached controls cannot mutate mode or preferences', () => {
  const h = harness(), group = h.create().addTo(h.map); group.setMode('satellite');
  const image = group.getLayers()[0], lateError = image.listeners('tileerror')[0];
  group.setMode('hybrid'); for (let i = 0; i < 9; i++) lateError({}); assert.equal(group.getMode(), 'hybrid');
  const lateCurrent = group.getLayers()[0].listeners('tileerror')[0], select = picker(h.controls[0].element).select, lateChange = select.listeners.get('change');
  assert.equal(h.outsideHandlers.size, 1);
  group.remove(); const count = h.writes.length;
  assert.equal(h.controls.length, 0); assert.equal(select.listeners.size, 0); assert.equal(group.getLayers().length, 0);
  assert.equal(h.outsideHandlers.size, 0, 'removing a map retires its document dismissal handler');
  select.value = 'street'; lateChange(); for (let i = 0; i < 9; i++) lateCurrent({}); group.setMode('street');
  assert.equal(group.getMode(), 'hybrid'); assert.equal(h.writes.length, count);
  group.addTo(h.map); assert.equal(group.getLayers().length, 2); assert.equal(h.controls.length, 1);
  assert.equal(h.outsideHandlers.size, 1, 'reattachment owns exactly one document dismissal handler');
});

test('unavailable localStorage does not block maps or manual switching', () => {
  const h = harness(); h.localStorage.getItem = h.localStorage.setItem = () => { throw new Error('blocked'); };
  const group = h.create().addTo(h.map); group.setMode('hybrid'); assert.equal(group.getMode(), 'hybrid');
});

test('a detached editor container rejects late tile errors, control changes and explicit mode changes', () => {
  const h = harness(), group = h.create().addTo(h.map); group.setMode('hybrid');
  const image = group.getLayers()[0], error = image.listeners('tileerror')[0], select = picker(h.controls[0].element).select, change = select.listeners.get('change'), writes = h.writes.length;
  h.mapContainer.isConnected = false; for (let i = 0; i < 8; i++) error({}); select.value = 'street'; change(); group.setMode('street');
  assert.equal(group.getMode(), 'hybrid'); assert.equal(h.writes.length, writes); assert.equal(group.getLayers().length, 2);
});
