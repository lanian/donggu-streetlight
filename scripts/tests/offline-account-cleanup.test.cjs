const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const ctx = vm.createContext({ console, structuredClone, navigator: { onLine: true } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/offline.js'), 'utf8'), ctx);
  return ctx.DGOffline;
}
test('discard cannot delete a new account job after its original account read is delayed', async () => {
  const O = fixture(), a = O.memoryStore(), b = O.memoryStore(), entered = deferred(), gate = deferred();
  await a.write('job:same', { id: 'same', state: 'failed', actor: 'a' });
  await b.write('job:same', { id: 'same', state: 'failed', actor: 'b' });
  const read = a.read.bind(a); a.read = async key => { const value = await read(key); entered.resolve(); await gate.promise; return value; };
  await O.configure({ namespace: 'a', adapter: a }); const pending = O.discard('same');
  await entered.promise; await O.configure({ namespace: 'b', adapter: b }); gate.resolve();
  await assert.rejects(pending, { code: 'account-changed' });
  assert.equal((await b.read('job:same')).actor, 'b'); assert.equal((await read('job:same')).actor, 'a');
});
test('synced-job cleanup never removes matching IDs from a newly configured account', async () => {
  const O = fixture(), a = O.memoryStore(), b = O.memoryStore(), entered = deferred(), gate = deferred();
  await b.write('job:x50', { id: 'x50', state: 'failed', actor: 'b' });
  let calls = 0;
  a.list = async () => { if (++calls === 1) return []; entered.resolve(); await gate.promise; return Array.from({ length: 51 }, (_, i) => ({ id: 'x' + i, state: 'synced', createdAt: 100 - i })); };
  await O.configure({ namespace: 'a', adapter: a, networkRequired: false }); const pending = O.flush();
  await entered.promise; await O.configure({ namespace: 'b', adapter: b }); gate.resolve(); await pending;
  assert.equal((await b.read('job:x50')).actor, 'b');
});
