'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const file = path.resolve(__dirname, '../../app/official-ledger-connector.js');
const Connector = fs.existsSync(file) ? require(file) : {};
const query = { from: '2026-11-08', to: '2026-11-09' };
const at = Date.parse('2026-11-08T11:00:00+09:00');
const clone = value => JSON.parse(JSON.stringify(value));
function profile(extra = {}) {
  return { schemaVersion: 1, name: '합성 명세', itemsPath: ['data', 'items'], totalPath: ['data', 'total'], cursorPath: ['data', 'nextCursor'], completePath: ['data', 'complete'], fields: { externalId: ['ticketId'], lampId: ['assetId'], issue: ['fault'], receivedAt: ['received'], sourceStatus: ['state'] }, issueMap: { DARK: 'off', FLICKER: 'flicker' }, statusMap: { NEW: 'received', WORKING: 'processing', DONE: 'completed', CANCELLED: 'cancelled' }, timeEncoding: 'iso', ...extra };
}
const source = (extra = {}) => ({ ticketId: 'LEDGER-001', assetId: '0007', fault: 'DARK', received: '2026-11-08T11:00:00+09:00', state: 'NEW', ...extra });
const page = (items = [source()], extra = {}) => ({ data: { items, total: items.length, nextCursor: null, complete: true, ...extra } });
const options = readPage => ({ readPage, profile: profile(), isCurrent: () => true });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('query dates use explicit KST inclusive bounds and reject impossible or ambiguous periods', () => {
  assert.deepEqual(Connector.validateQuery(query), { from: query.from, to: query.to, fromAt: Date.parse('2026-11-08T00:00:00+09:00'), toAt: Date.parse('2026-11-09T23:59:59.999+09:00') });
  assert.equal(Connector.validateQuery({ from: '2024-02-29', to: '2024-02-29' }).toAt - Connector.validateQuery({ from: '2024-02-29', to: '2024-02-29' }).fromAt, 86400000 - 1);
  for (const bad of [{ from: '2026-02-31', to: query.to }, { from: '2026-11-10', to: query.to }, { from: '11/08/2026', to: query.to }, { from: query.from, to: '' }]) assert.throws(() => Connector.validateQuery(bad));
});

test('an explicit page mapping normalizes only the five minimum fields and drops private extras', () => {
  const input = page([source({ name: 'PRIVATE-NAME', phone: 'PRIVATE-CONTACT', note: 'PRIVATE-NOTE', photo: 'PRIVATE-PHOTO' })]);
  const out = Connector.adaptPage(input, profile());
  assert.deepEqual(out.rows, [{ externalId: 'LEDGER-001', lampId: '0007', issue: '불이 꺼져 있어요', receivedAt: at, sourceStatus: 'received' }]);
  assert.equal(out.ignoredFieldCount, 4); assert.equal(out.total, 1); assert.equal(out.nextCursor, null); assert.equal(out.complete, true);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|phone|photo|note/); assert.equal(input.data.items[0].name, 'PRIVATE-NAME');
});

test('nested paths work without invoking unmapped getters or inherited values', () => {
  let reads = 0; const item = { ticket: { key: 'NESTED-1', asset: '0007', fault: 'DARK', at: '2026-11-08T11:00:00+09:00', state: 'NEW', privateField: 'PRIVATE' } };
  Object.defineProperty(item, 'secret', { enumerable: true, get() { reads++; throw new Error('PRIVATE'); } });
  const p = profile(); for (const [field, name] of Object.entries({ externalId: 'key', lampId: 'asset', issue: 'fault', receivedAt: 'at', sourceStatus: 'state' })) p.fields[field] = ['ticket', name];
  const out = Connector.adaptPage(page([item]), p); assert.equal(out.rows[0].externalId, 'NESTED-1'); assert.equal(reads, 0); assert.equal(out.ignoredFieldCount, 2);
  const inherited = Object.create({ ticketId: 'SECRET-INHERITED' }); Object.assign(inherited, source()); delete inherited.ticketId;
  assert.throws(() => Connector.adaptPage(page([inherited]), profile()), error => !/SECRET/.test(error.message));
});

test('repeated names inside nested paths still count discarded sibling fields', () => {
  const p = profile(), item = { ticket: { ticket: 'REPEATED-1', asset: '0007', fault: 'DARK', at: '2026-11-08T11:00:00+09:00', state: 'NEW', privateField: 'PRIVATE' }, secret: 'PRIVATE' };
  for (const [field, name] of Object.entries({ externalId: 'ticket', lampId: 'asset', issue: 'fault', receivedAt: 'at', sourceStatus: 'state' })) p.fields[field] = ['ticket', name];
  const out = Connector.adaptPage(page([item]), p); assert.equal(out.rows[0].externalId, 'REPEATED-1'); assert.equal(out.ignoredFieldCount, 2);
});

test('profiles must declare paths, enum maps and time encoding instead of guessing field names', () => {
  const badProfiles = [null, profile({ schemaVersion: 2 }), profile({ itemsPath: [] }), profile({ fields: {} }), profile({ issueMap: {} }), profile({ timeEncoding: 'guess' }), profile({ itemsPath: ['__proto__', 'items'] }), profile({ totalPath: ['data', 'constructor'] })];
  for (const bad of badProfiles) assert.throws(() => Connector.adaptPage(page(), bad));
  const p = profile(); Object.defineProperty(p, 'fields', { get() { throw new Error('PRIVATE-GETTER'); } });
  assert.throws(() => Connector.adaptPage(page(), p), error => !error.message.includes('PRIVATE-GETTER'));
});

test('time encodings are explicit and unsafe, missing-zone or unrecognized values cannot leak in errors', () => {
  const milliseconds = Connector.adaptPage(page([source({ received: at })]), profile({ timeEncoding: 'epoch-ms' }));
  const seconds = Connector.adaptPage(page([source({ received: String(at / 1000) })]), profile({ timeEncoding: 'epoch-seconds' }));
  assert.equal(milliseconds.rows[0].receivedAt, at); assert.equal(seconds.rows[0].receivedAt, at);
  for (const patch of [{ received: '2026-11-08T11:00:00' }, { received: 'PRIVATE-TIME' }, { received: 1e30 }, { fault: 'PRIVATE-FAULT' }, { state: 'PRIVATE-STATE' }, { ticketId: '=PRIVATE()' }]) assert.throws(() => Connector.adaptPage(page([source(patch)]), profile()), error => !/PRIVATE/.test(error.message));
});

test('page metadata must explicitly and consistently describe completion', () => {
  for (const extra of [{ total: '1' }, { total: -1 }, { total: 1001 }, { complete: 'true' }, { complete: false, nextCursor: null }, { complete: true, nextCursor: 'next' }, { complete: false, nextCursor: '' }, { complete: false, nextCursor: 'PRIVATE\nTOKEN' }]) assert.throws(() => Connector.adaptPage(page([source()], extra), profile()), error => !error.message.includes('PRIVATE'));
  assert.deepEqual(Connector.adaptPage(page([], { total: 0 }), profile()).rows, []);
});

test('the collector waits for every page and returns only normalized complete rows', async () => {
  const seen = [], progress = []; const gate = deferred();
  const pending = Connector.collect(query, { ...options(async request => { seen.push(request.cursor); if (request.cursor === null) return page([source()], { total: 2, nextCursor: 'page-2', complete: false }); return gate.promise; }), onProgress: value => progress.push(value) });
  await turn(); assert.deepEqual(seen, [null, 'page-2']);
  let done = false; pending.then(() => { done = true; }); await turn(); assert.equal(done, false);
  gate.resolve(page([source({ ticketId: 'LEDGER-002', state: 'WORKING' })], { total: 2 }));
  const out = await pending; assert.equal(out.complete, true); assert.equal(out.pages, 2); assert.equal(out.total, 2); assert.equal(out.rows.length, 2); assert.equal(out.rows[1].sourceStatus, 'processing');
  assert.deepEqual(progress, [{ page: 1, received: 1, total: 2 }, { page: 2, received: 2, total: 2 }]); assert.doesNotMatch(JSON.stringify(out), /readPage|profile/);
});

test('empty complete results are explicit and do not need a fake placeholder report', async () => {
  const out = await Connector.collect(query, options(async () => page([], { total: 0 })));
  assert.deepEqual(out.rows, []); assert.equal(out.pages, 1); assert.equal(out.total, 0); assert.equal(out.complete, true);
});

test('incomplete totals, changing totals and intermediate empty pages reject the entire collection', async () => {
  const variants = [
    [page([source()], { total: 2 })],
    [page([source()], { total: 2, nextCursor: 'next', complete: false }), page([source({ ticketId: 'LEDGER-002' })], { total: 3 })],
    [page([], { total: 1, nextCursor: 'next', complete: false })]
  ];
  for (const values of variants) { let index = 0; await assert.rejects(Connector.collect(query, options(async () => values[index++])), error => error.code === 'ledger-incomplete'); }
});

test('duplicate report IDs or repeating cursors are rejected rather than silently dropping possible missing rows', async () => {
  let count = 0;
  await assert.rejects(Connector.collect(query, options(async () => ++count === 1 ? page([source()], { total: 2, nextCursor: 'next', complete: false }) : page([source()], { total: 2 }))), error => error.code === 'ledger-incomplete');
  count = 0;
  await assert.rejects(Connector.collect(query, options(async () => page([source({ ticketId: 'LEDGER-' + ++count })], { total: 3, nextCursor: 'same', complete: false }))), error => error.code === 'ledger-incomplete'); assert.equal(count, 2);
});

test('received dates outside the declared query reject all pages without returning a partial ledger', async () => {
  await assert.rejects(Connector.collect(query, options(async () => page([source({ received: '2026-11-07T23:59:59+09:00' })]))), error => error.code === 'ledger-incomplete');
});

test('page and row caps reject whole collections without fetching extra pages', async () => {
  let calls = 0;
  await assert.rejects(Connector.collect(query, { ...options(async () => { calls++; return page([source()], { total: 2, nextCursor: 'next', complete: false }); }), maxPages: 1 }), error => error.code === 'ledger-incomplete'); assert.equal(calls, 1);
  assert.throws(() => Connector.adaptPage(page(Array.from({ length: 1001 }, (_, n) => source({ ticketId: 'R-' + n })), { total: 1000 }), profile()));
  for (const extra of [{ maxPages: 0 }, { maxPages: 51 }, { timeoutMs: 0 }, { timeoutMs: Infinity }]) await assert.rejects(Connector.collect(query, { ...options(async () => { assert.fail('Invalid options must reject before read'); }), ...extra }));
});

test('pre-aborted or noncurrent queries reject before invoking the injected reader', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(Connector.collect(query, { ...options(async () => { calls++; }), signal: controller.signal }), error => error.code === 'ledger-cancelled');
  await assert.rejects(Connector.collect(query, { ...options(async () => { calls++; }), isCurrent: () => false }), error => error.code === 'ledger-cancelled'); assert.equal(calls, 0);
});

test('cancellation aborts a pending reader and late completion cannot resurrect a result', async () => {
  const controller = new AbortController(), gate = deferred(); let childSignal, success = false;
  const pending = Connector.collect(query, { ...options(async request => { childSignal = request.signal; return gate.promise; }), signal: controller.signal }); pending.then(() => { success = true; }, () => {});
  await turn(); controller.abort(); await assert.rejects(pending, error => error.code === 'ledger-cancelled'); assert.equal(childSignal.aborted, true);
  gate.resolve(page()); await turn(); assert.equal(success, false);
});

test('context changes during a pending read or progress callback prevent further pages', async () => {
  let current = true, calls = 0; const gate = deferred();
  const pending = Connector.collect(query, { ...options(async () => { calls++; return gate.promise; }), isCurrent: () => current });
  await turn(); current = false; gate.resolve(page()); await assert.rejects(pending, error => error.code === 'ledger-cancelled');
  current = true; calls = 0;
  await assert.rejects(Connector.collect(query, { ...options(async () => { calls++; return page([source()], { total: 2, nextCursor: 'next', complete: false }); }), isCurrent: () => current, onProgress: () => { current = false; } }), error => error.code === 'ledger-cancelled'); assert.equal(calls, 1);
});

test('a context change cancels even when the injected read never settles', async () => {
  let current = true, signal; const timer = setTimeout(() => { current = false; }, 5);
  try { await assert.rejects(Connector.collect(query, { ...options(async request => { signal = request.signal; return new Promise(() => {}); }), isCurrent: () => current, timeoutMs: 1000 }), error => error.code === 'ledger-cancelled'); assert.equal(signal.aborted, true); }
  finally { clearTimeout(timer); }
});

test('a pending read has a bounded timeout and receives an aborted child signal', async () => {
  let signal;
  await assert.rejects(Connector.collect(query, { ...options(async request => { signal = request.signal; return new Promise(() => {}); }), timeoutMs: 20 }), error => error.code === 'ledger-timeout'); assert.equal(signal.aborted, true);
});

test('authentication and other reader failures are reported without original messages, URLs or tokens', async () => {
  for (const status of [401, 403, 500]) {
    await assert.rejects(Connector.collect(query, options(async () => { throw Object.assign(new Error('PRIVATE-TOKEN https://private.test'), { status }); })), error => error.code === (status === 500 ? 'ledger-unavailable' : 'authentication-required') && !/PRIVATE|private\.test/.test(error.message));
  }
  await assert.rejects(Connector.collect(query, options(async () => { throw 'PRIVATE-STRING'; })), error => !/PRIVATE/.test(error.message));
});

test('a hostile transport error descriptor cannot escape through the guarded promise', async () => {
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('PRIVATE-DESCRIPTOR'); } });
  await assert.rejects(Connector.collect(query, options(async () => { throw hostile; })), error => error.code === 'ledger-unavailable' && !/PRIVATE/.test(error.message));
});

test('query and profile snapshots cannot be changed by a reader between pages', async () => {
  const q = clone(query), p = profile(); let calls = 0;
  const out = await Connector.collect(q, { ...options(async request => { calls++; assert.equal(request.from, query.from); q.from = '2020-01-01'; p.fields.externalId = ['phone']; p.issueMap.DARK = 'other'; return calls === 1 ? page([source()], { total: 2, nextCursor: 'next', complete: false }) : page([source({ ticketId: 'LEDGER-002' })], { total: 2 }); }), profile: p });
  assert.equal(out.rows[1].externalId, 'LEDGER-002'); assert.equal(out.rows[1].issue, '불이 꺼져 있어요');
});

test('fixture pages exercise the same collector for single-day queries without any network capability', async () => {
  const oneDay = { from: '2026-11-09', to: '2026-11-09' }, fixture = Connector.createFixture({ lampId: '0007', query: oneDay });
  const out = await Connector.collect(oneDay, { ...fixture, isCurrent: () => true });
  assert.equal(out.pages, 2); assert.equal(out.total, 2); assert.deepEqual(out.rows.map(row => row.externalId), ['DEMO-LEDGER-001', 'DEMO-LEDGER-002']); assert.ok(out.rows.every(row => row.lampId === '0007'));
  assert.ok(out.ignoredFieldCount > 0); assert.doesNotMatch(JSON.stringify(out), /PRIVATE|phone|photo|name/);
});

test('live connection remains unconfigured and refuses before reading supplied callbacks or credentials', async () => {
  const status = Connector.liveStatus(); assert.equal(status.connected, false); assert.match(status.reason, /명세|연결/);
  let calls = 0; const value = {}; Object.defineProperty(value, 'readPage', { get() { calls++; throw new Error('PRIVATE'); } });
  await assert.rejects(Connector.queryLive(value), error => error.code === 'not-configured' && !/PRIVATE/.test(error.message)); assert.equal(calls, 0);
});

test('the browser global loads without DOM, storage, fetch or endpoint initialization', () => {
  const context = { DGOfficialReportImportCore: require('../../app/official-report-import-core.js') }; vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: 'official-ledger-connector.js' });
  assert.equal(typeof context.DGOfficialLedgerConnector.collect, 'function'); assert.equal(context.DGOfficialLedgerConnector.liveStatus().connected, false);
});
