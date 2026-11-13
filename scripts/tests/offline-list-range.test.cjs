const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

// A minimal IndexedDB that counts every stored record handed back to the app, so the test can tell
// whether listing one kind of draft also loads unrelated large entries such as the field kit packet.
function countingIndexedDB() {
  const stores = new Map(); let created = false, materialized = [];
  const inRange = (key, range) => !range || (key >= range.lower && key <= range.upper);
  const database = {
    createObjectStore() { created = true; return { createIndex() {} }; }, close() {},
    transaction() {
      const tx = { error: null }; let pending = 0;
      const request = fn => { const r = {}; pending++; queueMicrotask(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); if (--pending === 0) queueMicrotask(() => { if (!pending && tx.oncomplete) tx.oncomplete(); }); }); return r; };
      const hand = rows => { materialized.push(...rows.map(row => row.key)); return rows.map(clone); };
      const store = {
        get: key => request(() => clone(stores.get(key))),
        put: value => request(() => { stores.set(value.key, clone(value)); }),
        delete: key => request(() => stores.delete(key)),
        getAll: range => request(() => hand([...stores.values()].filter(row => inRange(row.key, range)))),
        index: () => ({ getAll: ns => request(() => hand([...stores.values()].filter(row => row.namespace === ns))) })
      };
      tx.objectStore = () => store; tx.abort = () => {}; return tx;
    }
  };
  return { open() { const r = {}; queueMicrotask(() => { r.result = database; if (!created && r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); }); return r; },
    materialized: () => materialized, reset() { materialized = []; } };
}
const IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
function offline(idb) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, structuredClone, TextEncoder, crypto: webcrypto, navigator: { onLine: true }, indexedDB: idb, IDBKeyRange });
  vm.runInContext(fs.readFileSync('app/offline.js', 'utf8'), context);
  return context.DGOffline;
}

test('listing one kind of draft does not load the field kit packet or other kinds', async () => {
  const idb = countingIndexedDB(), queue = offline(idb);
  await queue.configure({ namespace: 'firebase:p:alice', durable: true });
  await queue.put('fieldKit', 'current', { photos: 'x'.repeat(1000) });
  await queue.put('workCompletion', 'w1', { note: '현장 조치' });
  await queue.put('draft', 'p', { memo: '점검' });
  idb.reset();
  assert.deepEqual(clone((await queue.list('workCompletion')).map(row => row.value)), [{ note: '현장 조치' }]);
  assert.deepEqual(idb.materialized(), ['firebase:p:alice|workCompletion:w1']);
});

test('a listing never crosses into another account namespace that shares the key prefix', async () => {
  const idb = countingIndexedDB(), queue = offline(idb);
  await queue.configure({ namespace: 'firebase:p:alice', durable: true }); await queue.put('draft', 'p', { memo: 'alice' });
  await queue.configure({ namespace: 'firebase:p:alice2', durable: true }); await queue.put('draft', 'p', { memo: 'alice2' });
  await queue.configure({ namespace: 'firebase:p:alice', durable: true });
  assert.deepEqual(clone((await queue.list('draft')).map(row => row.value)), [{ memo: 'alice' }]);
});
