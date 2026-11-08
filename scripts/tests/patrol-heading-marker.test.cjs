const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../app/staff-app.js'), 'utf8');
function originalFunction(name) {
  const start = source.search(new RegExp('^function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, 'original ' + name + ' exists');
  const end = source.indexOf('\n}', start);
  assert.ok(end >= start, 'original ' + name + ' closes');
  return source.slice(start, end + 2);
}
const normalize = angle => ((angle % 360) + 360) % 360;
const difference = (a, b) => Math.abs(((normalize(a - b) + 180) % 360) - 180);
function rotation(style) { return style.transform ? Number(/rotate\(([-\d.]+)deg\)/.exec(style.transform)[1]) : 0; }
function composedBearing(...angles) {
  // The car triangle initially points up. Compose the actual parent and local CSS rotations on its direction vector.
  let x = 0, y = -1;
  for (const angle of angles) { const r = angle * Math.PI / 180; [x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]; }
  return normalize(Math.atan2(x, -y) * 180 / Math.PI);
}
function fixture(headUp, follow) {
  const car = { style: {} }, north = { style: {} };
  const box = { clientWidth: 360, clientHeight: 240, style: { setProperty() {} } };
  const plate = { style: {}, dataset: {}, parentElement: box };
  const pt = { mapOn: true, headUp, mapFollow: follow, heading: 0, pos: { lat: 35.15, lng: 126.92 }, track: [{ lat: 35.15, lng: 126.92 }, { lat: 35.1501, lng: 126.9201 }], marks: [], spots: [], passed: new Map(), ahead: [],
    map: { invalidateSize() {}, getZoom: () => 17, project: () => ({ add: value => value }), unproject: value => value, panTo() {} },
    mapMe: { setLatLng() {}, getElement: () => ({ querySelector: () => car }) }, mapTrack: { setLatLngs() {} }, mapLights: { clearLayers() {} }, mapMarks: { clearLayers() {} } };
  const context = vm.createContext({ pt, Math, Number, Map, Set, setTimeout: fn => fn(), $: selector => ({ '#ptMapRot': plate, '#ptMapBox': box, '#ptMapHeadUp i': north })[selector],
    DGPatrolHistory: { candidates: () => [] }, lightGrid: () => ({ toXY: () => ({ x: 0, y: 0 }), near: () => [] }), distM: () => 0 });
  vm.runInContext(originalFunction('ptMapRotate') + '\n' + originalFunction('ptMapDraw'), context);
  const snapshot = JSON.stringify({ pos: pt.pos, track: pt.track, marks: pt.marks, spots: pt.spots });
  return { pt, plate, car, draw(heading) { pt.heading = heading; context.ptMapDraw(true); assert.equal(JSON.stringify({ pos: pt.pos, track: pt.track, marks: pt.marks, spots: pt.spots }), snapshot, 'drawing cannot change GPS, track or saved observations'); return { screen: composedBearing(rotation(car.style), rotation(plate.style)), parent: rotation(plate.style), local: rotation(car.style) }; } };
}
for (const headUp of [true, false]) for (const follow of [true, false]) {
  test('original patrol draw composes the screen heading with headUp=' + headUp + ', follow=' + follow, () => {
    const f = fixture(headUp, follow);
    for (const heading of [0, 90, 180, 270, 359, 1]) {
      const actual = f.draw(heading), expected = headUp && follow ? 0 : heading;
      assert.ok(difference(actual.screen, expected) < 0.000001, JSON.stringify({ heading, headUp, follow, expectedScreen: expected, ...actual }));
    }
  });
}
test('359 to 1 and back takes the short parent rotation while the composed car stays up', () => {
  const f = fixture(true, true), before = f.draw(359), after = f.draw(1), back = f.draw(359);
  assert.equal(after.parent - before.parent, -2);
  assert.equal(back.parent - after.parent, 2);
  assert.equal(after.local - before.local, 2, 'car transition counters the short parent arc, rather than spinning 358 degrees');
  assert.equal(back.local - after.local, -2);
  for (const state of [before, after, back]) assert.ok(difference(state.screen, 0) < 0.000001, JSON.stringify(state));
});
test('unknown heading draws a neutral car without changing the stored position or track', () => {
  for (const headUp of [true, false]) for (const follow of [true, false]) {
    const actual = fixture(headUp, follow).draw(null); assert.equal(actual.screen, 0); assert.equal(actual.parent, 0); assert.equal(actual.local, 0);
  }
});
