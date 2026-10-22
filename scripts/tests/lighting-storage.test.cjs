const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const L = require('../../app/lighting-commands.js');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const input = (extra = {}) => ({ kind: 'source', label: '공원 외부 조명', category: 'other_public', operator: '다른 관리기관',
  lat: 35.15, lng: 126.92, radius: 20, strength: 'medium', status: 'on', level: 'unknown', schedule: 'hours',
  startMinute: 1080, endMinute: 360, observedAt: 1000, validDays: 90, nightConfirmed: true, lux: null,
  instrument: '', note: '', linkedLightId: '', distinct: true, removed: false, ...extra });
const job = (extra = {}) => ({ id: 'create-one', recordId: 'record-one', actor: 'local', at: 1000, expectedRevision: 0, data: input(), ...extra });

function local(initial = {}) {
  let value = JSON.stringify(initial);
  const storage = { fail: false, getItem: () => value, setItem(_, next) { if (this.fail) throw failure('quota-exceeded'); value = next; }, dump: () => JSON.parse(value) };
  const context = vm.createContext({ console, Date, Math, crypto: webcrypto });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/data.js'), 'utf8'), context);
  return { db: context.DGData.createLocalDB({ storage, indexedDB: null }), storage };
}
function firebase() {
  let records = {}, serial = Promise.resolve();
  const control = { failCommit: false, loseAcknowledgement: false };
  const db = { doc: key => ({ path: key }), runTransaction(fn) {
    const pending = serial.then(async () => {
      const next = clone(records); let writes = false;
      const result = await fn({
        get: async ref => { assert.equal(writes, false, 'all Firestore reads precede writes'); return { exists: Object.hasOwn(next, ref.path), data: () => clone(next[ref.path]) }; },
        set: (ref, value) => { writes = true; next[ref.path] = clone(value); }
      });
      if (control.failCommit) throw failure('unavailable');
      records = next;
      if (control.loseAcknowledgement) { control.loseAcknowledgement = false; throw failure('unavailable'); }
      return result;
    }); serial = pending.catch(() => {}); return pending;
  } };
  return { db, control, dump: () => clone(records) };
}
const flat = value => Object.fromEntries(Object.entries(value).flatMap(([collection, docs]) => Object.entries(docs).map(([id, data]) => [collection + '/' + id, data])));

for (const mode of ['local', 'firebase']) test(mode + ': create, edit and soft removal survive old queued retries without resurrection', async () => {
  const l = mode === 'local' && local(), f = mode === 'firebase' && firebase();
  const context = { db: l ? l.db : f.db, ...(f ? { fb: f.db } : {}), user: 'local', admin: false };
  const read = () => l ? flat(l.storage.dump()) : f.dump();
  const first = job(); await L.execute(first, context);
  const update = job({ id: 'edit-one', at: 2000, expectedRevision: 1, data: input({ status: 'off', note: '소등 확인' }) });
  await L.execute(update, context);
  const remove = job({ id: 'remove-one', at: 3000, expectedRevision: 2, data: input({ status: 'off', removed: true }) });
  await L.execute(remove, context); const saved = read();
  assert.equal((await L.execute(clone(first), context)).alreadyApplied, true);
  assert.equal((await L.execute(clone(update), context)).alreadyApplied, true);
  assert.equal((await L.execute(clone(remove), context)).alreadyApplied, true);
  assert.deepEqual(read(), saved);
  assert.equal(saved['lightingContext/record-one'].removed, true);
  assert.equal(saved['lightingContext/record-one'].revision, 3);
  assert.equal(saved['lightingContext/record-one'].createdAt, 1000);
  assert.equal(Object.keys(saved).filter(key => key.startsWith('lightingOperations/')).length, 3);
});

test('a command ID binds canonical contents, record, author, timestamp and expected revision', async () => {
  const l = local(), context = { db: l.db, user: 'local', admin: true }, first = job();
  await L.execute(first, context);
  const reordered = { ...first, data: Object.fromEntries(Object.entries(first.data).reverse()) };
  assert.equal((await L.execute(reordered, context)).alreadyApplied, true);
  for (const patch of [{ data: input({ label: '다른 내용' }) }, { recordId: 'another-record' }, { at: 2000 }, { expectedRevision: 1 }]) {
    await assert.rejects(L.execute({ ...first, ...patch }, context), { code: 'conflict' });
  }
  await assert.rejects(L.execute({ ...first, actor: 'someone-else' }, context), { code: 'permission-denied' });
  assert.equal(Object.keys(l.storage.dump().lightingOperations).length, 1);
});

test('own edits and administrator corrections preserve the original author and creation time', async () => {
  const f = firebase(), owner = { db: f.db, fb: f.db, user: 'owner', admin: false };
  await L.execute(job({ actor: 'owner' }), owner);
  const correction = job({ id: 'correction', actor: 'other', at: 2000, expectedRevision: 1, data: input({ label: '관리자 확인' }) });
  await assert.rejects(L.execute(correction, { ...owner, user: 'other' }), { code: 'permission-denied' });
  await L.execute(correction, { ...owner, user: 'other', admin: true });
  const record = f.dump()['lightingContext/record-one'];
  assert.equal(record.createdBy, 'owner'); assert.equal(record.createdAt, 1000); assert.equal(record.updatedBy, 'other');
  await assert.rejects(L.execute(job({ id: 'stale', actor: 'owner', expectedRevision: 1 }), owner), { code: 'conflict' });
});

test('a local quota failure writes neither the context nor its receipt, then one retry succeeds', async () => {
  const l = local(), context = { db: l.db, user: 'local', admin: false };
  l.storage.fail = true;
  await assert.rejects(L.execute(job(), context), { code: 'quota-exceeded' }); assert.deepEqual(l.storage.dump(), {});
  l.storage.fail = false; await L.execute(job(), context); await L.execute(job(), context);
  assert.equal(Object.keys(l.storage.dump().lightingContext).length, 1);
  assert.equal(Object.keys(l.storage.dump().lightingOperations).length, 1);
});

test('local CAS rejects a raced edit without persisting a false completion receipt', async () => {
  const l = local(), context = { db: l.db, user: 'local', admin: true };
  await L.execute(job(), context);
  const original = l.db.commitMany; let raced = false;
  l.db.commitMany = async (ops, options) => {
    if (!raced) { raced = true; await l.db.doc('lightingContext/record-one').update({ revision: 2, note: '다른 탭의 최신 기록' }); }
    return original(ops, options);
  };
  await assert.rejects(L.execute(job({ id: 'edit', at: 2000, expectedRevision: 1, data: input({ label: '오래된 변경' }) }), context), { code: 'conflict' });
  assert.equal(l.storage.dump().lightingContext['record-one'].note, '다른 탭의 최신 기록');
  assert.equal(l.storage.dump().lightingOperations.edit, undefined);
});

for (const mode of ['local', 'firebase']) test(mode + ': simultaneous duplicate submission records exactly one revision', async () => {
  const l = mode === 'local' && local(), f = mode === 'firebase' && firebase();
  const context = { db: l ? l.db : f.db, ...(f ? { fb: f.db } : {}), user: 'local', admin: false };
  const results = await Promise.all([L.execute(job(), context), L.execute(job(), context)]);
  assert.equal(results.filter(result => result.alreadyApplied).length, 1);
  const saved = l ? flat(l.storage.dump()) : f.dump();
  assert.equal(saved['lightingContext/record-one'].revision, 1); assert.equal(Object.keys(saved).length, 2);
});

test('Firestore atomic failures and acknowledgement loss are safely retried using the same ID', async () => {
  const f = firebase(), context = { db: f.db, fb: f.db, user: 'local', admin: true };
  f.control.failCommit = true;
  await assert.rejects(L.execute(job(), context), { code: 'unavailable' }); assert.deepEqual(f.dump(), {});
  f.control.failCommit = false; f.control.loseAcknowledgement = true;
  assert.equal((await L.execute(job(), context)).alreadyApplied, true, 'a read-only receipt check confirms a lost acknowledgement');
  assert.equal((await L.execute(job(), context)).alreadyApplied, true);
  assert.equal(Object.keys(f.dump()).length, 2);
});

test('the command uses model validation and preserves explicit 0 lux separately from missing lux', async () => {
  const l = local(), context = { db: l.db, user: 'local', admin: true };
  const measured = input({ kind: 'observation', category: 'field', validDays: 30, lux: 0, instrument: '휴대용 조도계' });
  await L.execute(job({ data: measured }), context);
  assert.equal(l.storage.dump().lightingContext['record-one'].lux, 0);
  for (const bad of [input({ lat: null }), input({ radius: 81 }), input({ kind: 'observation', radius: 31 }), input({ lux: 0 }), input({ observedAt: 301001 })]) {
    await assert.rejects(L.execute(job({ id: 'bad', recordId: 'bad', data: bad }), context), { code: 'invalid-argument' });
  }
  for (const id of ['../escape', '__proto__', 'constructor', 'bad/path']) await assert.rejects(L.execute(job({ id, recordId: id }), context), { code: 'invalid-argument' });
  await assert.rejects(L.execute(job({ expectedRevision: Number.MAX_SAFE_INTEGER }), context), { code: 'invalid-argument' });
  await assert.rejects(L.execute(job({ id: 'removed', recordId: 'removed', data: input({ removed: true }) }), context), { code: 'invalid-argument' });
  assert.equal(Object.keys(l.storage.dump().lightingContext).length, 1);
});

test('an unsupported artifact backend fails before any writes', async () => {
  let called = false;
  const db = { doc() { called = true; throw new Error('unexpected access'); } };
  await assert.rejects(L.execute(job({ actor: 'artifact-user' }), { db, user: 'artifact-user', admin: true }), { code: 'unsupported-backend' });
  assert.equal(called, false);
});
