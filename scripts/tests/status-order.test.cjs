// Status ordering: the event that decided a light's status (statusAt) wins over an older one that arrives later,
// e.g. an offline inspection sent after an administrator signed off the repair.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const c = vm.createContext({ console, Date, Math, window: {}, structuredClone }); c.self = c;
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/data.js'), 'utf8'), c);
const D = c.DGData || c.window.DGData || c.self.DGData;
const inspection = at => ({ status: '고장', statusAt: at, lastInspected: at, lastResult: '고장', redoNote: null, updatedAt: at });
test('an inspection older than the repair sign-off keeps the repaired status but still counts as the latest inspection', () => {
  const repaired = { status: '정상', statusAt: 14, lastInspected: 8, updatedAt: 14 };
  const out = D.latestPatch(repaired, inspection(10));
  assert.equal(out.status, undefined); assert.equal(out.lastResult, undefined); assert.equal(out.statusAt, undefined);
  assert.equal(out.lastInspected, 10); assert.equal(out.updatedAt, 14);
});
test('a newer inspection decides the status; an exact retry applies again', () => {
  const now = { status: '정상', statusAt: 14, lastInspected: 8, updatedAt: 14 };
  assert.equal(D.latestPatch(now, inspection(18)).status, '고장');
  assert.equal(D.latestPatch({ ...now, statusAt: 18 }, inspection(18)).status, '고장');
});
test('lights from before statusAt fall back to lastInspected; an older inspection changes nothing', () => {
  const legacy = { status: '수리중', lastInspected: 20, updatedAt: 20 };
  const out = D.latestPatch(legacy, inspection(10));
  assert.deepEqual(Object.keys(out).sort(), []);
  assert.equal(D.latestPatch(legacy, inspection(25)).status, '고장');
});
test('patches without a time (field edits) pass through', () => {
  assert.equal(JSON.stringify(D.latestPatch({ status: '정상', statusAt: 5 }, { code: 'x', updatedAt: 9 })), JSON.stringify({ code: 'x', updatedAt: 9 }));
});
