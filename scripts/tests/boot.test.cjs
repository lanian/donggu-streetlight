const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'Missing source boundaries: ' + start);
  return source.slice(from, to);
}
const bootSource = between('async function boot(){', 'function setSync(');
const firebaseSource = between('async function fbBoot(cfg){', 'async function fbSignIn(');
const loaderSource = between('const SCRIPT_LOADS=new Map();', 'async function fsApp(');

test('configured Firebase failure renders a connection error and cannot fall back to local storage', async () => {
  const sync = [], view = { innerHTML: '' }, nav = { hidden: false };
  let localCalls = 0, registryLoads = 0;
  const sandbox = {
    window: { FIREBASE_CONFIG: { projectId: 'demo-donggu-streetlight', apiKey: 'offline-test-key' } },
    S: { canWrite: true, tab: 'inspect' }, db: { old: true }, user: { old: true },
    loadRegistry: async () => { registryLoads++; },
    fbBoot: async () => { throw new Error('offline SDK load'); },
    localDb: () => { localCalls++; throw new Error('Unexpected local fallback'); },
    setSync: (...args) => sync.push(args),
    can: () => true, FEATURES: { reports: false },
    $: selector => selector === '#view' ? view : null,
    document: { querySelectorAll: () => [], querySelector: () => nav },
    refreshAdminSection() {}, DongguPWA: { render() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    between('function vConnectionError(){', 'async function boot(){') +
    between('function render(){', 'function vNoAccess(){') + bootSource, sandbox
  );
  await vm.runInContext('boot()', sandbox);
  assert.equal(registryLoads, 1);
  assert.equal(localCalls, 0);
  assert.equal(sandbox.db, null);
  assert.equal(sandbox.user, null);
  assert.equal(sandbox.S.canWrite, false);
  assert.equal(sandbox.S.fbError, true);
  assert.notEqual(sandbox.S.me, 'local');
  assert.deepEqual(sync.at(-1), [false, '연결 실패']);
  assert.match(view.innerHTML, /공유 저장소에 연결하지 못했어요/);
  assert.match(view.innerHTML, /id="fbRetry"/);
  assert.equal(nav.hidden, true);
});

test('incomplete non-null Firebase configuration cannot silently activate local storage', async () => {
  for (const config of [{}, { apiKey: 'offline-test-key' }, { projectId: 'demo-donggu-streetlight' }, { projectId: '', apiKey: 'offline-test-key' }]) {
    let localCalls = 0, firebaseCalls = 0, rendered = 0;
    const sandbox = {
      window: { FIREBASE_CONFIG: config }, S: { canWrite: true }, db: null, user: null,
      loadRegistry: async () => {},
      fbBoot: async () => { firebaseCalls++; },
      localDb: () => { localCalls++; throw new Error('Unexpected local fallback'); },
      setSync() {}, render: () => { rendered++; }
    };
    vm.createContext(sandbox);
    vm.runInContext(bootSource, sandbox);
    await vm.runInContext('boot()', sandbox);
    assert.equal(localCalls, 0, JSON.stringify(config));
    assert.equal(firebaseCalls, 0, 'Invalid settings must fail before initializing Firebase');
    assert.equal(sandbox.db, null);
    assert.equal(sandbox.S.canWrite, false);
    assert.equal(sandbox.S.fbError, true);
    assert.equal(rendered, 1);
  }
});

test('an indefinitely pending profile write does not block Firebase cached listeners or metadata updates', async () => {
  const listeners = [], scripts = [], sync = [];
  let profileWrites = 0, unsubscribed = 0, rendered = 0;
  const neverAcknowledged = new Promise(() => {});
  const firestore = {
    enablePersistence: async options => { assert.equal(options.synchronizeTabs, true); },
    collection(name) {
      return {
        doc: () => ({ set: () => { profileWrites++; return neverAcknowledged; } }),
        orderBy() { return this; }, limit() { return this; },
        onSnapshot(options, next, error) { listeners.push({ name, options, next, error }); return () => {}; }
      };
    }
  };
  const auth = {
    currentUser: { uid: 'inspector-a', displayName: '점검자', email: 'staff@example.invalid' },
    setPersistence: async mode => { assert.equal(mode, 'local'); },
    onAuthStateChanged(callback) { queueMicrotask(callback); return () => { unsubscribed++; }; },
    getRedirectResult: async () => null
  };
  const sandbox = {
    window: { DG_DEVICE_TRUSTED: true }, S: {}, FB: null, db: null, user: null, dl: null,
    firebase: { apps: [{}], firestore: () => firestore, auth: () => auth },
    loadScript: async url => { scripts.push(url); },
    setSync: (...args) => sync.push(args),
    render: () => { rendered++; }, onLights() {}, ptIndex() {}, resolveNames() {}, dataChanged() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(firebaseSource, sandbox);
  let timer;
  try {
    await Promise.race([
      vm.runInContext('fbBoot({projectId:"demo-donggu-streetlight"})', sandbox),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Boot waited for the optional profile write')), 500); })
    ]);
  } finally { clearTimeout(timer); }
  assert.equal(profileWrites, 1);
  assert.equal(unsubscribed, 1);
  assert.equal(scripts.length, 3);
  assert.equal(sandbox.db, firestore);
  assert.equal(sandbox.S.me, 'inspector-a');
  assert.deepEqual(listeners.map(item => item.name), ['lights', 'inspections', 'reports', 'patrols', 'roles']);
  for (const item of listeners) assert.equal(item.options.includeMetadataChanges, true);
  const lightListener = listeners.find(item => item.name === 'lights');
  lightListener.next({ docs: [], metadata: { fromCache: true } });
  lightListener.next({ docs: [], metadata: { fromCache: false } });
  assert.deepEqual(sync, [[false, '오프라인'], [true, '실시간']]);
  assert.equal(rendered, 2);
});

test('App Check is activated before Firestore and shared mode leaves persistence disabled', async () => {
  const window = { DG_DEVICE_TRUSTED: false }, events = [];
  const firestore = { enablePersistence() { assert.fail('Shared devices cannot enable the persistent cache'); } };
  const auth = { currentUser: null, setPersistence: async mode => { assert.equal(mode, 'session'); }, onAuthStateChanged(callback) { queueMicrotask(callback); return () => {}; }, getRedirectResult: async () => null };
  const sandbox = { window, S: {}, FB: null, firebase: { apps: [{}], appCheck: () => ({ activate(key, refresh) { assert.equal(key, 'local-site-key'); assert.equal(refresh, true); events.push('app-check'); } }), firestore: () => { assert.equal(window.DG_APP_CHECK_ACTIVE, true); events.push('firestore'); return firestore; }, auth: () => auth }, loadScript: async () => {}, setSync() {}, render() {} };
  vm.createContext(sandbox); vm.runInContext(firebaseSource, sandbox);
  await vm.runInContext('fbBoot({projectId:"demo",appCheckSiteKey:"local-site-key"})', sandbox);
  assert.deepEqual(events, ['app-check', 'firestore']);
});

function loader() {
  const elements = [];
  const sandbox = {
    document: {
      createElement(tag) {
        assert.equal(tag, 'script');
        return { removed: false, remove() { this.removed = true; } };
      },
      head: { appendChild(element) { elements.push(element); } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(loaderSource, sandbox);
  return { elements, load: url => sandbox.loadScript(url) };
}

test('concurrent script requests share one pending promise and one script element', async () => {
  const script = loader(), url = 'https://example.invalid/sdk.js';
  const first = script.load(url), second = script.load(url);
  assert.equal(first, second);
  assert.equal(script.elements.length, 1);
  let ready = false;
  first.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  script.elements[0].onload();
  await Promise.all([first, second]);
  assert.equal(ready, true);
  assert.equal(script.load(url), first);
  assert.equal(script.elements.length, 1);
});

test('a failed script load rejects all waiters and permits a clean retry', async () => {
  const script = loader(), url = 'https://example.invalid/sdk.js';
  const first = script.load(url), second = script.load(url);
  const firstRejected = assert.rejects(first, /load .*sdk\.js/);
  const secondRejected = assert.rejects(second, /load .*sdk\.js/);
  script.elements[0].onerror();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(script.elements[0].removed, true);
  const retry = script.load(url);
  assert.notEqual(retry, first);
  assert.equal(script.elements.length, 2);
  script.elements[1].onload();
  await retry;
  assert.equal(script.elements[1].removed, false);
});
