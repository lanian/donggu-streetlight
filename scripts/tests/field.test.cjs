const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'data/lights.json'), 'utf8'));
const lights = registry.rows.map(row => ({
  ...Object.fromEntries(registry.cols.map((key, i) => [key, row[i]])), status: '정상'
}));
const printable = lights.filter(l => !l.removed && !l.noPlate && l.code);

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
  }), ['stopMediaStream', 'stopCam', 'startCam']);
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
