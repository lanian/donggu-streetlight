const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../app/operations-core.js');
const settle = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function fixture() {
  let account = 'local', failRead = false, submitState = 'synced', submitError = '', sequence = 0;
  const listeners = {}, scheduled = [], reads = [], submitted = [], drafts = new Map(), jobs = [], messages = [], fields = {};
  const stock = { id: 'led', name: 'LED', unit: '개', quantity: 10, unitCost: 5000, revision: 1, updatedAt: 1, updatedBy: 'local' };
  const orders = ['one', 'two'].map(id => ({ id, title: id, status: 'assigned', parts: [{ inventoryId: 'led', name: 'LED', qty: 6, unitCost: 5000 }], stockApplied: {} }));
  const operations = { state: { loaded: true, inventory: [stock], orders: [orders[0]] }, uuid: prefix => prefix + '-' + (++sequence), load: async () => {}, submit: async job => {
    submitted.push(clone(job)); jobs.push({ id: job.id, state: submitState, error: submitError, payload: clone(job), kind: 'work' });
    if (submitError) throw new Error(submitError);
    if (submitState === 'synced') Object.assign(stock, job.input, { revision: stock.revision + 1 });
    return jobs[jobs.length - 1];
  } };
  const context = vm.createContext({ console, Date, Promise, setTimeout: fn => scheduled.push(fn), navigator: { onLine: true }, document: { querySelector: key => fields[key] || null, addEventListener: (event, handler) => listeners[event] = handler }, DGOperationsCore: C, DGOperations: operations,
    DGOffline: { ready: true, register() {}, subscribe() {}, jobs: async () => clone(jobs), put: async (ns, id, value) => drafts.set(ns + '/' + id, clone(value)), get: async (ns, id) => clone(drafts.get(ns + '/' + id)), remove: async (ns, id) => drafts.delete(ns + '/' + id), discard: async id => { const i = jobs.findIndex(j => j.id === id); if (i >= 0) jobs.splice(i, 1); } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/management.js'), 'utf8'), context);
  let html = '', closes = 0;
  const api = { esc: value => String(value), state: () => ({ me: account, names: {}, lights: [] }), firebase: () => account === 'local' ? null : {}, can: () => true, fmtDT: String, toast: m => messages.push(m), render() {}, closeSheet: () => closes++, navigate: value => { html = value; }, readAll: async (collection, options = {}) => {
    reads.push({ collection, options }); if (failRead) throw new Error('조회 실패'); options.onMetadata?.({ source: account === 'local' ? 'local' : 'server', complete: true });
    return clone(collection === 'workOrders' ? orders : collection === 'inventory' ? [stock] : []);
  } };
  context.DGManagement.attach(api);
  const click = async (action, extra = {}) => { listeners.click({ target: { closest: () => ({ dataset: { mgmt: action, ...extra }, disabled: false }) } }); await settle(); };
  const editFields = (name = 'LED 모듈', cost = '6200', reason = '품목명과 기준 단가 정정') => {
    fields['#dgEditItemName'] = { value: name }; fields['#dgEditItemCost'] = { value: cost }; fields['#dgEditItemReason'] = { value: reason };
  };
  const input = id => listeners.input({ target: { closest: () => ({ dataset: { id } }) } });
  return { manager: context.DGManagement, operations, reads, submitted, drafts, jobs, scheduled, stock, orders, fields, messages, api, context, click, input, editFields,
    html: () => html, closes: () => closes, setSubmit: (state, error = '') => { submitState = state; submitError = error; }, setFailRead: value => { failRead = value; }, account: value => { account = value; } };
}

test('reverting an inventory edit to baseline clears the persisted unsaved draft', async () => {
  const f = fixture(); await f.click('inventory-open', { id: 'led' });
  f.editFields(); f.input('led'); await settle(); assert.ok(f.drafts.has('inventoryDraft/led'));
  f.editFields('LED', '5000', ''); f.input('led'); await settle();
  assert.equal(f.drafts.has('inventoryDraft/led'), false);
});

test('abandoned inventory drafts can be explicitly discarded without stock or history changes', async () => {
  const f = fixture(); f.context.DGDialog = { confirm: async () => true };
  await f.click('inventory-open', { id: 'led' }); f.editFields(); f.input('led'); await settle();
  assert.match(f.html(), /수정 초안 버리기/);
  await f.click('inventory-edit-discard', { id: 'led' });
  assert.equal(f.drafts.has('inventoryDraft/led'), false); assert.equal(f.submitted.length, 0);
  assert.equal(f.stock.name, 'LED'); assert.equal(f.stock.quantity, 10);
  assert.match(f.html(), /value="LED"/);
});

test('inventory draft recovery is available to outbox and cannot discard an unconfirmed sending command', async () => {
  const f = fixture(); f.context.DGDialog = { confirm: async () => true };
  await f.click('inventory-open', { id: 'led' }); f.editFields(); f.setSubmit('sending');
  await f.click('inventory-update', { id: 'led' });
  assert.equal(typeof f.manager.resumeInventoryDraft, 'function');
  assert.equal(typeof f.manager.discardInventoryDraft, 'function');
  await f.manager.discardInventoryDraft('led');
  assert.ok(f.drafts.has('inventoryDraft/led')); assert.equal(f.jobs.length, 1);
  assert.match(f.messages.join(' '), /결과|대기|전송/);
  f.jobs[0].state = 'queued';
  assert.equal(await f.manager.discardInventoryDraft('led', { confirmed: true }), false);
  assert.ok(f.drafts.has('inventoryDraft/led')); assert.equal(f.jobs.length, 1);
});

test('outbox resume reloads inventory and preserves saved input without silently rebasing', async () => {
  const f = fixture(); await f.click('inventory-open', { id: 'led' }); f.editFields(); f.input('led'); await settle();
  let reloads = 0; f.operations.load = async force => { assert.equal(force, true); reloads++; f.stock.name = '최신 이름'; f.stock.revision = 2; };
  assert.equal(await f.manager.resumeInventoryDraft('led'), true);
  assert.equal(reloads, 1); assert.match(f.html(), /LED 모듈/); assert.match(f.html(), /최신 이름/); assert.match(f.html(), /자재 정보가 변경/);
});

test('outbox discard skips its second confirmation and clears a failed command without touching stock', async () => {
  const f = fixture(); f.context.DGDialog = { confirm: async () => { throw new Error('queue has already confirmed'); } };
  await f.click('inventory-open', { id: 'led' }); f.editFields(); f.setSubmit('conflict', '다른 직원의 변경');
  await f.click('inventory-update', { id: 'led' });
  assert.equal(await f.manager.discardInventoryDraft('led', { confirmed: true }), true);
  assert.equal(f.jobs.length, 0); assert.equal(f.drafts.has('inventoryDraft/led'), false); assert.equal(f.stock.quantity, 10); assert.equal(f.stock.name, 'LED');
});

test('discard confirmation is bound to its storage namespace', async () => {
  const f = fixture(); let answer;
  f.context.DGDialog = { confirm: () => new Promise(resolve => { answer = resolve; }) };
  await f.click('inventory-open', { id: 'led' }); f.editFields(); f.input('led'); await settle();
  const discarding = f.manager.discardInventoryDraft('led'); await settle();
  f.context.DGOffline.namespace = 'another-namespace'; answer(true);
  assert.equal(await discarding, false); assert.ok(f.drafts.has('inventoryDraft/led'));
});

test('discard rechecks a failed command after confirmation before removing it', async () => {
  const f = fixture(); let answer;
  f.context.DGDialog = { confirm: () => new Promise(resolve => { answer = resolve; }) };
  await f.click('inventory-open', { id: 'led' }); f.editFields(); f.setSubmit('conflict', '충돌');
  await f.click('inventory-update', { id: 'led' });
  const discarding = f.manager.discardInventoryDraft('led'); await settle();
  f.jobs[0].state = 'sending'; answer(true);
  assert.equal(await discarding, false); assert.equal(f.jobs.length, 1); assert.ok(f.drafts.has('inventoryDraft/led'));
});

test('outbox resume cannot open its old inventory after an account change during reload', async () => {
  const f = fixture(); let finish;
  f.operations.load = () => new Promise(resolve => { finish = resolve; });
  const resuming = f.manager.resumeInventoryDraft('led'); await settle();
  f.account('another-staff'); finish();
  assert.equal(await resuming, false); assert.equal(f.html(), '');
});

test('inventory metadata edits keep identity and quantity and submit revision plus reason', async () => {
  const f = fixture(); await f.click('inventory-open', { id: 'led' });
  assert.match(f.html(), /id="dgEditItemName"/);
  assert.match(f.html(), /id="dgEditItemCost"/);
  f.editFields(); await f.click('inventory-update', { id: 'led' });
  assert.equal(f.submitted.length, 1);
  assert.deepEqual(f.submitted[0].input, { name: 'LED 모듈', unitCost: 6200 });
  assert.equal(f.submitted[0].kind, 'inventory-update'); assert.equal(f.submitted[0].itemId, 'led');
  assert.equal(f.submitted[0].expectedRevision, 1); assert.equal(f.submitted[0].reason, '품목명과 기준 단가 정정');
  assert.equal(f.stock.quantity, 10); assert.equal(f.stock.unit, '개');
});

test('failed inventory metadata update retains the draft and only explicit refresh rebases its revision', async () => {
  const f = fixture(); await f.click('inventory-open', { id: 'led' }); f.editFields('정정할 이름', '7000', '오타 정정');
  f.setSubmit('conflict', '다른 직원이 자재를 수정했어요.'); await f.click('inventory-update', { id: 'led' });
  assert.equal(f.closes(), 0); assert.match(f.html(), /다른 직원이 자재를 수정/); assert.match(f.html(), /정정할 이름/);
  assert.ok([...f.drafts.values()].some(d => d.name === '정정할 이름' && d.expectedRevision === 1));
  f.stock.revision = 2; f.stock.name = '최신 서버 이름';
  await f.click('inventory-edit-refresh', { id: 'led' });
  assert.match(f.html(), /최신 서버 이름/); assert.match(f.html(), /정정할 이름/);
  assert.equal(f.jobs.length, 0, 'superseded failed command is explicitly discarded before rebasing');
  f.setSubmit('synced'); f.editFields('정정할 이름', '7000', '오타 정정'); await f.click('inventory-update', { id: 'led' });
  assert.equal(f.submitted[1].expectedRevision, 2);
});

test('queued inventory update remains visible and does not create duplicate commands on repeated save', async () => {
  const f = fixture(); await f.click('inventory-open', { id: 'led' }); f.editFields(); f.setSubmit('queued');
  await f.click('inventory-update', { id: 'led' }); await f.click('inventory-update', { id: 'led' });
  assert.equal(f.submitted.length, 1); assert.equal(f.closes(), 0); assert.match(f.html(), /저장 대기/);
  assert.match(f.html(), /fieldset[^>]*disabled/);
});

test('stock forecast uses all active work and fresh stock, not the paged work list', async () => {
  const f = fixture(); f.manager.inventoryView(); assert.equal(f.scheduled.length, 1, 'forecast schedules a full demand load'); await f.scheduled.shift()(); await settle();
  const html = f.manager.inventoryView();
  assert.ok(f.reads.some(r => r.collection === 'workOrders'));
  assert.ok(f.reads.some(r => r.collection === 'inventory'));
  assert.match(html, /예정 소요/); assert.match(html, /12/); assert.match(html, /부족/); assert.match(html, /2/);
  assert.equal(f.stock.quantity, 10, 'forecast never mutates stock');
  assert.equal(f.operations.state.orders.length, 1);
});

test('forecast failure is visible without retry loops, and an explicit refresh recovers', async () => {
  const f = fixture(); f.setFailRead(true); f.manager.inventoryView(); assert.equal(f.scheduled.length, 1, 'forecast schedules a full demand load'); await f.scheduled.shift()(); await settle();
  assert.match(f.manager.inventoryView(), /조회 실패/); assert.equal(f.scheduled.length, 0);
  const reads = f.reads.length; f.manager.inventoryView(); f.manager.inventoryView(); assert.equal(f.reads.length, reads);
  f.setFailRead(false); await f.click('inventory-refresh');
  assert.doesNotMatch(f.manager.inventoryView(), /조회 실패/); assert.match(f.manager.inventoryView(), /예정 소요/);
});

test('Firebase demand requests require complete server results and retain source metadata', async () => {
  const f = fixture(); f.account('staff'); f.manager.inventoryView(); assert.equal(f.scheduled.length, 1, 'forecast schedules a full demand load'); await f.scheduled.shift()(); await settle();
  assert.ok(f.reads.every(r => r.options.requireServer === true));
  assert.match(f.manager.inventoryView(), /서버에서 전체 조회/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.reads.find(r => r.collection === 'workOrders').options.where)), [['status', 'in', ['draft', 'assigned', 'in_progress', 'completed']]]);
});

test('late forecast from another account cannot replace the new account view', async () => {
  const f = fixture(), waiting = [];
  f.api.readAll = (collection, options) => new Promise(resolve => waiting.push(() => { options.onMetadata?.({ source: 'server', complete: true }); resolve(collection === 'inventory' ? [f.stock] : f.orders); }));
  f.manager.inventoryView(); const request = f.scheduled.shift()();
  f.account('another-staff'); f.manager.inventoryView(); waiting.forEach(resolve => resolve()); await request;
  assert.equal(f.manager.state.inventoryForecast, null);
  assert.equal(f.manager.state.inventoryForecastAt, 0);
});

test('changing account while a draft write is queued never writes into the new account namespace', async () => {
  const f = fixture(); await f.click('inventory-open', { id: 'led' }); f.editFields();
  const writes = [];
  f.context.DGOffline.put = async (ns, id, value) => writes.push({ storageActor: f.api.state().me, draftActor: value.actor });
  f.input('led'); f.account('another-staff'); await settle();
  assert.deepEqual(writes, []);
});

test('a late successful save cannot reopen inventory over a different screen', async () => {
  const f = fixture(); let generation = 0, finish;
  const navigate = f.api.navigate;
  f.api.navGen = () => generation; f.api.navAlive = value => value === generation;
  f.api.navigate = html => { generation++; navigate(html); };
  await f.click('inventory-open', { id: 'led' }); f.editFields();
  f.operations.submit = () => new Promise(resolve => { finish = resolve; });
  await f.click('inventory-update', { id: 'led' });
  f.api.navigate('다른 업무 화면'); finish({ state: 'synced' }); await settle();
  assert.equal(f.html(), '다른 업무 화면');
});

test('a late successful save cannot remove a different account draft', async () => {
  const f = fixture(); let finish; const removals = [];
  f.context.DGOffline.remove = async (ns, id) => removals.push({ actor: f.api.state().me, ns, id });
  await f.click('inventory-open', { id: 'led' }); f.editFields();
  f.operations.submit = () => new Promise(resolve => { finish = resolve; });
  await f.click('inventory-update', { id: 'led' });
  f.account('another-staff'); f.context.DGOffline.namespace = 'another-namespace'; finish({ state: 'synced' }); await settle();
  assert.deepEqual(removals, []);
});
