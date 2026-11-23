const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'app/staff-app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const at = time => Date.parse('2026-11-02T' + time + ':00+09:00');
const normal = { id: 'active', code: 'CURRENT-A', dong: '동명동', kind: '보안등', status: '고장', lastInspected: at('20:00') };
const elsewhere = { id: 'elsewhere', code: 'CURRENT-B', dong: '서석동', kind: '보안등', status: '정상' };
const retired = { id: 'retired', code: 'RETIRED-C', dong: '학동', kind: '가로등', status: '정상', removed: true };
const inspection = (id, lightId, code, dong, result = '정상') => ({ id, lightId, code, dong, result, inspector: 'inspector', date: at('12:00'), checks: { lamp: result === '고장' ? 'bad' : 'ok' }, faults: result === '고장' ? ['램프'] : [], memo: '', photoN: 0 });
const firstNormal = inspection('i-normal-1', 'active', 'PERIOD-NORMAL', '동명동');
const secondNormal = { ...firstNormal, id: 'i-normal-2', date: at('13:00') };
const fault = inspection('i-fault', 'elsewhere', 'PERIOD-FAULT', '서석동', '고장');
const strip = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

async function fixture({ clock = Date, period = { period: 'custom', from: '2026-11-01', to: '2026-11-03' }, inspections = [firstNormal, secondNormal, fault], patrols = [], dong = '전체', dbMode = 'local', metadata = { inspections: { source: 'local', complete: true }, patrols: { source: 'local', complete: true } } } = {}) {
  const allLights = clone([normal, elsewhere, retired]), rows = clone(inspections), sessions = clone(patrols), downloads = [], queries = [];
  const context = vm.createContext({
    Date: clock, Promise, Set, Map, console, DGOperationsCore: require('../../app/operations-core.js'), db: { mode: dbMode }, FB: null,
    S: { lights: allLights.filter(light => !light.removed), allLights, insp: [], patrols: [], names: { inspector: '점검 담당자', local: '기기 담당자' }, me: 'local' },
    byId: id => allLights.find(light => light.id === id),
    esc: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]),
    inspectionFaults: row => row.faults || [], inspectionThumbs: row => row.thumbs || [], safeImageSrc: value => value || '',
    repPhotoAppendix: () => '', navigator: {}, document: { querySelector: () => null },
    dl: { save: async value => downloads.push(value) }, csvCell: value => '"' + String(value ?? '').replace(/"/g, '""') + '"',
    setTimeout: () => { throw new Error('The loaded report must not schedule another background fetch.'); },
    render() {}, resolveNames() {}, toast() {},
    listAllRecords: async (collection, options = {}) => {
      queries.push({ collection, where: clone(options.where || []) });
      options.onMetadata?.(clone(metadata[collection] || { source: 'unknown', complete: false }));
      if (collection === 'inspections') return clone(rows);
      if (collection === 'patrols') return clone(sessions);
      throw new Error('Unexpected report collection: ' + collection);
    }
  });
  const dongStart = source.indexOf('const ADONGS='), dongEnd = source.indexOf('// longest first', dongStart);
  assert.ok(dongStart >= 0 && dongEnd > dongStart);
  vm.runInContext(source.slice(dongStart, dongEnd), context);
  for (const name of ['fmtD', 'fmtDT']) vm.runInContext(source.split(/\r?\n/).find(line => line.startsWith('const ' + name + '=')), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'app/reporting.js'), 'utf8'), context);
  const reportStart = source.indexOf('const REP={'), reportEnd = source.indexOf('/* photo appendix:', reportStart);
  assert.ok(reportStart >= 0 && reportEnd > reportStart);
  vm.runInContext(source.slice(reportStart, reportEnd), context);
  const exportStart = source.indexOf('function repSummaryText()'), exportEnd = source.indexOf('/* per-light dossier:', exportStart);
  assert.ok(exportStart >= 0 && exportEnd > exportStart);
  vm.runInContext(source.slice(exportStart, exportEnd), context);
  const rep = vm.runInContext('REP', context);
  Object.assign(rep, { ...period, dong, photos: false, inlinePh: false });
  await context.repLoad();
  assert.ok(rep.data, 'The real loader establishes a complete period snapshot before rendering.');
  const original = JSON.stringify({ lights: allLights, inspections: rows, patrols: sessions });
  return { context, rep, downloads, queries, data: () => clone(context.reportData()), html: () => context.reportSection(true), original, unchanged: () => JSON.stringify({ lights: allLights, inspections: rows, patrols: sessions }) === original };
}

test('period district rows include retired and unlocated historical inspections without losing the eight-column CSV contract', async () => {
  const removedRecord = inspection('i-retired', 'retired', 'PERIOD-RETIRED', '학동');
  const unknownRecord = inspection('i-unknown', 'missing-from-registry', 'PERIOD-UNKNOWN', '이관 전 미확인동', '고장');
  const f = await fixture({ inspections: [firstNormal, secondNormal, removedRecord, unknownRecord] });
  const data = f.data();
  assert.equal(data.ins.length, 4);
  assert.equal(data.byDong.reduce((sum, row) => sum + row.insp, 0), data.ins.length, 'Every period inspection belongs to a displayed district row.');
  const historical = data.byDong.find(row => row.d === '학동');
  assert.ok(historical); assert.equal(historical.n, 0); assert.equal(historical.insp, 1); assert.equal(historical.ok, 1);
  const unknown = data.byDong.find(row => /미확인/.test(row.d));
  assert.ok(unknown, 'A missing or unmappable registry district has an explicit unknown bucket.');
  assert.equal(unknown.n, 0); assert.equal(unknown.insp, 1); assert.equal(unknown.bad, 1);
  await f.context.exportReportCSV(); assert.equal(f.downloads.length, 1);
  const csv = f.downloads[0].data.replace(/^\ufeff/, '').split(/\r?\n/).filter(Boolean);
  assert.ok(csv.every(line => line.split(',').length === 8), 'Existing summary CSV remains eight columns.');
  assert.equal(csv.filter(line => line.startsWith('"행정동",')).length, data.byDong.length);
  assert.equal(f.unchanged(), true, 'Report aggregation does not rewrite source records or their dates.');
});

test('report counts inspection records and current conditions separately and discloses whole-session cumulative patrol scope', async () => {
  const patrols = [
    { id: 'p1', start: at('19:00'), dong: '전체', dist: 6000, passed: ['active', 'elsewhere'], marks: [{ id: 'active' }, { id: 'elsewhere' }] },
    { id: 'p2', start: at('21:00'), dong: '전체', dist: 4000, passed: ['active'], marks: [{ id: 'active' }] }
  ];
  const f = await fixture({ inspections: [firstNormal, secondNormal], patrols, dong: '동명동' }), data = f.data();
  assert.equal(data.ins.length, 2); assert.equal(new Set(data.ins.map(row => row.lightId)).size, 1);
  assert.equal(data.ins.filter(row => row.result === '고장').length, 0);
  assert.equal(data.open.length, 1); assert.equal(data.open[0].status, '고장', 'Current conditions are not replaced with the period inspection verdict.');
  assert.equal(data.pats.length, 2); assert.equal(data.pats.reduce((sum, row) => sum + row.dist, 0), 10000);
  assert.equal(data.pats.reduce((sum, row) => sum + row.passed.length, 0), 3);
  assert.equal(new Set(data.pats.flatMap(row => row.passed)).size, 2, 'Whole-session visits intentionally retain repetitions and other districts.');
  const text = strip(f.html());
  assert.match(text, /점검\s*기록|반복 점검|중복 점검|같은 시설|동일 시설/, 'The output explains that inspection counts are records rather than distinct facilities.');
  assert.match(text, /현재\s*(?:대장|현황)|출력\s*시점|작성\s*시점/, 'The output dates or separates current registry conditions.');
  assert.match(text, /세션\s*전체|순찰(?:\s*기록)?\s*전체|전체\s*(?:세션|순찰|구간)/, 'Selecting a district does not imply that session distances were cut to that district.');
  assert.match(text, /누적|중복 포함|중복포함/, 'Repeated patrol passages are disclosed as cumulative.');
  assert.equal(f.unchanged(), true);
});

test('all-details print mode includes normal and repeated records while default issues mode retains the existing abnormal list', async () => {
  const f = await fixture(), codes = new Set(['PERIOD-NORMAL', 'PERIOD-FAULT']);
  const detailCodes = html => [...html.matchAll(/<(?:b|strong)\b[^>]*>([^<]*)<\/(?:b|strong)>/g)].map(match => match[1]).filter(code => codes.has(code));
  f.rep.detail = 'issues';
  assert.deepEqual(detailCodes(f.html()), ['PERIOD-FAULT']);
  const before = f.data(); f.rep.detail = 'all';
  assert.deepEqual(detailCodes(f.html()), ['PERIOD-NORMAL', 'PERIOD-NORMAL', 'PERIOD-FAULT'], 'Every selected inspection record is printed, including repeated normal inspections of one facility.');
  assert.deepEqual(f.data(), before, 'The detail display choice never changes report aggregation.');
  assert.equal(f.unchanged(), true);
});

test('report provenance uses both query metadata and never claims artifact or unknown records are a complete device query', async () => {
  const cases = [
    { dbMode: 'artifact', metadata: { inspections: { source: 'artifact', complete: false }, patrols: { source: 'artifact', complete: false } } },
    { dbMode: 'local', metadata: { inspections: { source: 'unknown', complete: false }, patrols: { source: 'unknown', complete: false } } },
    { dbMode: 'local', metadata: { inspections: { source: 'local', complete: true }, patrols: { source: 'unknown', complete: false } } }
  ];
  for (const options of cases) {
    const f = await fixture(options), text = strip(f.html());
    const sourceText = text.match(/자료 출처:\s*(.*?)\s*내역 범위:/)?.[1];
    assert.ok(sourceText, 'The printable report identifies the query source.');
    assert.doesNotMatch(sourceText, /이 기기 기록|전체 조회/, 'A non-complete query must not be presented as verified complete local records.');
    assert.match(sourceText, /전체 여부 미확인/, 'Either incomplete query makes the combined period report completeness unconfirmed.');
    assert.equal(f.data().ins.length, 3, 'Provenance wording must not remove or rewrite returned inspection records.');
    assert.equal(f.unchanged(), true);
  }
});

test('period reports anchor month, trend and output dates in Korean time on Seoul and UTC devices', async () => {
  const originalTimezone = process.env.TZ;
  const now = Date.parse('2026-12-01T01:00:00+09:00');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const november = { ...firstNormal, date: Date.parse('2026-11-30T23:59:59+09:00') };
  const december = { ...secondNormal, date: Date.parse('2026-12-01T00:00:00+09:00') };
  try {
    for (const tz of ['Asia/Seoul', 'UTC']) {
      process.env.TZ = tz;
      const thisMonth = await fixture({ clock: Clock, period: { period: 'month' }, inspections: [november, december] });
      assert.deepEqual(thisMonth.data().ins.map(row => row.id), [december.id], tz);
      assert.equal(thisMonth.data().a, december.date, tz);
      assert.equal(thisMonth.context.repMonthKey(december.date), '2026.12', tz);
      assert.equal(thisMonth.queries.find(row => row.collection === 'inspections').where[0][2], Date.parse('2026-07-01T00:00:00+09:00'), tz);

      const lastMonth = await fixture({ clock: Clock, period: { period: 'last' }, inspections: [november, december] });
      assert.deepEqual(lastMonth.data().ins.map(row => row.id), [november.id], tz);
      assert.equal(lastMonth.data().b, december.date - 1, tz);
      assert.match(lastMonth.html(), /기간 2026\.11\.01 ~ 2026\.11\.30/, tz);

      const day = await fixture({ clock: Clock, period: { period: 'custom', from: '2026-12-01', to: '2026-12-01' }, inspections: [november, december] });
      assert.deepEqual(day.data().ins.map(row => row.id), [december.id], tz);
      assert.match(day.html(), /기간 2026\.12\.01 ~ 2026\.12\.01/, tz);
      assert.match(day.context.repSummaryText(), /2026\.12\.01~2026\.12\.01/, tz);
      await day.context.exportReportCSV();
      assert.equal(day.downloads[0].filename, '동구가로등_보고서_20261201-20261201.csv', tz);
    }
  } finally {
    if (originalTimezone == null) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
