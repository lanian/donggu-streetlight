'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../app/lighting-area-core.js');
const Commands = require('../../app/lighting-area-commands.js');
const Data = require('../../app/data.js');
const clone = Data.clone;
const latitude = 35.14, longitude = 126.93, scaleY = 6371000 * Math.PI / 180, scaleX = scaleY * Math.cos(latitude * Math.PI / 180);
const xy = (x, y = 0) => ({ lat: latitude + y / scaleY, lng: longitude + x / scaleX });
const area = (extra = {}) => ({ label: '산 내부 검토 제외', effect: 'exclude', reason: 'mountain', note: '보행로가 없는 범위', shape: 'circle', ...xy(0), radius: 20, vertices: [], disabled: false, ...extra });
const polygon = (points, extra = {}) => area({ shape: 'polygon', radius: 0, vertices: points.map(p => xy(...p)), ...extra });
const named = (id, data = area()) => ({ id, ...data });
const near = (actual, expected, delta = 1e-7) => assert.ok(Math.abs(actual - expected) <= delta, `${actual} ≈ ${expected}`);
const total = pieces => pieces.reduce((sum, p) => sum + p.fraction, 0);
const excluded = pieces => pieces.filter(p => p.excluded).reduce((sum, p) => sum + p.fraction, 0);

test('a circle removes only its actual intersection, including a narrow boundary sliver', () => {
  const ctx = Core.compile([named('mountain')]);
  const pieces = Core.splitSegment(ctx, xy(-50), xy(50));
  assert.deepEqual(pieces.map(p => p.excluded), [false, true, false]);
  near(pieces[0].fraction, .3); near(pieces[1].fraction, .4); near(total(pieces), 1);
  assert.deepEqual(pieces[1].excludeIds, ['mountain']);
  const sliver = Core.splitSegment(ctx, xy(19.95), xy(27.95));
  near(excluded(sliver) * 8, .05, 1e-6);
  assert.deepEqual(sliver.map(p => p.excluded), [true, false]);
  near(total(sliver), 1);
});

test('a public walking corridor overrides overlapping exclusions, retaining every reason ID', () => {
  const ctx = Core.compile([
    named('woodland-b', area({ radius: 30 })), named('woodland-a', area({ radius: 35 })),
    named('path', area({ effect: 'include', reason: 'public_path', radius: 5 }))
  ]);
  assert.deepEqual(Core.decision(ctx, xy(0)), { excluded: false, includeIds: ['path'], excludeIds: ['woodland-a', 'woodland-b'] });
  assert.equal(Core.decision(ctx, xy(10)).excluded, true);
  const pieces = Core.splitSegment(ctx, xy(-50), xy(50));
  near(excluded(pieces), .6); near(total(pieces), 1);
  assert.ok(pieces.some(p => p.includeIds.includes('path') && !p.excluded));
});

test('polygon boundaries split road segments precisely and count boundary points inside', () => {
  const ctx = Core.compile([named('hill', polygon([[-10, -15], [10, -15], [10, 15], [-10, 15]]))]);
  const pieces = Core.splitSegment(ctx, xy(-50), xy(50));
  assert.deepEqual(pieces.map(p => p.excluded), [false, true, false]);
  near(excluded(pieces), .2); near(total(pieces), 1);
  assert.equal(Core.decision(ctx, xy(-10, 0)).excluded, true);
  assert.equal(Core.decision(ctx, xy(-10, -15)).excluded, true);
  assert.equal(Core.decision(ctx, xy(-10.01, 0)).excluded, false);
  const alongEdge = Core.splitSegment(ctx, xy(-20, -15), xy(20, -15));
  near(excluded(alongEdge), .5); near(total(alongEdge), 1);
});

test('a concave mountain polygon preserves its indentation and reverses without changing scope', () => {
  const vertices = [[-30, -30], [30, -30], [30, 30], [10, 30], [10, -10], [-10, -10], [-10, 30], [-30, 30]];
  const ctx = Core.compile([named('hill', polygon(vertices))]);
  assert.equal(Core.decision(ctx, xy(0, 0)).excluded, false);
  assert.equal(Core.decision(ctx, xy(20, 0)).excluded, true);
  const parts = Core.splitSegment(ctx, xy(-50), xy(50));
  assert.deepEqual(parts.map(p => p.excluded), [false, true, false, true, false]);
  near(excluded(parts), .4);
  const reversed = Core.splitSegment(ctx, xy(50), xy(-50));
  near(excluded(reversed), excluded(parts)); near(total(reversed), 1);
  assert.deepEqual(reversed.map(p => p.excluded), parts.map(p => p.excluded).reverse());
});

test('circle tangency and zero-length inputs never invent excluded length', () => {
  const ctx = Core.compile([named('mountain')]);
  const tangent = Core.splitSegment(ctx, xy(-50, 20), xy(50, 20));
  near(excluded(tangent), 0, 1e-6); near(total(tangent), 1);
  const stationary = Core.splitSegment(ctx, xy(0), xy(0));
  assert.equal(stationary.length, 1); assert.equal(stationary[0].fraction, 1); assert.equal(stationary[0].excluded, true);
  assert.deepEqual(stationary[0].start, stationary[0].end);
});

test('disabled areas do not mask roads, and compiled geometry is detached and frozen', () => {
  const input = named('hill', polygon([[-10, -10], [10, -10], [10, 10], [-10, 10]]));
  const disabled = named('inactive', area({ radius: 100, disabled: true }));
  const ctx = Core.compile([disabled, input]);
  input.vertices[0].lng = 0; input.disabled = true;
  assert.equal(Core.decision(ctx, xy(0)).excluded, true);
  assert.equal(Core.decision(ctx, xy(50)).excluded, false);
  assert.equal(ctx.count, 2); assert.equal(ctx.activeCount, 1);
  assert.equal(Object.isFrozen(ctx), true); assert.equal(Object.isFrozen(ctx.records), true);
  assert.equal(Object.isFrozen(ctx.records[0].vertices[0]), true);
  assert.throws(() => { ctx.records[0].vertices[0].lng = 0; }, TypeError);
  assert.throws(() => Core.decision({ records: [] }, xy(0)), { code: 'invalid-argument' });
});

test('normalization derives polygon anchors without rounding or truncating geometry', () => {
  const input = polygon([[-12, -8], [15, -8], [9, 20]], { lat: -70, lng: 5, radius: 50 });
  const normalized = Core.normalize(input);
  near(normalized.lat, input.vertices.reduce((sum, p) => sum + p.lat, 0) / 3, 0);
  near(normalized.lng, input.vertices.reduce((sum, p) => sum + p.lng, 0) / 3, 0);
  assert.equal(normalized.radius, 0); assert.deepEqual(normalized.vertices, input.vertices);
  assert.deepEqual(Core.normalize(normalized), normalized);
  assert.notEqual(normalized.vertices, input.vertices);
});

test('ambiguous, oversized, incomplete and invalid geometry fails visibly', () => {
  const bad = [
    area({ lat: null }), area({ radius: 4 }), area({ radius: 1001 }), area({ note: 0 }), area({ disabled: 0 }),
    area({ effect: 'include', reason: 'mountain' }), area({ vertices: [xy(0)] }),
    polygon([[0, 0], [10, 10]]), polygon([[0, 0], [10, 10], [0, 10], [10, 0]]),
    polygon([[0, 0], [10, 0], [20, 0]]), polygon([[0, 0], [10, 0], [10, 10], [0, 0]]),
    polygon([[0, 0], [60000, 0], [0, 20]]), polygon([[0, 0], [.1, 0], [0, .1]]),
    polygon([[0, 0], [10, 0], [5, 0], [5, 10], [0, 10]]),
    area({ shape: 'polygon', radius: 0, vertices: [{ lat: 0, lng: 179.999 }, { lat: 0, lng: -179.999 }, { lat: .001, lng: 179.999 }] })
  ];
  for (const input of bad) assert.throws(() => Core.normalize(input), { code: 'invalid-argument' });
  assert.throws(() => Core.compile([named('same'), named('same')]), /중복/);
  assert.throws(() => Core.compile([named('invalid', area({ disabled: true, radius: -1 }))]), /반경/);
  assert.throws(() => Core.compile([named('../bad')]), /식별자/);
  const ctx = Core.compile([]);
  assert.throws(() => Core.splitSegment(ctx, { lat: 0, lng: 179 }, { lat: 0, lng: -179 }), /날짜 변경선/);
  assert.throws(() => Core.decision(ctx, { lat: NaN, lng: 0 }), /위도/);
});

function local(initial = {}) {
  let raw = JSON.stringify(initial);
  const storage = { fail: false, getItem: () => raw, setItem(_, next) { if (this.fail) throw Object.assign(new Error('용량 초과'), { code: 'quota-exceeded' }); raw = next; } };
  // Exercise local fallback transactions independently of Node's experimental
  // Web Locks implementation; the browser integration suite covers IndexedDB.
  return { db: Data.createLocalDB({ storage, indexedDB: null, locks: { request: async (_, change) => change() } }), storage, dump: () => JSON.parse(raw) };
}
function firebase() {
  let records = {}, serial = Promise.resolve();
  const control = { failCommit: false, loseAcknowledgement: false };
  const db = { doc: path => ({ path }), runTransaction(fn) {
    const promise = serial.then(async () => {
      const next = clone(records); let written = false;
      const out = await fn({ get: async ref => { assert.equal(written, false); return { exists: Object.hasOwn(next, ref.path), data: () => clone(next[ref.path]) }; }, set: (ref, data) => { written = true; next[ref.path] = clone(data); } });
      if (control.failCommit) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
      records = next;
      if (control.loseAcknowledgement) { control.loseAcknowledgement = false; throw Object.assign(new Error('unavailable'), { code: 'unavailable' }); }
      return out;
    }); serial = promise.catch(() => {}); return promise;
  } };
  return { db, control, dump: () => clone(records) };
}
const job = (extra = {}) => ({ id: 'create-area', recordId: 'mountain-one', actor: 'local', at: 1000, expectedRevision: 0, data: area(), ...extra });
const flat = value => Object.fromEntries(Object.entries(value).flatMap(([collection, rows]) => Object.entries(rows).map(([id, row]) => [collection + '/' + id, row])));

for (const mode of ['local', 'firebase']) test(mode + ': immutable snapshots retain area changes and old retry cannot restore a disabled area', async () => {
  const l = mode === 'local' && local(), f = mode === 'firebase' && firebase();
  const context = { db: l ? l.db : f.db, ...(f ? { fb: f.db } : {}), user: 'local', admin: true };
  const read = () => l ? flat(l.dump()) : f.dump();
  const create = job(), edit = job({ id: 'edit-area', at: 2000, expectedRevision: 1, data: area({ radius: 40, note: '보행로 경계 정정' }) });
  const disable = job({ id: 'disable-area', at: 3000, expectedRevision: 2, data: area({ radius: 40, disabled: true }) });
  for (const command of [create, edit, disable]) await Commands.execute(command, context);
  const before = read();
  for (const command of [create, edit, disable]) assert.equal((await Commands.execute(clone(command), context)).alreadyApplied, true);
  assert.deepEqual(read(), before);
  const saved = before['lightingAreas/mountain-one'];
  assert.equal(saved.disabled, true); assert.equal(saved.revision, 3); assert.equal(saved.createdAt, 1000);
  assert.equal(before['lightingAreaOperations/create-area'].snapshot.radius, 20);
  assert.equal(before['lightingAreaOperations/edit-area'].snapshot.note, '보행로 경계 정정');
  assert.deepEqual(before['lightingAreaOperations/disable-area'].snapshot, saved);
  await Commands.execute(job({ id: 'enable-area', at: 4000, expectedRevision: 3, data: area({ radius: 40 }) }), context);
  assert.equal(read()['lightingAreas/mountain-one'].disabled, false);
});

test('area mutations require an administrator and preserve first-author provenance', async () => {
  const f = firebase(), context = { db: f.db, fb: f.db, user: 'owner', admin: true };
  for (const admin of [false, undefined, 1]) await assert.rejects(Commands.execute(job({ actor: 'owner' }), { ...context, admin }), { code: 'permission-denied' });
  await Commands.execute(job({ actor: 'owner' }), context);
  await Commands.execute(job({ id: 'other-admin', actor: 'second', at: 2000, expectedRevision: 1, data: area({ label: '현장 경계 정정' }) }), { ...context, user: 'second' });
  const saved = f.dump()['lightingAreas/mountain-one'];
  assert.equal(saved.createdBy, 'owner'); assert.equal(saved.updatedBy, 'second'); assert.equal(saved.createdAt, 1000);
  await assert.rejects(Commands.execute(job({ id: 'wrong-actor', actor: 'other' }), context), { code: 'permission-denied' });
});

test('reused operation IDs, stale revisions, backward time and new disabled areas are rejected', async () => {
  const l = local(), context = { db: l.db, user: 'local', admin: true };
  await Commands.execute(job(), context);
  const reordered = job({ data: Object.fromEntries(Object.entries(area()).reverse()) });
  assert.equal((await Commands.execute(reordered, context)).alreadyApplied, true);
  for (const patch of [{ at: 2000 }, { recordId: 'different-area' }, { expectedRevision: 1 }, { data: area({ radius: 30 }) }]) await assert.rejects(Commands.execute(job(patch), context), { code: 'conflict' });
  await Commands.execute(job({ id: 'edit', at: 2000, expectedRevision: 1, data: area({ radius: 30 }) }), context);
  await assert.rejects(Commands.execute(job({ id: 'stale', at: 3000, expectedRevision: 1 }), context), { code: 'conflict' });
  await assert.rejects(Commands.execute(job({ id: 'backward', at: 1500, expectedRevision: 2 }), context), { code: 'invalid-argument' });
  await assert.rejects(Commands.execute(job({ id: 'disabled', recordId: 'disabled', data: area({ disabled: true }) }), context), { code: 'invalid-argument' });
  assert.equal(Object.keys(l.dump().lightingAreaOperations).length, 2);
});

test('local quota and raced changes cannot leave a false immutable area snapshot', async () => {
  const l = local(), context = { db: l.db, user: 'local', admin: true };
  l.storage.fail = true;
  await assert.rejects(Commands.execute(job(), context), { code: 'quota-exceeded' }); assert.deepEqual(l.dump(), {});
  l.storage.fail = false; await Commands.execute(job(), context);
  const write = l.db.commitMany; let raced = false;
  l.db.commitMany = async (ops, options) => {
    if (!raced) { raced = true; await l.db.doc('lightingAreas/mountain-one').update({ revision: 2, updatedAt: 2500, note: '다른 탭에서 경계를 수정함' }); }
    return write(ops, options);
  };
  await assert.rejects(Commands.execute(job({ id: 'raced', at: 3000, expectedRevision: 1 }), context), { code: 'conflict' });
  assert.equal(l.dump().lightingAreas['mountain-one'].note, '다른 탭에서 경계를 수정함');
  assert.equal(l.dump().lightingAreaOperations.raced, undefined);
});

for (const mode of ['local', 'firebase']) test(mode + ': duplicate concurrent submissions create one revision and one snapshot', async () => {
  const l = mode === 'local' && local(), f = mode === 'firebase' && firebase();
  const context = { db: l ? l.db : f.db, ...(f ? { fb: f.db } : {}), user: 'local', admin: true };
  const results = await Promise.all([Commands.execute(job(), context), Commands.execute(job(), context)]);
  assert.equal(results.filter(r => r.alreadyApplied).length, 1);
  const saved = l ? flat(l.dump()) : f.dump();
  assert.equal(saved['lightingAreas/mountain-one'].revision, 1); assert.equal(Object.keys(saved).length, 2);
});

test('lost Firebase acknowledgement is confirmed through a receipt without repeating area changes', async () => {
  const f = firebase(), context = { db: f.db, fb: f.db, user: 'local', admin: true };
  f.control.failCommit = true;
  await assert.rejects(Commands.execute(job(), context), { code: 'unavailable' }); assert.deepEqual(f.dump(), {});
  f.control.failCommit = false; f.control.loseAcknowledgement = true;
  assert.equal((await Commands.execute(job(), context)).alreadyApplied, true);
  assert.equal(Object.keys(f.dump()).length, 2);
});

test('an unsupported shared backend fails before writes, and forged receipt contents do not confirm success', async () => {
  let called = false;
  await assert.rejects(Commands.execute(job({ actor: 'artifact' }), { db: { doc() { called = true; } }, user: 'artifact', admin: true }), { code: 'unsupported-backend' });
  assert.equal(called, false);
  const l = local(), context = { db: l.db, user: 'local', admin: true };
  await Commands.execute(job(), context);
  const saved = l.dump().lightingAreaOperations['create-area'];
  saved.snapshot.radius = 99;
  await l.db.doc('lightingAreaOperations/create-area').set(saved);
  await assert.rejects(Commands.execute(job(), context), { code: 'conflict' });
});
