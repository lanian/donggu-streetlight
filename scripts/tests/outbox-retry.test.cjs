// A send that fails on a weak signal while the browser still reports online stays queued and is retried by itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../../app/offline.js'), 'utf8');
test('a queued job after an "unavailable" error is retried on a timer without an online event', async () => {
  const timers = [];
  const ctx = vm.createContext({ console, Date, Math, TextEncoder, structuredClone, crypto: webcrypto, navigator: { onLine: true }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimeout() {} });
  ctx.globalThis = ctx; vm.runInContext(source, ctx);
  const O = ctx.DGOffline;
  await O.configure({ namespace: 'test/retry', durable: false, networkRequired: true, adapter: O.memoryStore() });
  let calls = 0;
  O.register('demo', async () => { calls++; if (calls === 1) throw Object.assign(new Error('Firestore unavailable'), { code: 'unavailable' }); });
  const first = await O.submit('demo', { id: 'j1', value: 1 }, { id: 'j1', summary: 'demo' });
  assert.equal(first.state, 'queued'); assert.equal(calls, 1);
  const retry = timers.filter(t => t.ms === 15000); assert.equal(retry.length, 1, 'one backoff retry is scheduled');
  retry[0].fn(); for (let i = 0; i < 50 && (await O.jobs())[0].state !== 'synced'; i++) await new Promise(r => setImmediate(r));
  assert.equal(calls, 2); assert.equal((await O.jobs())[0].state, 'synced');
});
