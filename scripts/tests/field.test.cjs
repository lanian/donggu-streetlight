const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const lightingReviewSource = fs.readFileSync(path.join(root, 'app/lighting-review.js'), 'utf8');
const source = lightingReviewSource + '\n' + fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'data/lights.json'), 'utf8'));
const lights = registry.rows.map(row => ({
  ...Object.fromEntries(registry.cols.map((key, i) => [key, row[i]])), status: '정상'
}));
const printable = lights.filter(l => !l.removed && !l.noPlate && l.code);
const field = require('../../app/field.js');
const lightingModel = require('../../app/lighting-model.js');

// Compile the actual application functions, without evaluating its boot code or contacting a backend.
function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing function: ${name}`);
  for (let end = source.indexOf('}', match.index); end >= 0; end = source.indexOf('}', end + 1)) {
    const candidate = source.slice(match.index, end + 1);
    try { new vm.Script(`(${candidate})`); return candidate; } catch (_) {}
  }
  throw new Error(`Cannot extract function: ${name}`);
}
function declaration(name) {
  const line = source.split('\n').find(s => new RegExp(`^(?:const|let) ${name}\\b`).test(s));
  assert.ok(line, `Missing declaration: ${name}`);
  return line;
}
function load(context, functions, declarations = []) {
  vm.runInContext(declarations.map(declaration).concat(functions.map(functionSource)).join('\n'), context);
  return context;
}
function qrContext(extra = {}) {
  return load(vm.createContext({
    S: { lights, reports: [], canWrite: true }, URLSearchParams,
    REPORT_URL: 'https://example.test/report/', ...extra
  }), ['plateRef', 'lookup', 'parseCode', 'parseTyped', 'parseCodeFuzzy', 'qrUrl', 'parsePole'],
  ['DONGS', 'DONGS_M', 'dongRe', 'codeOf', 'glCode', 'labelText', 'nrm', 'plateKey', 'isPlateDong', 'ROAD_RE', 'GL_RE']);
}
function reviewGrid(base = 0, managed = []) {
  const radians = Math.PI / 180, kx = 6371000 * radians * Math.cos(35.14 * radians), ky = 6371000 * radians;
  const toXY = p => ({ x: (p.lng - 126.93) * kx, y: (p.lat - 35.14) * ky });
  const items = managed.map(l => ({ l, ...toXY(l), on: l.status === '고장' ? 0 : 1, r: 20 }));
  return { items, toXY, toLL: (x, y) => ({ lat: 35.14 + y / ky, lng: 126.93 + x / kx }),
    near: (x, y, radius) => items.map(it => ({ it, d: Math.hypot(it.x - x, it.y - y) })).filter(n => n.d <= radius),
    lightAt: typeof base === 'function' ? base : () => base };
}
function lightingContext({ grid = reviewGrid(), records = [], ...extra } = {}) {
  const state = { lights: [], rvMinute: 1260, rvRevision: 0, ...extra.S };
  const lighting = { state: { records, loaded: true, error: '' },
    context: options => lightingModel.createContext(records, state.lights, options),
    classification: key => key, reason: key => key, categories: {}, levels: {},
    minuteText: minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0'),
    kstTime: time => String(time), recordSummary: record => record.label };
  const context = vm.createContext({
    DongguField: field, DGLightingModel: lightingModel, DGLighting: lighting,
    ROADS: { ways: [], areas: [] }, LIGHT_MODEL: { weak: .3, pairMax: {}, gapFactor: 1.15 },
    ROAD_SKIP_SERVICE: /^parking_aisle$/, ROAD_LABEL: {}, lightGrid: () => grid, inDong: () => true,
    document: { getElementById: () => null, addEventListener() {} }, window: {},
    closeSheet() {}, toast() {}, esc: String, onOf: l => l.status === '고장' ? 0 : 1,
    setTimeout() {}, clearTimeout() {}, ...extra, S: state
  });
  // Load the real review module, so helper changes are exercised without duplicating its logic.
  vm.runInContext(lightingReviewSource, context);
  return load(context, ['roadAreas']);
}
function lightingRecord(grid, kind, x, y, extra = {}) {
  return { id: kind + '-1', kind, label: kind === 'source' ? '별도 기관 조명' : '현장 관찰',
    category: kind === 'source' ? 'other_public' : 'field', operator: '', ...grid.toLL(x, y),
    radius: kind === 'source' ? 80 : 10, strength: 'medium', status: 'on', level: kind === 'source' ? 'unknown' : 'bright',
    schedule: 'hours', startMinute: 1080, endMinute: 360, observedAt: Date.now() - 1000,
    validDays: kind === 'source' ? 90 : 30, nightConfirmed: true, lux: null, instrument: '', note: '',
    linkedLightId: '', distinct: true, removed: false, ...extra };
}
function roadPoints(grid, points) { return points.map(([x, y]) => { const p = grid.toLL(x, y); return [p.lat, p.lng]; }); }
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function mediaStream() {
  const stream = { stopped: 0 };
  stream.getTracks = () => [{ stop() { stream.stopped++; } }];
  return stream;
}
function element() {
  return { hidden: false, srcObject: null, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {} }, setAttribute() {} };
}

test('every printable registry entry round-trips through the new QR URL, including special and duplicate labels', t => {
  const context = qrContext();
  assert.ok(printable.length > 0);
  for (const light of printable) {
    const url = context.qrUrl(light);
    const parsed = context.parseCode(url);
    assert.equal(context.lookup(parsed)?.id, light.id, `${light.id}: ${light.code}`);
    assert.equal(vm.runInContext('labelText', context)(parsed), light.code);
  }
  t.diagnostic(`${printable.length} printable registry entries resolved to their original IDs.`);
});

test('legacy c links, standard label text, and known special labels remain readable', () => {
  const context = qrContext();
  const samples = ['산수동 396', '운림동 공원등001', '황금동 신설'];
  for (const code of samples) {
    const light = lights.find(l => l.code === code && !l.removed);
    assert.ok(light, code);
    for (const input of [code, code.replace(/ /g, '  '), `https://example.test/report/?c=${encodeURIComponent(code)}`]) {
      assert.equal(context.lookup(context.parseCode(input))?.id, light.id, input);
    }
  }
  const conventional = context.parseCode('가로등 표찰 지호로 65-5');
  assert.equal(conventional.kind, '가로등');
  assert.equal(conventional.main, '65');
  assert.equal(conventional.sub, '5');
  const typed = context.parseTyped('642', '산수동');
  assert.equal(typed.dong, '산수동');
  assert.equal(typed.num, '642');
  assert.equal(context.parseCodeFuzzy('산수동 99999')?.num, '99999');
});

test('registry ID takes precedence over stale label text, and an unknown ID never selects a different light', () => {
  const context = qrContext();
  const light = printable[0];
  const url = `https://example.test/report/?c=${encodeURIComponent(printable[1].code)}&lid=${encodeURIComponent(light.id)}`;
  assert.equal(context.lookup(context.parseCode(url))?.id, light.id);
  assert.equal(context.parseCode(`https://example.test/report/?c=${encodeURIComponent(light.code)}&lid=missing-registry-id`), null);
});

test('live QR and photo QR preserve the selected ID even when two lights share the same label', () => {
  const pair = [{ ...printable[0], id: 'duplicate-a' }, { ...printable[0], id: 'duplicate-b' }];
  const overlay = element();
  let photoResult;
  const context = qrContext({
    S: { lights: pair, reports: [], canWrite: true },
    scan: { ctx: 'inspect', liveKey: null }, $: selector => selector === '#camOv' ? overlay : null,
    navigator: {}, esc: value => String(value ?? ''), kindBadge: () => '', fmtD: () => '',
    isDue: () => false, stopCam() {}, showScanResult: value => { photoResult = value; }
  });
  load(context, ['onLive', 'onDecoded']);
  for (const light of pair) {
    const url = context.qrUrl(light);
    context.onLive(url);
    assert.equal(context.lookup(context.scan.found.code)?.id, light.id);
    context.onDecoded(url, 'qr');
    assert.equal(context.lookup(photoResult.code)?.id, light.id);
  }
});

function inboxContext() {
  const nodes = Object.fromEntries(['ibNum', 'ibLoc', 'ibDesc', 'ibVia', 'ibRc', 'ibContact']
    .map(id => ['#' + id, { id, value: '', dataset: {} }]));
  const saved = [];
  let onInput;
  const context = qrContext({
    S: { lights: [...lights], reports: [], canWrite: true, me: 'staff' },
    scan: { ctx: 'inbox', found: null, active: true },
    $: selector => nodes[selector],
    document: {
      querySelector: () => ({ dataset: { ibissue: '꺼짐' } }),
      addEventListener: (type, callback) => { if (type === 'input') onInput = callback; }
    },
    byId: id => context.S.lights.find(l => l.id === id),
    stopCam() {}, closeSheet() {}, render() {}, openAdminSection() {}, toast() {},
    write: async operation => { await operation(); return true; },
    db: { collection: () => ({ add: async record => { saved.push(record); } }) }
  });
  load(context, ['applyScan', 'addInboxReport']);
  vm.runInContext(source.split('\n').find(line => line.startsWith('document.addEventListener("input",')), context);
  const scanToInbox = light => {
    context.scan.found = { code: context.parseCode(context.qrUrl(light)) };
    context.applyScan('inbox');
  };
  return { context, nodes, saved, scanToInbox, input: () => onInput({ target: nodes['#ibNum'] }) };
}

test('QR to staff inbox preserves both actual registry entries named 금동 112', async () => {
  const pair = printable.filter(l => l.code === '금동 112');
  assert.equal(pair.length, 2);
  for (const light of pair) {
    const inbox = inboxContext();
    inbox.scanToInbox(light);
    assert.equal(inbox.nodes['#ibNum'].value, light.code);
    await inbox.context.addInboxReport({});
    assert.equal(inbox.saved[0].lightId, light.id);
  }
});

test('editing an inbox plate clears its scanned identity and saves the edited plate', async () => {
  const scanned = printable.find(l => l.id === 'p2576947');
  const edited = printable.find(l => l.code === '산수동 396');
  assert.ok(scanned && edited);
  for (const dispatchInput of [true, false]) {
    const inbox = inboxContext();
    inbox.scanToInbox(scanned);
    inbox.nodes['#ibNum'].value = edited.code;
    if (dispatchInput) {
      inbox.input();
      assert.equal(inbox.nodes['#ibNum'].dataset.lightId, undefined);
    }
    await inbox.context.addInboxReport({});
    assert.equal(inbox.saved[0].lightId, edited.id);
  }
});

test('an inbox scan whose registry ID disappears cannot fall back to the other duplicate', async () => {
  const light = printable.find(l => l.id === 'p2576947');
  assert.ok(light);
  const inbox = inboxContext();
  inbox.scanToInbox(light);
  inbox.context.S.lights = inbox.context.S.lights.filter(l => l.id !== light.id);
  await inbox.context.addInboxReport({});
  assert.equal(inbox.saved[0].lightId, null);
  assert.equal(inbox.saved[0].code, light.code);
});

test('AR target card is rebuilt when a selected light returns to the chosen range', () => {
  let inside = true;
  const light = { id: 'target', code: '테스트등', status: '정상', lat: 35, lng: 126 };
  const guide = { dataset: {}, innerHTML: '', querySelector(selector) {
    return this.innerHTML.includes(`class="${selector.slice(1)}"`) ? { style: {}, textContent: '' } : null;
  } };
  const layer = { innerHTML: '', querySelector: () => null, appendChild() {} };
  const context = load(vm.createContext({
    ar: { heading: 0, pos: {}, target: light.id, range: 100, markerKeys: null, pitch: 90, acc: 5 },
    arNear: () => inside ? [{ l: light, d: 20, b: 180 }] : [],
    $: selector => selector === '#arLayer' ? layer : selector === '#arGuide' ? guide : null,
    byId: () => light, distM: () => 200, AR_FOV: 62, angDiff: (a, b) => b - a, esc: String,
    navigator: {}, S: { canWrite: true }, repCount: () => 0, CSS: { escape: value => value },
    document: { createElement: () => ({ dataset: {}, className: '', textContent: '' }) }
  }), ['arDraw']);
  context.arDraw();
  assert.match(guide.innerHTML, /data-ar-open/);
  inside = false; context.arDraw();
  assert.match(guide.innerHTML, /범위 밖/);
  inside = true; context.arDraw();
  assert.doesNotMatch(guide.innerHTML, /범위 밖/);
  assert.match(guide.innerHTML, /data-ar-open/);
  assert.match(guide.innerHTML, /class="gdir"/);
});

function arContext(getUserMedia, play = async () => {}) {
  const video = { ...element(), play };
  const wrap = element();
  const counts = { watches: 0, orientationListeners: 0, clears: 0 };
  const context = load(vm.createContext({
    ar: {}, arBindGuide() {}, arCalCheck() {}, onHeading() {}, onPosition() {},
    $: selector => selector === '#arCam' ? video : selector === '#arwrap' ? wrap : null,
    navigator: { mediaDevices: { getUserMedia }, geolocation: {
      watchPosition() { return ++counts.watches; }, clearWatch() { counts.clears++; }
    } },
    window: { addEventListener() { counts.orientationListeners++; }, removeEventListener() {} },
    setInterval: () => 1, clearInterval() {}
  }), ['stopMediaStream', 'arStop', 'arStart']);
  return { context, video, counts };
}

test('closing AR while camera permission is pending stops the late stream and never starts GPS', async () => {
  const camera = deferred();
  const stream = mediaStream();
  const { context, counts, video } = arContext(() => camera.promise);
  const pending = context.arStart();
  context.arStop();
  camera.resolve(stream); await pending;
  assert.ok(stream.stopped > 0);
  assert.equal(context.ar.stream, null);
  assert.equal(video.srcObject, null);
  assert.equal(counts.watches, 0);
});

test('a stale AR camera request cannot replace the camera of a newer AR session', async () => {
  const first = deferred(), second = deferred();
  const oldStream = mediaStream(), newStream = mediaStream();
  let request = 0;
  const { context, counts } = arContext(() => (++request === 1 ? first : second).promise);
  const oldStart = context.arStart(), newStart = context.arStart();
  second.resolve(newStream); await newStart;
  first.resolve(oldStream); await oldStart;
  assert.ok(oldStream.stopped > 0);
  assert.equal(newStream.stopped, 0);
  assert.equal(context.ar.stream, newStream);
  assert.equal(counts.watches, 1);
  context.arStop();
  assert.ok(newStream.stopped > 0);
  assert.equal(counts.clears, 1);
});

test('closing AR while compass permission is pending prevents later sensor listeners and GPS', async () => {
  const permission = deferred();
  let asked = false;
  const stream = mediaStream();
  const { context, counts } = arContext(async () => stream);
  const orientation = { requestPermission() { asked = true; return permission.promise; } };
  context.DeviceOrientationEvent = orientation;
  context.window.DeviceOrientationEvent = orientation;
  const pending = context.arStart();
  for (let i = 0; i < 8 && !asked; i++) await Promise.resolve();
  assert.equal(asked, true);
  context.arStop(); permission.resolve('granted'); await pending;
  assert.ok(stream.stopped > 0);
  assert.equal(counts.orientationListeners, 0);
  assert.equal(counts.watches, 0);
});

function scannerContext(getUserMedia, play = async () => {}) {
  const video = { ...element(), play, readyState: 0 };
  const hint = element();
  const counts = { frames: 0 };
  const context = load(vm.createContext({
    scan: { stream: null, raf: 0, active: true }, scanCamRun: 0, LIVE_AUTO: true, live: {},
    $: selector => selector === '#cam' ? video : selector === '#camHint' ? hint : null,
    navigator: { mediaDevices: { getUserMedia } },
    document: { createElement: () => ({ getContext: () => ({}) }) }, window: {},
    requestAnimationFrame() { return ++counts.frames; }, cancelAnimationFrame() {}
  }), ['stopMediaStream', 'cancelScanPhoto', 'stopCam', 'startCam']);
  return { context, video, counts };
}

test('stopping the scanner before camera acquisition completes prevents a late animation loop', async () => {
  const camera = deferred();
  const stream = mediaStream();
  const { context, counts, video } = scannerContext(() => camera.promise);
  const pending = context.startCam(); context.stopCam();
  camera.resolve(stream); await pending;
  assert.ok(stream.stopped > 0);
  assert.equal(context.scan.stream, null);
  assert.equal(video.srcObject, null);
  assert.equal(counts.frames, 0);
});

test('stopping the scanner during video.play also prevents its animation loop', async () => {
  const playing = deferred(), enteredPlay = deferred();
  const stream = mediaStream();
  const { context, counts } = scannerContext(async () => stream, () => { enteredPlay.resolve(); return playing.promise; });
  const pending = context.startCam(); await enteredPlay.promise;
  assert.equal(context.scan.stream, stream);
  context.stopCam(); playing.resolve(); await pending;
  assert.ok(stream.stopped > 0);
  assert.equal(context.scan.stream, null);
  assert.equal(counts.frames, 0);
});

test('an active scanner still starts and stops its stream normally', async () => {
  const stream = mediaStream();
  const { context, counts } = scannerContext(async () => stream);
  await context.startCam();
  assert.equal(context.scan.stream, stream);
  assert.equal(counts.frames, 1);
  context.stopCam();
  assert.equal(context.scan.stream, null);
  assert.ok(stream.stopped > 0);
});

test('a late scanner GPS callback cannot change a closed or replacement scan', () => {
  let callback;
  const box = {};
  const context = load(vm.createContext({
    scan: { active: true, pos: null }, $: () => box,
    navigator: { geolocation: { getCurrentPosition(success) { callback = success; } } }
  }), ['scanLocate']);
  context.scanLocate(); context.scan.active = false;
  callback({ coords: { latitude: 35, longitude: 126, accuracy: 10 } });
  assert.equal(context.scan.pos, null);
  context.scan.active = true; context.scanLocate();
  context.scan = { active: true, pos: null };
  callback({ coords: { latitude: 35, longitude: 126, accuracy: 10 } });
  assert.equal(context.scan.pos, null);
});

test('switching away from patrol camera stops a request that finishes late', async () => {
  const camera = deferred();
  const stream = mediaStream();
  const video = { ...element(), play: async () => {} }, wrap = element();
  let draws = 0;
  const context = load(vm.createContext({
    pt: { on: true }, $: selector => selector === '#ptCam' ? video : selector === '#ptCamWrap' ? wrap : null,
    navigator: { mediaDevices: { getUserMedia: () => camera.promise } }, ptCamDraw() { draws++; }
  }), ['stopMediaStream', 'ptStopCam', 'ptCam']);
  const pending = context.ptCam(true); await context.ptCam(false);
  camera.resolve(stream); await pending;
  assert.ok(stream.stopped > 0);
  assert.equal(context.pt.stream, null);
  assert.equal(context.pt.camOn, false);
  assert.equal(video.srcObject, null);
  assert.equal(draws, 0);
});

function wakeSentinel() {
  const listeners = [];
  return { released: false, releaseCount: 0,
    addEventListener(type, listener) { if (type === 'release') listeners.push(listener); },
    async release() { this.released = true; this.releaseCount++; listeners.forEach(fn => fn()); }
  };
}
function wakeContext(request) {
  return load(vm.createContext({
    pt: { on: true, wake: null }, document: { visibilityState: 'visible' }, navigator: { wakeLock: { request } }
  }), ['ptWakeAcquire', 'ptWakeRelease']);
}

test('released wake locks are reacquired, and an old release event cannot clear a newer lock', async () => {
  const first = wakeSentinel(), second = wakeSentinel();
  let requests = 0;
  const context = wakeContext(async () => ++requests === 1 ? first : second);
  await context.ptWakeAcquire();
  assert.equal(context.pt.wake, first);
  await first.release();
  assert.equal(context.pt.wake, null);
  await context.ptWakeAcquire();
  assert.equal(context.pt.wake, second);
  await first.release();
  assert.equal(context.pt.wake, second);
  assert.equal(requests, 2);
});

test('finishing a patrol while its wake-lock request is pending releases the late lock', async () => {
  const request = deferred(), sentinel = wakeSentinel();
  const context = wakeContext(() => request.promise);
  const pending = context.ptWakeAcquire();
  context.pt.on = false; context.ptWakeRelease();
  request.resolve(sentinel); await pending;
  assert.equal(sentinel.releaseCount, 1);
  assert.equal(context.pt.wake, null);
});

test('visibility resume reacquires a released lock and does not duplicate a pending request', async () => {
  const request = deferred(), sentinel = wakeSentinel();
  let requests = 0, visibility, watches = 0;
  const context = wakeContext(() => { requests++; return request.promise; });
  context.pt.wake = { released: true };
  context.document.addEventListener = (type, callback) => { if (type === 'visibilitychange') visibility = callback; };
  context.ptWatch = () => { watches++; };
  context.ptListen = () => {};
  vm.runInContext(source.split('\n').find(line => line.startsWith('document.addEventListener("visibilitychange"')), context);
  visibility(); visibility();
  assert.equal(watches, 2);
  assert.equal(requests, 1);
  request.resolve(sentinel); await new Promise(setImmediate);
  assert.equal(context.pt.wake, sentinel);
});

test('long-axis tilt is invariant under rotation around a vertical phone, including landscape display', () => {
  for (const gamma of [-80, -30, 0, 30, 80]) assert.ok(Math.abs(field.longAxisTilt(90, gamma)) < 1e-5);
  assert.ok(Math.abs(field.longAxisTilt(85, 30) - 5) < 1e-6);
  assert.equal(field.longAxisTilt(0, 0), 90);
  assert.equal(field.longAxis(390, 844, 0), 'y');
  assert.equal(field.longAxis(844, 390, 90), 'y');
  assert.equal(field.longAxis(1024, 768, 0), 'x');
  assert.ok(field.longAxisTilt(0, 90, 'x') < 1e-6);
});

test('tilt requires elapsed stability, supports a known vertical zero, and does not classify a fault automatically', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({ at: i * 50, v: field.gravityVector(89, 0) }));
  const reference = field.tiltWindow(samples);
  assert.equal(reference.stable, true);
  assert.equal(field.tiltWindow(samples.slice(0, 3)).stable, false);
  assert.equal(field.tiltWindow(samples.map((s, i) => ({ ...s, v: field.gravityVector(i % 2 ? 85 : 90, 0) }))).stable, false);
  assert.ok(field.tiltWindow(samples, reference.vector).value < 1e-6);
  const owner = { checks: {}, photos: [], result: null }, memo = { value: '' };
  const c = load(vm.createContext({ draft: owner, tilt: { owner, val: 3, stable: false, zero: reference.vector, spread: .1 }, TILT_WARN: 2, $: () => memo, toast() {}, stopTilt() {} }), ['keepTilt']);
  c.keepTilt(); assert.equal(owner.tilt, undefined);
  c.tilt.stable = true; c.keepTilt();
  assert.equal(owner.tilt, 3); assert.equal(owner.checks.pole, undefined); assert.equal(owner.result, null);
  assert.match(memo.value, /참고값.*영점/);
});

test('AR projects the physical rear camera with beta and gamma and does not add screen rotation', () => {
  assert.equal(field.cameraHeading(0, 90, 30), 330);
  assert.ok(Math.abs(field.cameraHeading(90, 90, 30) - 240) < 1e-6);
  assert.equal(field.cameraHeading(0, 0, 0), null);
  const c = load(vm.createContext({ DongguField: field,
    ar: { on: true, heading: null, offset: 0, lastDraw: 0 }, window: { ondeviceorientationabsolute: null },
    screen: { orientation: { angle: 90 } }, performance: { now: () => 1000 }, $: () => null,
    arDraw() {}, arCalCheck() {}, toRad: v => v * Math.PI / 180, angDiff: (a, b) => (b - a + 540) % 360 - 180
  }), ['onHeading']);
  c.onHeading({ type: 'deviceorientationabsolute', alpha: 0, beta: 90, gamma: 30, absolute: true });
  assert.equal(c.ar.heading, 330);
  c.onHeading({ type: 'deviceorientationabsolute', alpha: 0, beta: 0, gamma: 0, absolute: true });
  assert.equal(c.ar.heading, null);
});

test('road review length and score are independent of OSM vertex density and include short tails', () => {
  const grid = reviewGrid(), c = lightingContext({ grid });
  const check = points => { c.ROADS.ways = [{ name: 'road', type: 'residential', pts: roadPoints(grid, points) }]; return c.roadReview('전체', '전체')[0]; };
  const coarse = check([[0, 0], [24, 0]]), dense = check(Array.from({ length: 13 }, (_, i) => [i * 2, 0]));
  assert.equal(coarse.len, 24); assert.equal(dense.len, 24); assert.ok(Math.abs(coarse.score - dense.score) < 1e-6);
  assert.equal(check([[0, 0], [29, 0]]).len, 29);
  const samples = field.sampleLine([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 5 }]);
  assert.equal(samples.reduce((s, p) => s + p.length, 0), 8);
});

test('OSM relation fragments join in either direction, exclude inner holes, and reject open chains', () => {
  const g = coords => coords.map(([lat, lon]) => ({ lat, lon }));
  const member = (coords, role = 'outer') => ({ type: 'way', role, geometry: g(coords) });
  const members = [member([[10, 10], [0, 10]]), member([[0, 0], [10, 0]]), member([[10, 0], [10, 10]]), member([[0, 10], [0, 0]]), member([[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]], 'inner')];
  const result = field.relationPolygons(members);
  assert.equal(result.incomplete, 0); assert.equal(result.polygons.length, 1);
  assert.equal(field.inPolygon(2, 2, result.polygons[0]), true);
  assert.equal(field.inPolygon(5, 5, result.polygons[0]), false);
  const open = field.relationPolygons(members.slice(0, 3));
  assert.equal(open.polygons.length, 0); assert.ok(open.incomplete > 0);
});

test('road area holes remain eligible for review, and administrative-dong map filters retain legal-dong lamps', () => {
  const area = { t: 'forest', pts: [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]], holes: [[[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]]] };
  const c = load(vm.createContext({ DongguField: field, ROADS: { areas: [area] } }), ['roadAreas']);
  const projected = c.roadAreas({ toXY: ({ lat, lng }) => ({ x: lng, y: lat }) })[0];
  assert.equal(field.inPolygon(2, 2, projected), true); assert.equal(field.inPolygon(5, 5, projected), false);
  let lampCircles = 0, candidateMarkers = 0;
  const layer = () => ({ addTo() { return this; }, on() { return this; }, bindPopup() { return this; }, pad() { return this; } });
  const L = { map: () => ({ fitBounds() {} }), layerGroup: layer,
    circle() { lampCircles++; return layer(); }, circleMarker() { candidateMarkers++; return layer(); },
    marker: layer, polyline: layer, divIcon: x => x, latLngBounds: layer };
  const l = { id: 'one', lat: 35, lng: 126, dong: '금동', status: '정상' };
  const context = { base: 0, adjusted: 0, external: 0, classification: 'model_weak',
    coverage: { total: 24, bright: 0, dark: 0, conflict: 0, external: 0, unobserved: 24, unit: 'm' }, sources: [], hints: [], observations: [] };
  const candidate = { name: 'road', pts: [l], mid: l, near: [l], len: 24, E: 0, context };
  const map = lightingContext({ S: { review: { mode: 'roads', dong: 'a:충장동', cands: [candidate], inputRevision: 0, validUntil: Infinity, minute: 1260 }, lights: [l, { ...l, id: 'other', dong: '지원동' }] },
    inDong: (x, d) => x.dong === '금동' && d === 'a:충장동',
    $: () => null, openSheet() {}, window: { L }, L, DongguPWA: { tileLayer: layer }, gmap: null, gmapLayer: null, gmapPts: [],
    meStop() {}, setTimeout() {}, onOf: () => 1, reachOf: () => 20, kindBadge: () => '', esc: String
  });
  map.openReviewMap('all'); assert.equal(lampCircles, 1); assert.equal(candidateMarkers, 1);
});

test('partial roadside field circles never classify the whole road as observed bright', () => {
  const grid = reviewGrid(), records = [4, 12, 20].map((y, i) => lightingRecord(grid, 'observation', 4.9, y, { id: 'obs-' + i, radius: 5 }));
  const c = lightingContext({ grid, records });
  c.ROADS.ways = [{ name: 'road', type: 'residential', pts: roadPoints(grid, [[0, 0], [0, 24]]) }];
  const result = c.roadReview('전체', '전체')[0];
  assert.equal(result.len, 24); assert.equal(result.context.classification, 'partial_supported');
  assert.ok(Math.abs(result.context.coverage.bright - 3 * 2 * Math.sqrt(25 - 4.9 ** 2)) < .001);
  assert.ok(result.context.coverage.unobserved > 18); assert.equal(result.context.adjusted, 0);
});

test('circle coverage follows original road vertices instead of the chord of a turning 8 m fragment', () => {
  const grid = reviewGrid(), record = lightingRecord(grid, 'observation', -4.9, 0, { radius: 5 });
  const c = lightingContext({ grid, records: [record] });
  c.ROADS.ways = [{ name: 'turning road', type: 'residential', pts: roadPoints(grid, [[0, 0], [4, 0], [0, 0], [4, 0], [0, 0], [4, 0], [0, 0]]) }];
  const result = c.roadReview('전체', '전체')[0];
  assert.equal(result.len, 24); assert.equal(result.context.classification, 'partial_supported');
  assert.ok(Math.abs(result.context.coverage.bright - .6) < .001);
  assert.ok(result.context.coverage.unobserved > 23);
});

test('evidence-circle subdivision cannot move the road midpoint or change its administrative filter', () => {
  const grid = reviewGrid(), records = [], c = lightingContext({ grid, records });
  c.ROADS.ways = [{ name: 'road', type: 'residential', pts: roadPoints(grid, [[0, 0], [0, 80]]) }];
  c.ROADS.bounds = [{ name: 'selected', polygons: [{ outer: roadPoints(grid, [[-10, 30], [10, 30], [10, 90], [-10, 90], [-10, 30]]), holes: [] }] }];
  const before = c.roadReview('전체', '전체')[0];
  assert.equal(c.roadReview('a:selected', '전체').length, 1);
  for (let i = 0; i < 10; i++) records.push(lightingRecord(grid, 'observation', 4.9, 1 + i * 2, { id: 'obs-' + i, radius: 5 }));
  const after = c.roadReview('전체', '전체')[0];
  assert.ok(Math.abs(grid.toXY(after.mid).y - grid.toXY(before.mid).y) < .001);
  assert.ok(Math.abs(grid.toXY(after.mid).y - 40) < .001);
  assert.equal(c.roadReview('a:selected', '전체').length, 1);
});

test('separate dark observations remain candidates even where the registry model is bright and no road qualifies', () => {
  const grid = reviewGrid(1), records = [0, 100].map((x, i) => lightingRecord(grid, 'observation', x, 0, { id: 'dark-' + i, level: 'dark', radius: 5 }));
  const c = lightingContext({ grid, records });
  for (const candidates of [c.roadReview('전체', '전체'), c.lightReview('전체', '전체')]) {
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(x => x.point && x.context.classification === 'observed_dark' && x.context.base === 1));
  }
  c.ROADS.ways = [{ name: 'private path', type: 'service', priv: true, pts: roadPoints(grid, [[0, 0], [24, 0]]) }];
  assert.equal(c.roadReview('전체', '전체').length, 2);
});

test('operating hours change supplemental evidence while retaining the same registry-model candidates', () => {
  const grid = reviewGrid(), c = lightingContext({ grid, records: [lightingRecord(grid, 'source', 12, 0)] });
  c.ROADS.ways = [{ name: 'road', type: 'residential', pts: roadPoints(grid, [[0, 0], [24, 0]]) }];
  const night = c.roadReview('전체', '전체');
  assert.equal(night.length, 1); assert.equal(night[0].context.classification, 'external_supported');
  c.S.review = { cands: night }; assert.equal(c.rvList(c.S.review).length, 1);
  c.S.rvMinute = 720; const day = c.roadReview('전체', '전체');
  assert.equal(day.length, 1); assert.equal(day[0].context.external, 0);
  assert.equal(day[0].context.base, night[0].context.base);
  assert.equal(day[0].context.hints[0].reason, 'outside_schedule');
});

test('expired review snapshots cannot be mapped, exported or copied into facility registration', async () => {
  let downloaded = 0, opened = 0, copied = 0, messages = 0;
  const c = lightingContext({ dl: { save() { downloaded++; } }, openSheet() { opened++; },
    openAdminSection() { copied++; }, toast() { messages++; }, $() { assert.fail('expired reviews must not access a form'); } });
  const expired = () => { c.S.review = { cands: [], inputRevision: c.S.rvRevision, validUntil: Date.now() - 1 }; };
  expired(); c.openReviewMap('all'); assert.equal(c.S.review, null);
  expired(); await c.exportReviewCSV(); assert.equal(c.S.review, null);
  expired(); c.reviewToForm(0); assert.equal(c.S.review, null);
  assert.equal(downloaded, 0); assert.equal(opened, 0); assert.equal(copied, 0); assert.equal(messages, 3);
});

test('the review expiry timer refreshes an open result without a storage event', () => {
  let clock = 1000, callback, delay, rendered = 0, closed = 0;
  const c = lightingContext({ Date: { now: () => clock },
    document: { getElementById: () => ({}), addEventListener() {} },
    setTimeout(fn, ms) { callback = fn; delay = ms; return 1; }, clearTimeout() {},
    render() { rendered++; }, closeSheet() { closed++; } });
  c.S.review = { cands: [], inputRevision: 0, validUntil: 1100 };
  c.rvExpireAt(1100); assert.ok(delay >= 100 && delay <= 150);
  clock = 1120; callback();
  assert.equal(c.S.review, null); assert.equal(rendered, 1); assert.equal(closed, 1);
  c.S.review = { cands: [], inputRevision: c.S.rvRevision, validUntil: clock + 90 * 86400000 };
  c.rvExpireAt(c.S.review.validUntil); assert.ok(delay <= 2147483647);
});

test('late photo decoding cannot stop or write into a replacement scanner', async () => {
  const image = deferred(); let stopped = 0, results = 0;
  const old = { active: true, busy: false, ctx: 'inspect' };
  const c = load(vm.createContext({ scan: old, ocrState: {}, compressBlob: () => image.promise, $: () => null,
    stopCam() { stopped++; }, showScanResult() { results++; }, toast() {}, window: {},
  }), ['beginScanPhoto', 'readLabelPhoto']);
  const task = c.readLabelPhoto({ type: 'image/png' });
  const current = c.scan = { active: true, busy: true, ctx: 'inbox' };
  image.resolve({ canvas: {} }); await task;
  assert.equal(stopped, 1); assert.equal(results, 0); assert.equal(current.busy, true);
});

test('late OCR model loading and its progress cannot write or clear busy state in a new scanner', async () => {
  const model = deferred(); let progress, changed = 0, recognized = 0;
  const old = { active: true, busy: false };
  const c = load(vm.createContext({ scan: old, ocrState: { src: { width: 100, height: 100 } },
    $: () => null, findPlate: () => null, showStage() {}, cropTo: () => ({}), stageStatus() { changed++; },
    getOcr: callback => { progress = callback; return model.promise; }, showScanResult() { changed++; }
  }), ['beginScanPhoto', 'ocrLabel']);
  const task = c.ocrLabel(null, null);
  const current = c.scan = { active: true, busy: true };
  const previous = changed; progress({ status: 'recognizing text', progress: .5 });
  model.resolve({ recognize() { recognized++; } }); await task;
  assert.equal(changed, previous); assert.equal(recognized, 0); assert.equal(current.busy, true);
});

test('photo editor decode finishing after draft navigation does not create an editor', async () => {
  const decoded = deferred(); let closed = 0;
  const c = load(vm.createContext({ photoEditor: null, photoEditorRun: 0, decodeFile: () => decoded.promise, toast() {} }), ['cancelPhotoEditor', 'openPhotoEditor']);
  let current = true;
  const task = c.openPhotoEditor({}, { code: 'old', onDone() { assert.fail('old photo must not attach'); }, isCurrent: () => current });
  current = false; decoded.resolve({ close() { closed++; } });
  assert.equal(await task, false); assert.equal(closed, 1);
});

test('voice intents separate a failed lamp from an unlit place', () => {
  for (const text of ['꺼짐', '불이 없어', '불이 안 들어와', '고장']) assert.equal(field.voiceIntent(text), '고장');
  for (const text of ['여기', '여기 어두움', '등 없는 지점']) assert.equal(field.voiceIntent(text), 'spot');
  assert.equal(field.voiceIntent('깜빡여요'), '점검필요'); assert.equal(field.voiceIntent('켜져 있음'), '정상');
  assert.equal(field.voiceIntent('없어'), null); assert.equal(field.voiceIntent('취소'), 'undo');
});

test('uncertain GPS does not record passage; out-of-area faults stay available', () => {
  const lamps = ['동A', '동B'].map((dong, i) => ({ id: String(i), dong, status: '정상' }));
  const near = lamps.map((l, i) => ({ d: i + 1, it: { l, x: 0, y: i + 1 } }));
  const c = load(vm.createContext({ pt: { on: true, acc: null, last: null, track: [], passed: new Map(), spoken: new Set(), dong: '동A' },
    $: () => null, lightGrid: () => ({ toXY: () => ({ x: 0, y: 0 }), near: () => near }), ptDraw() {}, AR_FOV: 62, Date,
  }), ['ptPos']);
  c.ptPos({ coords: { latitude: 35, longitude: 126, accuracy: 40 } });
  assert.equal(c.pt.passed.size, 0); assert.equal(c.pt.ahead.length, 2);
  c.pt.last = null;
  c.ptPos({ coords: { latitude: 35, longitude: 126, accuracy: 10 } });
  assert.equal(c.pt.passed.size, 2); assert.deepEqual(Array.from(c.pt.ahead, a => a.l.dong), ['동A', '동B']);
});

test('a normal lamp can be explicitly observed lit and a patrol report never infers lighting from GPS', () => {
  const target = { id: 'normal', code: 'normal lamp', status: '정상' };
  const c = load(vm.createContext({ pt: { on: true, sel: target.id, marks: [], pos: null, dong: '전체' },
    byId: () => target, inDong: () => true, navigator: {}, toast() {}, ptDraw() {}, ptSay() {}, fmtDT: () => 'date'
  }), ['ptMark', 'ptReportText']);
  c.ptMark('정상'); assert.equal(c.pt.marks.length, 1);
  const report = c.ptReportText({ start: 1, end: 60001, passed: [], marks: c.pt.marks });
  assert.match(report, /GPS 통과 0개.*미확인/); assert.match(report, /직접 점등 확인 1건/); assert.doesNotMatch(report, /-1/);
});
