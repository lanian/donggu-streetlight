const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('./browser-env.cjs');
const Data = require('../../app/data.js');
const day = 86400000;

async function fixture(records, options = {}) {
  const values = new Map(), handlers = new Map(), executors = new Map();
  const database = Data.createLocalDB({ indexedDB: null, storage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) } });
  await database.commitMany(Object.entries(records).map(([name, data]) => ({ path: name, data })));
  const messages = [], queries = [], completed = Promise.withResolvers();
  const sandbox = {
    console, Date, setTimeout, clearTimeout,
    DGOperations: { state: { settings: { privacyDays: 90 } }, uuid: () => 'privacy-test' },
    DGDialog: { confirm: async () => { if (options.beforeConfirm) await options.beforeConfirm(database); return true; } },
    DGOffline: {
      register: (name, execute) => executors.set(name, execute),
      submit: async (name, job) => { await executors.get(name)(job); return { state: 'synced' }; }
    },
    document: { addEventListener: (name, handler) => handlers.set(name, handler), querySelector: () => null }
  };
  const privacyFile = path.resolve(__dirname, '../../app/privacy.js');
  vm.createContext(sandbox);
  if (fs.existsSync(privacyFile)) vm.runInContext(fs.readFileSync(privacyFile, 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../app/management.js'), 'utf8'), sandbox);
  sandbox.DGManagement.attach({
    can: () => true, state: () => ({ me: 'admin' }), firebase: () => null, database: () => options.artifact ? { doc: name => database.doc(name) } : database,
    readAll: async collection => { queries.push(collection); return Data.readAll(database, collection); },
    toast: message => { messages.push(message); completed.resolve(); }
  });
  return {
    database, queries, messages, executors,
    purge: async () => { handlers.get('click')({ target: { closest: () => ({ dataset: { mgmt: 'privacy-purge' } }) } }); await completed.promise; },
    read: async name => (await database.doc(name).get()).data()
  };
}

test('manual privacy cleanup includes expired original citizen reports without importing them', async () => {
  const now = Date.now();
  const f = await fixture({ 'citizen_reports/raw': { at: now - 120 * day, privacyExpiresAt: now - 30 * day, imported: false, contact: 'synthetic', photo: 'data:image/jpeg;base64,AAAA', lat: 35.14, lng: 126.92, acc: 10, ua: 'synthetic', issue: 'keep issue' } });
  await f.purge();
  const row = await f.read('citizen_reports/raw');
  assert.ok(!row.contact && !row.photo && row.lat == null && row.lng == null && row.acc == null && !row.ua, 'all original reporter information is removed');
  assert.equal(row.issue, 'keep issue'); assert.equal(row.imported, false); assert.ok(row.privacyPurgedAt);
});

test('manual cleanup respects an expired individual retention period shorter than current settings', async () => {
  const now = Date.now();
  const f = await fixture({ 'reports/short': { createdAt: now - 60 * day, privacyExpiresAt: now - 30 * day, contact: 'synthetic', desc: 'keep description' } });
  await f.purge();
  const row = await f.read('reports/short');
  assert.equal(row.contact, ''); assert.equal(row.desc, 'keep description'); assert.ok(row.privacyPurgedAt);
});

test('manual cleanup keeps unexpired reports and cleans legacy records with no explicit expiry', async () => {
  const now = Date.now();
  const f = await fixture({
    'citizen_reports/recent': { at: now - day, privacyExpiresAt: now + 29 * day, contact: 'keep' },
    'reports/legacy': { createdAt: now - 100 * day, contact: 'remove', location: 'reporter location', ext: 'old-original' }
  });
  await f.purge();
  assert.equal((await f.read('citizen_reports/recent')).contact, 'keep');
  assert.equal((await f.read('reports/legacy')).contact, ''); assert.equal((await f.read('reports/legacy')).location, '');
});

test('cleanup rechecks a selected record before applying a queued deletion', async () => {
  const now = Date.now();
  const f = await fixture({ 'citizen_reports/replaced': { at: now - 100 * day, privacyExpiresAt: now - day, contact: 'old' } }, {
    beforeConfirm: async db => db.doc('citizen_reports/replaced').set({ at: now, privacyExpiresAt: now + 90 * day, contact: 'new' })
  });
  await f.purge(); assert.equal((await f.read('citizen_reports/replaced')).contact, 'new');
});

test('existing queued privacy jobs keep their original collection and administrator binding', async () => {
  const f = await fixture({ 'reports/old': { createdAt: 1000, contact: 'remove' }, 'citizen_reports/old': { at: 1000, contact: 'keep' } });
  const execute = f.executors.get('privacy');
  await assert.rejects(() => execute({ actor: 'other-admin', ids: ['old'], at: 5000, cut: 2000 }), /관리자/);
  await execute({ actor: 'admin', ids: ['old'], at: 5000, cut: 2000 });
  assert.equal((await f.read('reports/old')).contact, ''); assert.equal((await f.read('citizen_reports/old')).contact, 'keep');
});

test('an adapter without conditional writes is explained before scanning, confirmation, or queueing cleanup', async () => {
  let confirmations = 0;
  const f = await fixture({ 'reports/old': { createdAt: 1000, contact: 'keep' } }, { artifact: true, beforeConfirm: async () => { confirmations++; } });
  await f.purge();
  assert.match(f.messages.at(-1), /Firebase.*체험/); assert.equal(confirmations, 0); assert.equal(f.queries.length, 0);
  assert.equal((await f.read('reports/old')).contact, 'keep');
});
