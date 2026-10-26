/* Pure helpers for follow-up work, evidence evaluation, and preview-only imports. */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./lighting-model.js') : root.DGLightingModel, node ? require('node:crypto').webcrypto : root.crypto);
  if (node) module.exports = api;
  root.DGLightingWorkflowCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function (Model, crypto) {
  'use strict';
  const MODEL_VERSION = 'relative-screening-20261026-v3', RUN_BYTES = 600000, IMPORT_BYTES = 5000000, IMPORT_ROWS = 5000;
  const fail = (message, code = 'invalid-argument') => { throw Object.assign(new Error(message), { code }); };
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function text(value, max, label, required = false) { if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(label + '을 확인해 주세요.'); return value.trim(); }
  function number(value, min, max, label, integer = false) {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || typeof value === 'string' && !value.trim()) fail(label + '을 입력해 주세요.');
    const n = Number(value); if (!Number.isFinite(n) || n < min || n > max || integer && !Number.isSafeInteger(n)) fail(label + ' 범위를 확인해 주세요.'); return n;
  }
  function id(value, optional = false) { const s = text(value, 180, '식별자', !optional); if (s && (!/^[A-Za-z0-9_-]+$/.test(s) || ['__proto__', 'prototype', 'constructor'].includes(s))) fail('식별자 형식을 확인해 주세요.'); return s; }
  function list(value, max) { if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length) fail('연결 기록 목록을 확인해 주세요.'); return value.map(x => id(x)); }
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
  async function digest(value) { if (!crypto?.subtle) fail('HTTPS 연결과 브라우저의 저장 지원을 확인해 주세요.'); return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(x => x.toString(16).padStart(2, '0')).join(''); }
  function distance(a, b) { const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2; return 12742000 * Math.asin(Math.min(1, Math.sqrt(x))); }
  function normalizeTask(input) {
    if (!plain(input)) fail('재확인 업무를 확인해 주세요.');
    if (!['candidate', 'record', 'patrol', 'manual'].includes(input.originKind) || !['open', 'completed', 'cancelled'].includes(input.status)) fail('재확인 업무의 종류와 상태를 확인해 주세요.');
    const out = { title: text(input.title, 120, '제목', true), lat: number(input.lat, -90, 90, '위도'), lng: number(input.lng, -180, 180, '경도'), radius: number(input.radius, 5, 80, '확인 범위'), note: text(input.note || '', 1500, '메모'), originKind: input.originKind, originId: text(input.originId || '', 180, '원본 기록'), evidenceIds: list(input.evidenceIds || [], 20), assignedTo: text(input.assignedTo, 128, '담당자', true), dueAt: number(input.dueAt, 1, Number.MAX_SAFE_INTEGER, '기한', true), reviewMinute: number(input.reviewMinute, 0, 1439, '확인 시간', true), status: input.status,
      observationId: id(input.observationId || '', true), completionNote: text(input.completionNote || '', 1000, '확인 결과'), completedAt: number(input.completedAt || 0, 0, Number.MAX_SAFE_INTEGER, '완료 시각', true), completedBy: text(input.completedBy || '', 128, '완료자') };
    if (out.status === 'completed' ? !out.observationId || !out.completionNote || !out.completedAt || !out.completedBy : out.observationId || out.completedAt || out.completedBy) fail('완료 상태와 현장 관찰 연결을 확인해 주세요.');
    return out;
  }
  function checkCompletion(task, record, now) {
    if (!record || record.kind !== 'observation' || !['bright', 'adequate', 'dark'].includes(record.level)) fail('밝음·보통·어두움 현장 관찰을 먼저 저장해 주세요.', 'failed-precondition');
    const normalized = Model.normalizeRecord(record, { now }), state = Model.recordState(normalized, { now, minute: task.reviewMinute });
    if (!state.active) fail('야간 확인·관찰 시간대·재확인 기한을 만족하는 기록이 필요해요.', 'failed-precondition');
    if (normalized.observedAt < task.createdAt - 300000) fail('업무 등록 후 방문한 현장 관찰을 연결해 주세요.', 'failed-precondition');
    if (distance(task, normalized) > task.radius + normalized.radius) fail('재확인 지점과 현장 관찰 범위가 겹치지 않아요.', 'failed-precondition');
    return normalized;
  }
  function parsed(value, max, label, array) { if (typeof value === 'string' && value.length > max) fail(label + '는 최대 ' + max.toLocaleString() + '자예요. 지역을 나눠 검토해 주세요. 일부 행만 보관하지 않아요.', 'resource-exhausted'); const s = text(value, max, label, true); let out; try { out = JSON.parse(s); } catch (_) { fail(label + ' JSON을 읽을 수 없어요.'); } if (array ? !Array.isArray(out) : !plain(out)) fail(label + ' 형식을 확인해 주세요.'); return { s, value: out }; }
  function normalizeRun(input) {
    if (!plain(input)) fail('검토 실행 이력을 확인해 주세요.');
    if (!['roads', 'pairs'].includes(input.mode) || !/^[a-f0-9]{64}$/.test(input.inputDigest || '')) fail('검토 방식과 자료 지문을 확인해 주세요.');
    const versions = parsed(input.inputVersionsJson, 300000, '자료 버전', false), settings = parsed(input.settingsJson, 12000, '모델 설정', false), candidates = parsed(input.candidatesJson, 300000, '전체 후보', true), evaluation = parsed(input.evaluationJson, 180000, '관찰 비교', false);
    const out = { modelVersion: text(input.modelVersion, 64, '모델 버전', true), reviewedAt: number(input.reviewedAt, 1, Number.MAX_SAFE_INTEGER, '검토 시각', true), minute: number(input.minute, 0, 1439, '한국 시간', true), mode: input.mode, dong: text(input.dong || '', 80, '검토 지역'), facilityKind: text(input.facilityKind || '', 30, '시설 종류'), registryCount: number(input.registryCount, 0, 100000, '대장 건수', true), contextCount: number(input.contextCount, 0, 100000, '보완 자료 건수', true), roadCount: number(input.roadCount, 0, 100000, '도로 건수', true), candidateCount: number(input.candidateCount, 0, 100000, '후보 건수', true), inputDigest: input.inputDigest, inputVersionsJson: versions.s, settingsJson: settings.s, candidatesJson: candidates.s, evaluationJson: evaluation.s };
    if (!Array.isArray(versions.value.registry) || !Array.isArray(versions.value.context) || versions.value.registry.length !== out.registryCount || versions.value.context.length !== out.contextCount || candidates.value.length !== out.candidateCount) fail('전체 건수와 저장할 목록이 일치하지 않아요. 일부 목록만 보관할 수 없어요.');
    for (const tuple of [...versions.value.registry, ...versions.value.context]) if (!Array.isArray(tuple) || typeof tuple[0] !== 'string' || !tuple[0] || tuple[0].length > 180 || !Number.isSafeInteger(tuple[1]) || tuple[1] < 0) fail('자료의 식별자·버전 목록을 확인해 주세요.');
    for (const row of candidates.value) if (!plain(row) || typeof row.title !== 'string' || !Number.isFinite(row.lat) || Math.abs(row.lat) > 90 || !Number.isFinite(row.lng) || Math.abs(row.lng) > 180 || !Number.isFinite(row.base) || row.base < 0 || !Number.isFinite(row.adjusted) || row.adjusted < row.base) fail('검토 후보의 위치와 모델 값을 확인해 주세요.');
    if (!Array.isArray(evaluation.value.rows) || !Array.isArray(evaluation.value.excluded) || !plain(evaluation.value.counts) || evaluation.value.rows.length !== evaluation.value.counts.compared) fail('현장 비교 결과가 완전하지 않아요.');
    const counts = evaluation.value.counts;
    for (const key of ['compared', 'baseMatched', 'adjustedMatched', 'baseMissedDark', 'adjustedMissedDark', 'baseWeakButBright', 'adjustedWeakButBright']) if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) fail('현장 비교 집계를 확인해 주세요.');
    if (counts.baseMatched + counts.baseMissedDark + counts.baseWeakButBright !== counts.compared || counts.adjustedMatched + counts.adjustedMissedDark + counts.adjustedWeakButBright !== counts.compared) fail('현장 비교 집계와 전체 건수가 달라요.');
    for (const row of evaluation.value.rows) if (!plain(row) || typeof row.id !== 'string' || typeof row.label !== 'string' || !['bright', 'adequate', 'dark'].includes(row.level) || !Number.isFinite(row.base) || row.base < 0 || !Number.isFinite(row.adjusted) || row.adjusted < row.base || typeof row.baseMatch !== 'boolean' || typeof row.adjustedMatch !== 'boolean') fail('현장 비교의 개별 기록을 확인해 주세요.');
    for (const row of evaluation.value.excluded) if (!plain(row) || typeof row.id !== 'string' || typeof row.label !== 'string' || typeof row.reason !== 'string') fail('현장 비교 제외 사유를 확인해 주세요.');
    const payloadBytes = bytes(out); if (payloadBytes > RUN_BYTES) fail('검토 이력이 600KB를 넘어요. 지역을 나눠 다시 검토하거나 현재 결과를 파일로 내려받으세요. 일부 결과만 저장하지는 않아요.', 'resource-exhausted');
    if (input.payloadBytes !== undefined && input.payloadBytes !== payloadBytes) fail('검토 이력의 크기 정보가 일치하지 않아요.');
    return { ...out, payloadBytes };
  }
  function evaluateObservations(records, lights, options) {
    const ctx = Model.createContext(records, lights, options), rows = [], excluded = [];
    const counts = { compared: 0, baseMatched: 0, adjustedMatched: 0, baseMissedDark: 0, adjustedMissedDark: 0, baseWeakButBright: 0, adjustedWeakButBright: 0 };
    for (const r of ctx.records.filter(r => r.kind === 'observation')) {
      const state = Model.recordState(r, options);
      if (!state.active || !['bright', 'adequate', 'dark'].includes(r.level)) { excluded.push({ id: r.id, label: r.label, reason: state.reason || 'unknown_observation' }); continue; }
      const base = options.baseAt(r), result = Model.evaluate(ctx, r, base);
      if (result.fieldLevel === 'conflict') { excluded.push({ id: r.id, label: r.label, reason: 'conflict' }); continue; }
      const bright = r.level !== 'dark', baseBright = base >= ctx.weak, adjustedBright = result.adjusted >= ctx.weak;
      counts.compared++; counts.baseMatched += Number(bright === baseBright); counts.adjustedMatched += Number(bright === adjustedBright);
      counts.baseMissedDark += Number(!bright && baseBright); counts.adjustedMissedDark += Number(!bright && adjustedBright);
      counts.baseWeakButBright += Number(bright && !baseBright); counts.adjustedWeakButBright += Number(bright && !adjustedBright);
      rows.push({ id: r.id, label: r.label, lat: r.lat, lng: r.lng, observedAt: r.observedAt, level: r.level, base, adjusted: result.adjusted, baseMatch: bright === baseBright, adjustedMatch: bright === adjustedBright, lux: r.lux });
    }
    for (const r of ctx.invalidRecords) excluded.push({ id: r.id, label: r.label, reason: 'invalid_record' });
    return { at: ctx.now, minute: ctx.minute, weak: ctx.weak, counts, rows, excluded };
  }
  async function buildRun({ review, lights, records, roads, model, calibration, baseAt }) {
    const areaScope = { records: review.areas || [], summary: review.areaSummary || {}, automaticExclusions: review.automaticExclusions || {} };
    const now = review.at, evaluation = evaluateObservations(records, lights, { now, minute: review.minute, weak: model.weak, baseAt });
    const candidates = review.cands.map(c => ({ title: c.a ? c.a.code + ' ↔ ' + c.b.code : c.name, dong: c.dong || '', lat: c.mid.lat, lng: c.mid.lng, length: c.len ?? null, classification: c.context.classification, base: c.context.base, adjusted: c.context.adjusted, coverage: c.context.coverage, sourceIds: c.context.sources.map(x => x.id), observationIds: c.context.observations.map(x => x.id), scopeException: c.scopeException || [] }));
    const versions = { registry: lights.map(l => [l.id, l.revision || 0, l.updatedAt || 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), context: records.map(r => [r.id, r.revision || 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), roads: { version: roads?.ver || 0, at: roads?.at || 0 }, reviewAreas: areaScope };
    const data = { modelVersion: MODEL_VERSION, reviewedAt: now, minute: review.minute, mode: review.mode, dong: review.dong || '', facilityKind: review.kind || '', registryCount: lights.length, contextCount: records.length, roadCount: roads?.ways?.length || 0, candidateCount: candidates.length, inputDigest: await digest({ lights, records, roads: roads || null, model, calibration: calibration || null, areaScope }), inputVersionsJson: JSON.stringify(versions), settingsJson: JSON.stringify({ model, calibration: calibration || null }), candidatesJson: JSON.stringify(candidates), evaluationJson: JSON.stringify(evaluation) };
    return normalizeRun(data);
  }
  function parseCSV(input) {
    const rows = [], row = []; let cell = '', quoted = false, afterQuote = false;
    const push = () => { row.push(cell); cell = ''; afterQuote = false; };
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (quoted) { if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') { quoted = false; afterQuote = true; } else cell += c; continue; }
      if (c === '"') { if (cell || afterQuote) fail('CSV 따옴표 형식을 확인해 주세요.'); quoted = true; }
      else if (c === ',') push();
      else if (c === '\n' || c === '\r') { if (c === '\r' && input[i + 1] === '\n') i++; push(); if (row.some(x => x !== '')) rows.push(row.splice(0)); else row.length = 0; }
      else { if (afterQuote && c.trim()) fail('CSV 닫는 따옴표 뒤에는 구분자만 사용할 수 있어요.'); if (!afterQuote) cell += c; }
    }
    if (quoted) fail('CSV 따옴표가 닫히지 않았어요.');
    push(); if (row.some(x => x !== '')) rows.push(row);
    if (rows.length < 2) fail('제목 행과 자료 행이 있는 CSV를 선택해 주세요.');
    const headers = rows.shift().map(x => x.replace(/^\ufeff/, '').trim());
    if (headers.some(x => !x || ['__proto__', 'prototype', 'constructor'].includes(x)) || new Set(headers).size !== headers.length) fail('CSV 열 이름은 비어 있거나 중복될 수 없어요.');
    return { headers, rows: rows.map((r, index) => r.length !== headers.length ? { _row: index + 2, _error: '열 개수가 제목 행과 달라요.' } : { ...Object.fromEntries(headers.map((h, i) => [h, r[i]])), _row: index + 2 }) };
  }
  function parseImport(input, name = '') {
    if (typeof input !== 'string' || bytes(input) > IMPORT_BYTES) fail('반입 파일은 UTF-8 텍스트 5MB 이내로 나눠 주세요.');
    const clean = input.replace(/^\ufeff/, ''); let parsed;
    if (/\.geojson$|\.json$/i.test(name) || /^\s*\{/.test(clean)) {
      let geo; try { geo = JSON.parse(clean); } catch (_) { fail('GeoJSON을 읽을 수 없어요.'); }
      if (geo?.type !== 'FeatureCollection' || !Array.isArray(geo.features)) fail('Point 지점의 GeoJSON FeatureCollection이 필요해요.');
      const rows = geo.features.map((f, i) => {
        if (f?.type !== 'Feature' || f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates) || f.geometry.coordinates.length < 2 || !plain(f.properties || {})) return { _row: i + 1, _error: 'Point 좌표와 속성이 필요해요.' };
        return { ...(f.properties || {}), longitude: f.geometry.coordinates[0], latitude: f.geometry.coordinates[1], _row: i + 1 };
      });
      parsed = { headers: [...new Set(rows.flatMap(r => Object.keys(r).filter(k => !k.startsWith('_'))))], rows };
    } else parsed = parseCSV(clean);
    if (!parsed.rows.length || parsed.rows.length > IMPORT_ROWS) fail('한 번에 1~5,000개 지점을 반입할 수 있어요. 파일을 나눠 주세요.');
    return parsed;
  }
  const agencyIdentity = value => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const importIdentity = (agency, sourceId) => agencyIdentity(agency) + '\u0000' + sourceId.trim();
  function importTime(value, now) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number' || /^\d{12,16}$/.test(value)) return number(value, 1, now + 300000, '원본 갱신 시각', true);
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) fail('원본 갱신일은 YYYY-MM-DD 또는 ISO 날짜·시각을 사용해 주세요.');
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value.slice(0, 10)) fail('원본 갱신일의 날짜가 유효하지 않아요.');
    const kst = value.length === 10 ? value + 'T00:00:00+09:00' : /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : value + '+09:00';
    return number(Date.parse(kst), 1, now + 300000, '원본 갱신 시각', true);
  }
  async function previewImport(parsed, mapping, options) {
    const now = number(options.now, 1, Number.MAX_SAFE_INTEGER, '반입 시각', true), agency = text(options.agency, 100, '원본 관리기관', true), dataset = text(options.dataset, 300, '자료 출처', true), batchId = id(options.batchId);
    for (const field of ['sourceRecordId', 'label', 'lat', 'lng']) if (!parsed.headers.includes(mapping[field])) fail('기관 시설 ID·이름·위도·경도의 열을 연결해 주세요.');
    const existing = new Map((options.existing || []).filter(r => r.sourceAgency && r.sourceRecordId).map(r => [importIdentity(r.sourceAgency, r.sourceRecordId), r])), ids = new Set((options.existing || []).map(r => r.id)), seen = new Set(), rows = [];
    const nearby = [...(options.existing || []), ...(options.registry || [])].filter(r => !r.removed && Number.isFinite(r.lat) && Number.isFinite(r.lng));
    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      try {
        if (row._error) fail(row._error);
        const sourceId = text(String(row[mapping.sourceRecordId] ?? ''), 180, '기관 시설 ID', true), label = text(String(row[mapping.label] ?? ''), 100, '광원 이름', true), key = importIdentity(agency, sourceId), recordId = 'external-' + await digest(key);
        if (seen.has(key)) { rows.push({ row: row._row, status: 'duplicate', label, sourceId, message: '이 파일 안에 같은 기관 시설 ID가 있어요.' }); continue; } seen.add(key);
        if (existing.has(key) || ids.has(recordId)) { const old = existing.get(key); rows.push({ row: row._row, status: 'protected', label, sourceId, recordId: old?.id || recordId, message: '기존 기록과 현장 수정은 보존해요. 새 자료로 덮어쓰지 않아요.' }); continue; }
        const sourceUpdatedAt = mapping.sourceUpdatedAt ? importTime(row[mapping.sourceUpdatedAt], now) : 0;
        const data = Model.normalizeRecord({ kind: 'source', label, category: 'other_public', operator: mapping.operator ? String(row[mapping.operator] || agency) : agency, lat: row[mapping.lat], lng: row[mapping.lng], radius: mapping.radius && row[mapping.radius] !== '' && row[mapping.radius] != null ? row[mapping.radius] : 20, strength: 'medium', status: 'unknown', level: 'unknown', schedule: 'unknown', startMinute: 1080, endMinute: 360, observedAt: sourceUpdatedAt || now, validDays: 90, nightConfirmed: false, lux: null, instrument: '', note: '기관 자료 반입 · 실제 야간 점등과 적용 범위는 현장 확인 필요', linkedLightId: '', distinct: false, removed: false, sourceAgency: agency, sourceRecordId: sourceId, sourceDataset: dataset, sourceUpdatedAt, importedAt: now, importBatchId: batchId }, { now });
        const close = nearby.find(r => distance(r, data) <= 5);
        rows.push({ row: row._row, status: 'new', label, sourceId, recordId, data, message: close ? '5m 이내 기존 광원·시설이 있어요. 반입 후 별개 시설인지 확인해 주세요.' : '신규 · 야간·점등·시간 정보 미확인으로 반입' });
        nearby.push(data);
      } catch (error) { rows.push({ row: row._row, status: 'invalid', label: String(row[mapping.label] || '').slice(0, 100), sourceId: String(row[mapping.sourceRecordId] || '').slice(0, 180), message: error.message }); }
      if (options.yield && i % 50 === 49) await options.yield();
    }
    return { batchId, at: now, agency, dataset, total: rows.length, rows, counts: Object.fromEntries(['new', 'protected', 'duplicate', 'invalid'].map(status => [status, rows.filter(r => r.status === status).length])) };
  }
  return Object.freeze({ MODEL_VERSION, RUN_BYTES, IMPORT_BYTES, IMPORT_ROWS, fail, text, number, id, canonical, bytes, digest, distance, normalizeTask, checkCompletion, normalizeRun, evaluateObservations, buildRun, parseImport, previewImport, importIdentity });
});
