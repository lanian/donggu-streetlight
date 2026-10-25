const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Reporting = require('../../app/reporting.js');
const source = name => fs.readFileSync(require('node:path').join(__dirname, '../..', name), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('photo preview pagination never changes the full selected set or mixes different repairs', () => {
  const rows = Array.from({ length: 100 }, (_, n) => ({ id: 'i' + n, lightId: 'same', code: 'A', result: '고장', date: n + 1, thumbs: [{ id: 'p' + n, label: n % 2 ? '조치 후' : '조치 전', t: 'data:image/png;base64,AA==' }] }));
  const items = Reporting.photoItems(rows, row => row.thumbs, 'all');
  assert.equal(items.length, 100);
  assert.equal(Reporting.photoPage(items, 'm').items.length, 48);
  assert.equal(Reporting.photoPage(items, 'l').items.length, 24);
  assert.equal(Reporting.photoPage(items, 'l').total, 100);
  assert.equal(Reporting.photoPage(items, 'm', 2).items.length, 4);
  assert.equal(Reporting.photoGroups(items).filter(group => group.before && group.after).length, 0);
  rows[0].workId = rows[1].workId = 'repair-one';
  assert.equal(Reporting.photoGroups(Reporting.photoItems(rows, row => row.thumbs, 'all')).filter(group => group.before && group.after).length, 1);
});

test('the real photo appendix renders 100 selected photos for print at every size and labels fallback evidence', () => {
  const html = source('index.html'), from = html.indexOf('const REP_PH={'), to = html.indexOf('async function decodePrintImages', from);
  const context = vm.createContext({ DGReporting: Reporting, inspectionThumbs: row => row.thumbs, esc: String, safeImageSrc: value => value || '', fmtDT: String, S: { names: {} }, render() {}, getPhoto: async () => null });
  vm.runInContext(html.slice(from, to), context);
  const rows = Array.from({ length: 100 }, (_, n) => ({ id: 'i' + n, lightId: 'a', code: 'A', result: '고장', date: n, thumbs: [{ id: 'p' + n, label: '현장', t: 'data:image/png;base64,AA==' }] }));
  context.rows = rows;
  for (const size of ['s', 'm', 'l']) {
    vm.runInContext('REP_PH.scope="all"; REP_PH.size="' + size + '";', context);
    const full = vm.runInContext('repPhotoAppendix(rows,{all:true,load:false})', context);
    assert.equal((full.match(/<img /g) || []).length, 100);
    assert.match(full, /선택 전체 100장/);
  }
  vm.runInContext('REP_PH.docs.p0={missing:true};', context);
  const fallback = vm.runInContext('repPhotoAppendix(rows,{all:true,load:false})', context);
  assert.match(fallback, /원본 조회 실패 · 보관된 미리보기/);
});

function management() {
  const scheduled = [], listeners = {}, downloads = [], messages = [], reads = [];
  let fail = false, section = 'dashboard';
  const fields = { '#dgDashFrom': { value: '2026-10-01' }, '#dgDashTo': { value: '2026-10-25' } };
  const context = vm.createContext({ console, Date, Promise, setTimeout: fn => scheduled.push(fn), navigator: { onLine: false }, document: { querySelector: key => fields[key], addEventListener: (event, handler) => listeners[event] = handler }, DGOperationsCore: require('../../app/operations-core.js'), DGOffline: { register() {} }, DGOperations: { download: async (...values) => downloads.push(values) } });
  vm.runInContext(source('app/management.js'), context);
  const api = { esc: String, state: () => ({ me: 'staff', lights: [], names: {} }), firebase: () => ({}), can: () => true, fmtDT: String, toast: message => messages.push(message), render: () => { if (section === 'audit') context.DGManagement.auditView(); }, readAll: async (collection, options) => { reads.push(collection); if (fail) throw new Error('permission-denied'); options.onMetadata?.({ source: context.navigator.onLine ? 'server' : 'cache', complete: !!context.navigator.onLine }); return []; } };
  context.DGManagement.attach(api);
  const click = action => { listeners.click({ target: { closest: () => ({ dataset: { mgmt: action } }) } }); return settle(); };
  return { context, manager: context.DGManagement, scheduled, reads, downloads, messages, click, setFail: value => { fail = value; }, section: value => { section = value; } };
}

test('offline report provenance survives reconnection and a failed refresh prevents old exports', async () => {
  const f = management(), m = f.manager;
  m.state.from = '2026-10-01'; m.state.to = '2026-10-25'; m.dashboard(); await f.scheduled.shift()();
  assert.equal(m.state.dashboardSource, 'cache');
  f.context.navigator.onLine = true;
  assert.match(m.dashboard(), /오프라인 보관 자료/);
  await f.click('dashboard-csv');
  assert.ok(f.downloads[0][1].some(row => row[0] === '자료 출처' && row[1].includes('오프라인')));
  f.setFail(true); await f.click('dashboard-load');
  assert.match(m.dashboard(), /data-mgmt="dashboard-csv" disabled/);
  await f.click('dashboard-csv'); assert.equal(f.downloads.length, 1);
  assert.ok(f.messages.some(message => message.includes('다시 조회')));
});

test('audit permission failure makes one request and only an explicit retry starts another', async () => {
  const f = management(); f.section('audit'); f.setFail(true);
  f.manager.auditView(); await f.scheduled.shift()();
  for (let n = 0; n < 8; n++) f.manager.auditView();
  assert.equal(f.reads.length, 1); assert.equal(f.scheduled.length, 0);
  assert.match(f.manager.auditView(), /permission-denied/);
  f.setFail(false); await f.click('audit-refresh');
  assert.equal(f.reads.length, 2); assert.equal(f.manager.state.auditLoaded, true);
  assert.equal(f.manager.state.auditError, '');
});

test('an unconfigured shared server is shown as unconnected without requesting a health call', () => {
  const f = management(); const html = f.manager.healthView();
  assert.match(html, /공유 운영 서버가 연결되지/);
  assert.equal(f.scheduled.length, 0);
  assert.doesNotMatch(html, /정상 기록 있음/);
});
