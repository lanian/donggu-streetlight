'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../app/official-report-import-core.js');
const Commands = require('../../app/official-report-import-commands.js');
const Data = require('../../app/data.js');
const row = (extra = {}) => ({ externalId: 'R-0001', lampId: '001', issue: '불이 꺼져 있어요', receivedAt: Date.parse('2026-11-08T10:00:00+09:00'), sourceStatus: 'received', ...extra });
const source = (extra = {}) => ({ external_report_id: 'R-0001', lamp_id: '001', issue: 'off', received_at: '2026-11-08T10:00:00+09:00', status: 'received', ...extra });
const lights = [{ id: 'fixture-light', lampId: '001', code: '합성 1', dong: '합성동' }];
function local(options = {}) {
  let raw = null;
  const storage = { getItem: () => raw, setItem(_key, value) { if (options.fail) throw new Error('quota'); raw = value; } };
  return Data.createLocalDB({ storage, indexedDB: null, locks: { request: (_key, fn) => fn() } });
}
const context = db => ({ db, firebase: null, actor: 'local', admin: true, canWrite: true, isCurrent: () => true, lights: () => lights });

test('JSON parsing keeps only the five preparation fields and never retains private extras', () => {
  const out = Core.parse(JSON.stringify({ schemaVersion: 1, reports: [source({ phone: 'private-number', desc: 'private-note', photo: 'data:image/private', lat: 35.1 })] }), 'json');
  assert.deepEqual(out.rows, [row()]); assert.equal(out.ignoredFieldCount, 4);
  assert.doesNotMatch(JSON.stringify(out), /private|data:image/);
});
test('CSV supports BOM, CRLF, quoted columns and ignores multiline extra data', () => {
  const out = Core.parse('\ufeffexternal_report_id,lamp_id,issue,received_at,status,desc\r\n"R-0001","001",off,2026-11-08T10:00:00+09:00,received,"private\r\ntext,\"\"quoted\"\""\r\n', 'csv');
  assert.deepEqual(out.rows, [row()]); assert.equal(out.ignoredFieldCount, 1); assert.doesNotMatch(JSON.stringify(out), /private|quoted/);
});
test('both download templates parse using the explicit preparation contract', () => {
  for (const format of ['csv', 'json']) { const out = Core.parse(Core.template(format), format); assert.ok(out.rows.length > 0); assert.ok(out.rows.every(r => r.externalId && r.lampId)); }
});
test('numeric zero and leading zero identifiers are preserved without deriving p-prefixed identities', () => {
  const out = Core.parse(JSON.stringify([source({ external_report_id: 0, lamp_id: 0 }), source({ external_report_id: '0002', lamp_id: '0000' })]), 'json');
  assert.equal(out.rows[0].externalId, '0'); assert.equal(out.rows[0].lampId, '0'); assert.equal(out.rows[1].externalId, '0002'); assert.equal(out.rows[1].lampId, '0000');
});
test('malformed schemas, formula identifiers, unsafe numbers and unknown enums fail without echoing raw data', () => {
  for (const extra of [{ external_report_id: '=PRIVATE()' }, { external_report_id: 1e30 }, { issue: 'private-secret' }, { status: 'private-secret' }, { lamp_id: 'has/slash' }]) {
    assert.throws(() => Core.parse(JSON.stringify([source(extra)]), 'json'), error => !/PRIVATE|private-secret/.test(error.message));
  }
  assert.throws(() => Core.parse('{private-secret', 'json'), error => !error.message.includes('private-secret'));
  assert.throws(() => Core.parse(JSON.stringify({ schemaVersion: 2, reports: [source()] }), 'json'));
  assert.throws(() => Core.parse('external_report_id,external_report_id,lamp_id,issue,received_at,status\nx,x,1,off,2026-11-08,received', 'csv'));
});
test('strict dates reject normalized calendar errors and locale ambiguity while date-only uses KST', () => {
  for (const received_at of ['2026-02-31', '2026-02-31T10:00:00Z', '11/08/2026', '2026-11-08T10:00:00', '2026-11-08T25:00:00Z']) assert.throws(() => Core.parse(JSON.stringify([source({ received_at })]), 'json'));
  assert.equal(Core.parse(JSON.stringify([source({ received_at: '2026-11-08' })]), 'json').rows[0].receivedAt, Date.parse('2026-11-08T00:00:00+09:00'));
});
test('byte and row bounds reject whole inputs rather than silently truncate', () => {
  assert.throws(() => Core.parse(' '.repeat(2 * 1024 * 1024 + 1), 'json'));
  assert.throws(() => Core.parse(JSON.stringify(Array.from({ length: 1001 }, (_, i) => source({ external_report_id: 'R-' + i }))), 'json'));
});
test('planning connects only a unique active exact operating facility number', () => {
  const items = [row(), row({ externalId: 'R-2', lampId: '1' }), row({ externalId: 'R-3', lampId: 'removed' }), row({ externalId: 'R-4', lampId: 'twice' })];
  const out = Core.plan(items, { lights: [...lights, { id: 'gone', lampId: 'removed', code: '합성 1', removed: true }, { id: 'a', lampId: 'twice' }, { id: 'b', lampId: 'twice' }], reports: [] });
  assert.deepEqual(out.rows.map(r => r.decision), ['new', 'unmatched', 'unmatched', 'ambiguous']); assert.equal(out.rows[0].lightId, 'fixture-light');
});
test('file duplicates are skipped and differing records with the same source id block the full group', () => {
  const same = Core.plan([row(), row()], { lights, reports: [] }); assert.deepEqual(same.rows.map(r => r.decision), ['new', 'duplicate']);
  const different = Core.plan([row(), row({ issue: '깜빡거려요' })], { lights, reports: [] }); assert.ok(different.rows.every(r => r.decision === 'conflict'));
});
test('existing IDs and receipts never overwrite workflow status, and occupied IDs are conflicts', () => {
  const id = Data.stableId('official-file-report', 'gjd-roadlighting', 'R-0001');
  assert.equal(Core.plan([row()], { lights, reports: [{ id, receipt: 'R-0001', status: '완료', desc: 'existing staff memo' }] }).rows[0].decision, 'duplicate');
  assert.equal(Core.plan([row()], { lights, reports: [{ id: 'manual', receipt: 'R-0001' }] }).rows[0].decision, 'duplicate');
  assert.equal(Core.plan([row()], { lights, reports: [{ id, receipt: 'OTHER' }] }).rows[0].decision, 'conflict');
  assert.equal(Core.plan([row({ externalId: '12' })], { lights, reports: [{ id: 'legacy', receipt: 12 }] }).rows[0].decision, 'duplicate');
});
test('closed source records stay in the preview and never create active inbox entries', () => {
  assert.deepEqual(Core.plan([row({ sourceStatus: 'completed' }), row({ externalId: 'R-2', sourceStatus: 'cancelled' })], { lights, reports: [] }).rows.map(r => r.decision), ['closed', 'closed']);
});
test('new report payload uses the current inbox schema and excludes importer or personal metadata', () => {
  const planned = Core.plan([row({ sourceStatus: 'processing', contact: 'private', desc: 'private' })], { lights, reports: [] }).rows[0];
  const out = Core.report(planned, 'local');
  assert.deepEqual(Object.keys(out).sort(), ['issue','location','dong','code','lightId','desc','via','receipt','contact','status','createdAt','reporterId'].sort());
  assert.equal(out.status, '접수'); assert.equal(out.via, '기타'); assert.equal(out.receipt, 'R-0001'); assert.equal(out.contact, ''); assert.doesNotMatch(JSON.stringify(out), /private/); assert.match(out.desc, /원본 상태/);
});
test('report construction rejects closed source records and malformed linked-field values', () => {
  const planned = Core.plan([row()], { lights, reports: [] }).rows[0];
  for (const patch of [{ sourceStatus: 'completed' }, { sourceStatus: 'cancelled' }, { code: { private: 'data' } }, { dong: { private: 'data' } }, { lightId: 'path/other' }]) assert.throws(() => Core.report({ ...planned, ...patch }, 'local'));
});
test('the local executor creates stable ids once and reimport keeps existing reports unchanged', async () => {
  const db = local(), first = await Commands.execute([row()], ['R-0001'], context(db)); assert.equal(first.imported, 1);
  const stored = await db.readAll('reports'); assert.equal(stored.length, 1); assert.equal(stored[0].id, Data.stableId('official-file-report', 'gjd-roadlighting', 'R-0001'));
  await db.doc('reports/' + stored[0].id).update({ status: '완료', desc: 'staff note' });
  const second = await Commands.execute([row()], ['R-0001'], context(db)); assert.equal(second.imported, 0); assert.equal(second.duplicates, 1); assert.equal((await db.readAll('reports'))[0].desc, 'staff note');
});
test('real Firebase, non-local storage and unauthorized callers fail before any database read', async () => {
  let reads = 0; const db = { mode: 'local', readAll: async () => { reads++; return []; }, commitMany: async () => assert.fail('commit forbidden') };
  for (const change of [{ firebase: {} }, { actor: 'real-user' }, { admin: false }, { canWrite: false }, { isCurrent: () => false }, { db: { ...db, mode: 'firebase' } }]) await assert.rejects(Commands.execute([row()], ['R-0001'], { ...context(db), ...change }));
  assert.equal(reads, 0);
});
test('unknown and duplicate selections and forged normalized data cannot reach storage', async () => {
  const db = local();
  for (const selected of [['unknown'], ['R-0001', 'R-0001'], []]) await assert.rejects(Commands.execute([row()], selected, context(db)));
  await assert.rejects(Commands.execute([row({ issue: 'private-secret' })], ['R-0001'], context(db)));
  assert.equal((await db.readAll('reports')).length, 0);
});
test('late report reads and changed live facility data are rechecked before commit', async () => {
  const db = local(); let current = true, release;
  const gate = new Promise(resolve => { release = resolve; }); const original = db.readAll;
  db.readAll = async (...args) => { const out = await original(...args); await gate; return out; };
  const pending = Commands.execute([row()], ['R-0001'], { ...context(db), isCurrent: () => current }); current = false; release(); await assert.rejects(pending);
  db.readAll = original; assert.equal((await db.readAll('reports')).length, 0);
  const changing = { ...context(db), lights: () => [] }; const none = await Commands.execute([row()], ['R-0001'], changing); assert.equal(none.imported, 0); assert.equal(none.skipped, 1);
});
test('atomic local write failure keeps the whole inbox unchanged', async () => {
  const db = local({ fail: true }); await assert.rejects(Commands.execute([row(), row({ externalId: 'R-2' })], ['R-0001', 'R-2'], context(db)));
  assert.equal((await db.readAll('reports')).length, 0);
});
test('a concurrent create cannot overwrite a report written after preview', async () => {
  const db = local(), commit = db.commitMany; let once = true;
  db.commitMany = async (ops, options) => { if (once) { once = false; await db.doc(ops[0].path).create({ receipt: 'R-0001', status: '완료', desc: 'other tab' }); } return commit(ops, options); };
  await assert.rejects(Commands.execute([row()], ['R-0001'], context(db)), error => error.code === 'conflict' || error.code === 'already-exists');
  assert.equal((await db.readAll('reports'))[0].desc, 'other tab');
});
