/* Preparation-file contract only. No official service requests, raw notes or personal data are retained. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGOfficialReportImportCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SOURCE = 'gjd-roadlighting', MAX_BYTES = 2 * 1024 * 1024, MAX_ROWS = 1000;
  const FIELDS = ['external_report_id', 'lamp_id', 'issue', 'received_at', 'status'];
  const ISSUES = { off: '불이 꺼져 있어요', flicker: '깜빡거려요', day_on: '낮에도 켜져 있어요', broken: '등이 파손됐어요', leaning: '기둥이 기울었어요', exposed_wire: '전선이 노출됐어요', other: '기타' };
  const STATUS = { received: '접수', processing: '처리중', completed: '완료', cancelled: '취소' };
  const fail = (message, code = 'invalid-argument') => { throw Object.assign(new Error(message), { code }); };
  function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function read(value, name) { const p = plain(value) && Object.getOwnPropertyDescriptor(value, name); return p && Object.hasOwn(p, 'value') ? p.value : undefined; }
  function identifier(value, field, lamp = false) {
    if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value < 0) fail(field + ' 형식을 확인해 주세요.'); value = String(value); }
    if (typeof value !== 'string') fail(field + ' 형식을 확인해 주세요.');
    value = value.trim();
    if (!(lamp ? /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣_-]{0,119}$/ : /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣_.:/-]{0,119}$/).test(value)) fail(field + ' 형식을 확인해 주세요.');
    return value;
  }
  function choice(value, options, label) {
    if (typeof value !== 'string') fail(label + ' 형식을 확인해 주세요.');
    const text = value.trim();
    if (Object.hasOwn(options, text)) return text;
    const key = Object.keys(options).find(key => options[key] === text);
    if (!key) fail(label + '은 준비 양식에 정한 값으로 입력해 주세요.');
    return key;
  }
  function timestamp(value) {
    if (typeof value === 'number') { if (Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime())) return value; fail('접수 시각을 확인해 주세요.'); }
    if (typeof value !== 'string') fail('접수 시각을 확인해 주세요.');
    const text = value.trim();
    if (/^\d{1,16}$/.test(text)) return timestamp(Number(text));
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(text);
    if (!m) fail('접수 시각은 날짜 또는 시간대가 있는 ISO 날짜로 입력해 주세요.');
    const year = +m[1], month = +m[2], day = +m[3], leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || (m[4] && (+m[4] > 23 || +m[5] > 59 || +m[6] > 59))) fail('접수 시각의 달력 날짜를 확인해 주세요.');
    const result = Date.parse(m[4] ? text : text + 'T00:00:00+09:00');
    if (!Number.isSafeInteger(result) || result <= 0) fail('접수 시각을 확인해 주세요.');
    return result;
  }
  function normalized(value, index) {
    if (!plain(value)) fail((index + 1) + '행의 신고 형식을 확인해 주세요.');
    try {
      const issue = choice(read(value, 'issue'), ISSUES, '고장 유형');
      return { externalId: identifier(read(value, 'externalId'), '신고 식별자'), lampId: identifier(read(value, 'lampId'), '운영 시설번호', true), issue: ISSUES[issue], receivedAt: timestamp(read(value, 'receivedAt')), sourceStatus: choice(read(value, 'sourceStatus'), STATUS, '원본 처리 상태') };
    } catch (error) { fail((index + 1) + '행: ' + error.message); }
  }
  function normalizeRows(values) {
    if (!Array.isArray(values) || !values.length || values.length > MAX_ROWS) fail('신고는 1–1,000행으로 나누어 준비해 주세요.');
    return values.map(normalized);
  }
  function csv(text) {
    const records = []; let record = [], field = '', quoted = false, afterQuote = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; afterQuote = true; } } else field += ch; continue; }
      if (ch === ',' || ch === '\r' || ch === '\n') {
        record.push(field); field = ''; afterQuote = false;
        if (ch !== ',') { if (ch === '\r' && text[i + 1] === '\n') i++; records.push(record); record = []; if (records.length > MAX_ROWS + 2) fail('신고는 1–1,000행으로 나누어 준비해 주세요.'); }
      } else if (ch === '"') { if (field || afterQuote) fail('CSV 따옴표 형식을 확인해 주세요.'); quoted = true; }
      else { if (afterQuote) fail('CSV 따옴표 뒤의 구분자를 확인해 주세요.'); field += ch; }
    }
    if (quoted) fail('CSV 따옴표가 닫히지 않았어요.');
    if (field || record.length || afterQuote) { record.push(field); records.push(record); }
    return records.filter(r => !(r.length === 1 && r[0] === ''));
  }
  function parse(value, format) {
    if (typeof value !== 'string') fail('UTF-8 준비 파일을 선택해 주세요.');
    if (new TextEncoder().encode(value).byteLength > MAX_BYTES) fail('준비 파일은 최대 2MiB예요. 파일을 나누어 주세요.');
    const text = value.replace(/^\ufeff/, ''); let input, ignoredFieldCount = 0;
    if (format === 'csv') {
      const records = csv(text), header = records.shift();
      if (!header || new Set(header).size !== header.length || FIELDS.some(field => !header.includes(field))) fail('CSV의 필수 열과 중복된 열 이름을 확인해 주세요.');
      ignoredFieldCount = records.length * header.filter(name => !FIELDS.includes(name)).length;
      input = records.map((record, index) => {
        if (record.length !== header.length) fail((index + 2) + '행의 CSV 열 수를 확인해 주세요.');
        const out = Object.create(null); for (const field of FIELDS) out[field] = record[header.indexOf(field)]; return out;
      });
    } else if (format === 'json') {
      let parsed; try { parsed = JSON.parse(text); } catch (_) { fail('JSON 준비 파일의 형식을 확인해 주세요.'); }
      if (Array.isArray(parsed)) input = parsed;
      else if (plain(parsed) && read(parsed, 'schemaVersion') === 1 && Array.isArray(read(parsed, 'reports'))) input = read(parsed, 'reports');
      else fail('지원하는 준비 양식 버전을 확인해 주세요.');
      for (const item of input) if (plain(item)) ignoredFieldCount += Object.keys(item).filter(name => !FIELDS.includes(name)).length;
    } else fail('CSV 또는 JSON 준비 파일을 선택해 주세요.');
    const rows = normalizeRows(input.map(item => ({ externalId: read(item, 'external_report_id'), lampId: read(item, 'lamp_id'), issue: read(item, 'issue'), receivedAt: read(item, 'received_at'), sourceStatus: read(item, 'status') })));
    return { rows, ignoredFieldCount };
  }
  const reportId = id => 'official-file-report-' + encodeURIComponent(SOURCE) + '~' + encodeURIComponent(id);
  const receiptText = value => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  const linkedText = (value, max, required = false) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && (!required || !!value.trim());
  const shape = row => JSON.stringify([row.lampId, row.issue, row.receivedAt, row.sourceStatus]);
  const reason = { new: '시설 연결 확인 · 신규', duplicate: '이미 있거나 파일에서 반복된 신고', unmatched: '활성 시설번호 일치 없음', ambiguous: '같은 운영 시설번호가 여러 시설에 있음', closed: '운영 원본 종결·취소 건', conflict: '같은 신고 식별자의 내용 또는 대상 ID가 충돌함' };
  function plan(values, options = {}) {
    const normalized = normalizeRows(values), lights = Array.isArray(options.lights) ? options.lights : [], reports = Array.isArray(options.reports) ? options.reports : [];
    const groups = new Map(), byLamp = new Map(), byId = new Map(), receipts = new Set();
    for (const row of normalized) { const group = groups.get(row.externalId) || []; group.push(row); groups.set(row.externalId, group); }
    for (const light of lights) {
      if (!plain(light) || read(light, 'removed')) continue;
      let lamp; try { lamp = identifier(read(light, 'lampId'), '운영 시설번호', true); } catch (_) { continue; }
      const group = byLamp.get(lamp) || []; group.push(light); byLamp.set(lamp, group);
    }
    for (const existing of reports) {
      if (!plain(existing)) continue;
      const id = read(existing, 'id'), receipt = read(existing, 'receipt');
      if (typeof id === 'string') { const group = byId.get(id) || []; group.push(existing); byId.set(id, group); }
      if (receiptText(receipt) !== null) receipts.add(receiptText(receipt));
    }
    const seen = new Set(), counts = { total: normalized.length, new: 0, duplicate: 0, unmatched: 0, ambiguous: 0, closed: 0, conflict: 0 };
    const rows = normalized.map(row => {
      const id = reportId(row.externalId), occupied = byId.get(id), matches = byLamp.get(row.lampId) || [], light = matches.length === 1 ? matches[0] : null;
      let decision;
      if (new Set(groups.get(row.externalId).map(shape)).size > 1 || occupied && (occupied.length !== 1 || receiptText(read(occupied[0], 'receipt')) !== row.externalId)) decision = 'conflict';
      else if (occupied || receipts.has(row.externalId) || seen.has(row.externalId)) decision = 'duplicate';
      else if (['completed', 'cancelled'].includes(row.sourceStatus)) decision = 'closed';
      else if (matches.length > 1) decision = 'ambiguous';
      else if (!light || !linkedText(read(light, 'id'), 180, true) || read(light, 'id').includes('/') || !linkedText(read(light, 'code'), 200, true)) decision = 'unmatched';
      else decision = 'new';
      seen.add(row.externalId); counts[decision]++;
      return { ...row, reportId: id, lightId: light && typeof read(light, 'id') === 'string' ? read(light, 'id') : null, code: light && typeof read(light, 'code') === 'string' ? read(light, 'code').slice(0, 200) : '', dong: light && typeof read(light, 'dong') === 'string' ? read(light, 'dong').slice(0, 100) : '', decision, reason: reason[decision] };
    });
    return { rows, counts };
  }
  function report(value, actor) {
    const row = normalized(value, 0);
    if (actor !== 'local' || ['completed', 'cancelled'].includes(row.sourceStatus) || read(value, 'decision') !== 'new' || read(value, 'reportId') !== reportId(row.externalId) || !linkedText(read(value, 'lightId'), 180, true) || read(value, 'lightId').includes('/') || !linkedText(read(value, 'code'), 200, true) || !linkedText(read(value, 'dong'), 100)) fail('시설 연결을 확인한 체험 신고만 만들 수 있어요.');
    return { issue: row.issue, location: '', dong: read(value, 'dong') || '', code: read(value, 'code'), lightId: read(value, 'lightId'), desc: '운영서비스 파일 반입 준비 · 원본 상태: ' + STATUS[row.sourceStatus], via: '기타', receipt: row.externalId, contact: '', status: '접수', createdAt: row.receivedAt, reporterId: actor };
  }
  function template(format) {
    const data = { external_report_id: 'SAMPLE-0001', lamp_id: '001', issue: 'off', received_at: '2026-11-08T10:00:00+09:00', status: 'received' };
    if (format === 'json') return JSON.stringify({ schemaVersion: 1, reports: [data] }, null, 2) + '\n';
    if (format === 'csv') return '\ufeff' + FIELDS.join(',') + '\r\n' + FIELDS.map(key => data[key]).join(',') + '\r\n';
    fail('CSV 또는 JSON 준비 양식을 선택해 주세요.');
  }
  return { parse, template, plan, report, normalizeRows, reportId, issues: ISSUES, statusLabels: STATUS, limits: { bytes: MAX_BYTES, rows: MAX_ROWS } };
});
