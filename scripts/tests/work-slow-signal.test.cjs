const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

// On a weak signal the server list can take a long time or fail. The work screen then offers the
// prepared field-kit copy directly, and opening a work from it never waits on the server.
const PREPARED = { preparedAt: Date.parse('2026-11-14T08:30:00+09:00'), works: [{ id: 'w1', title: '동명동 소등 조치', code: 'L-1', status: 'assigned', dueAt: null, lightId: 'a', revision: 3, assignedTo: 'kim' }] };

async function fixture({ mode = 'hang', kit = PREPARED } = {}) {
  const slowTimers = [], navigated = [], reopens = [], toasts = [], serverReads = [];
  const fakeTimeout = (fn, ms, ...args) => { if (ms === 8000) { slowTimers.push(fn); return slowTimers.length; } return setTimeout(fn, ms, ...args); };
  const ctx = vm.createContext({ console, Date, Math, TextEncoder, structuredClone, crypto: webcrypto, document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }, navigator: { onLine: true, locks: { request: async (_, fn) => fn() } }, setTimeout: fakeTimeout, clearTimeout, addEventListener() {}, confirm: () => true, DGOperationsCore: require(path.join(root, 'app/operations-core.js')), DGWorkCommands: require(path.join(root, 'app/work-commands.js')), DGSecurity: { safeImageSrc: s => s } });
  vm.runInContext(source('app/offline.js'), ctx);
  await ctx.DGOffline.configure({ namespace: 'fb/kim', durable: true, networkRequired: false, adapter: ctx.DGOffline.memoryStore() });
  ctx.DGFieldKit = {
    preparedWorks: () => kit && JSON.parse(JSON.stringify(kit)),
    record: async (collection, id) => collection === 'workOrders' && kit ? JSON.parse(JSON.stringify(kit.works.find(w => w.id === id) || null)) : null,
    forLight: async (collection, id) => kit && collection === 'reports' ? { rows: [], preparedAt: kit.preparedAt, scope: 'prepared-facility', coverage: 'active-and-work-linked' } : null
  };
  vm.runInContext(source('app/operations.js'), ctx);
  // mode 'ok' answers like a reachable server: an empty list page and the latest copy of w1.
  const answer = kind => mode === 'ok' ? Promise.resolve(kind === 'page' ? { rows: [], nextCursor: null, hasMore: false, source: 'server', complete: true, fetchedAt: Date.now() } : kind === 'doc' ? { exists: true, data: () => ({ ...PREPARED.works[0], title: '서버 최신 제목', revision: 5 }) } : []) : null;
  const server = kind => { serverReads.push(true); return answer(kind) || (mode === 'hang' ? new Promise(() => {}) : Promise.reject(Object.assign(new Error('연결할 수 없어요.'), { code: 'unavailable' }))); };
  const backend = { doc: () => ({ get: () => server('doc') }), collection: () => ({}) };
  const lights = [{ id: 'a', code: 'L-1', dong: '동명동' }];
  ctx.DGOperations.attach({ state: () => ({ me: 'kim', names: {}, roles: [], lights }), can: () => true, dongOptions: () => '', firebase: () => backend, database: () => backend, esc: v => String(v ?? ''), fmtDT: String, render() {}, toast: m => toasts.push(m), byId: id => lights.find(l => l.id === id), readAll: () => server('all'), readPage: () => server('page'), navigate: (html, opts) => { navigated.push(html); reopens.push(opts?.reopen); }, closeSheet() {} });
  return { ui: ctx.DGOperations, offline: ctx.DGOffline, navigated, reopens, toasts, serverReads, setMode: value => { mode = value; }, fireSlow: () => slowTimers.splice(0).forEach(fn => fn()) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a slow list shows the prepared works after 8 seconds and keeps waiting for the server', { timeout: 3000 }, async () => {
  const f = await fixture();
  f.ui.load(); await settle();
  assert.doesNotMatch(f.ui.view(), /연결이 느려/, 'no notice before the slow threshold');
  f.fireSlow();
  const html = f.ui.view();
  assert.match(html, /연결이 느려/);
  assert.match(html, /출동 자료/);
  assert.match(html, /data-dg="open-prepared-work" data-id="w1"/);
  assert.match(html, /동명동 소등 조치/);
});

test('a failed list on a weak signal shows the prepared works in place instead of pointing elsewhere', { timeout: 3000 }, async () => {
  const f = await fixture({ mode: 'fail' });
  await f.ui.load();
  const html = f.ui.view();
  assert.equal(f.ui.state.offlineError, true);
  assert.match(html, /data-dg="open-prepared-work" data-id="w1"/);
  assert.doesNotMatch(html, /관리 현황의 출동 자료에서 볼 수 있어요/);
});

test('without prepared works the screen explains how to prepare them', { timeout: 3000 }, async () => {
  const f = await fixture({ mode: 'fail', kit: null });
  await f.ui.load();
  const html = f.ui.view();
  assert.doesNotMatch(html, /open-prepared-work/);
  assert.match(html, /출동 자료 준비/);
});

test('opening a prepared work does not wait for the slow list or read the server', { timeout: 3000 }, async () => {
  const f = await fixture();
  f.ui.load(); await settle();
  const reads = f.serverReads.length;
  await f.ui.openWork('w1', undefined, { prepared: true });
  assert.equal(f.navigated.length, 1, 'the work detail opened');
  assert.match(f.navigated[0], /동명동 소등 조치/);
  assert.match(f.navigated[0], /출동 준비자료/, 'the detail says it is the prepared copy');
  assert.equal(f.serverReads.length, reads, 'no new server read before the detail opened');
});

// v80 review: a prepared copy is a snapshot; it must never stand in for newer data the device already has.
test('a prepared copy older than the saved completion input does not open over it or rewrite it', { timeout: 3000 }, async () => {
  const f = await fixture({ mode: 'fail' }); await f.ui.load();
  await f.offline.put('workCompletion', 'w1', { workId: 'w1', lightId: 'a', expectedRevision: 4, storageId: 'w1', note: '관리자 수정 뒤 입력', photos: [], existingPhotos: [], parts: [], measurements: [] });
  await f.ui.openWork('w1', undefined, { prepared: true });
  assert.equal(f.navigated.length, 0, 'the older copy is not opened');
  assert.match(f.toasts.join(' '), /연결된 뒤/);
  const kept = await f.offline.get('workCompletion', 'w1');
  assert.equal(kept.expectedRevision, 4); assert.equal(kept.note, '관리자 수정 뒤 입력');
});
test('going back to a prepared work after the list recovers shows the server copy', { timeout: 3000 }, async () => {
  const f = await fixture({ mode: 'fail' }); await f.ui.load();
  await f.ui.openWork('w1', undefined, { prepared: true });
  assert.match(f.navigated.at(-1), /동명동 소등 조치/);
  f.setMode('ok'); await f.ui.load(true); assert.equal(f.ui.state.error, '');
  await f.reopens.at(-1)();
  assert.match(f.navigated.at(-1), /서버 최신 제목/);
});
