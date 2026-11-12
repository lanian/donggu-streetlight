/* Inspection evidence: an unanswered check is never an implicit pass. */
(function (root, factory) {
  const data = typeof module === 'object' && module.exports ? require('./data.js') : root.DGData;
  const api = factory(data);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGInspectionCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (data) {
  'use strict';
  const VALUES = ['ok', 'bad', 'uninspected', 'na'];
  const READING_UNITS = { insulationResistance: 'MΩ', leakageCurrent: 'mA' };
  const clean = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  function fail(message) { throw Object.assign(new Error(message), { code: 'invalid-argument' }); }
  function prepare(source, codes, actor, at) {
    const checks = {}, checkReasons = {}, memo = clean(source.memo, 1000);
    for (const key of codes) {
      const value = source.checks?.[key] || 'uninspected';
      if (!VALUES.includes(value)) fail('점검 항목의 확인 상태를 확인해 주세요.');
      checks[key] = value;
      if (value === 'uninspected' || value === 'na') {
        const reason = clean(source.checkReasons?.[key] || memo, 300);
        if (!reason) fail('미실시·해당 없음 항목의 사유를 적어 주세요.');
        checkReasons[key] = reason;
      }
    }
    const inspectionComplete = codes.every(key => checks[key] !== 'uninspected') && codes.some(key => ['ok', 'bad'].includes(checks[key]));
    const bad = codes.filter(key => checks[key] === 'bad');
    let result = source.result;
    if (!['정상', '점검필요', '고장'].includes(result)) fail('점검 결과를 선택해 주세요.');
    if (bad.some(key => ['lamp', 'leak', 'pole'].includes(key))) result = '고장';
    else if ((bad.length || !inspectionComplete) && result === '정상') result = '점검필요';
    const readings = source.readings || [];
    if (!Array.isArray(readings) || readings.length > 10) fail('전기 측정값은 최대 10개까지 기록할 수 있어요.');
    const values = readings.map(row => {
      if (!row || !Object.hasOwn(READING_UNITS, row.kind) || row.unit !== READING_UNITS[row.kind] || typeof row.value !== 'number') fail('측정 종류와 단위를 확인해 주세요.');
      const value = Number(row.value), measuredAt = row.at === undefined ? at : Number(row.at);
      if (!Number.isFinite(value) || value < 0 || value > 1000000000 || !Number.isSafeInteger(measuredAt) || measuredAt <= 0 || measuredAt > at + 300000) fail('측정값과 측정 시각을 확인해 주세요.');
      return { kind: row.kind, value, unit: row.unit, at: measuredAt, by: actor };
    });
    return { checks, checkReasons, readings: values, inspectionComplete, result };
  }
  function isComplete(record) { return record.inspectionComplete !== false; }
  function proof(id, record) {
    if (!['inspectionComplete', 'checkReasons', 'readings'].some(key => Object.hasOwn(record, key))) return null;
    return JSON.parse(JSON.stringify({ schemaVersion: 1, inspectionId: id, lightId: record.lightId, date: record.date, inspector: record.inspector, checks: record.checks, checkReasons: record.checkReasons, inspectionComplete: record.inspectionComplete, readings: record.readings, result: record.result }));
  }
  function measurementProof(id, record) {
    if (!Object.hasOwn(record, 'readings') || !Array.isArray(record.readings) || !record.readings.length) return null;
    return JSON.parse(JSON.stringify({ schemaVersion: 1, inspectionId: id, lightId: record.lightId, date: record.date, inspector: record.inspector, readings: record.readings }));
  }
  function lightPatch(current, record) {
    if (isComplete(record)) return data.latestPatch(current, { status: record.result, statusAt: record.date, lastInspected: record.date, lastResult: record.result, redoNote: null, updatedAt: record.date });
    const severity = { '정상': 0, '수리중': 1, '점검필요': 2, '고장': 3 };
    if (!['고장', '점검필요'].includes(record.result) || (severity[current.status] || 0) > severity[record.result] || record.date < Math.max(Number(current.statusAt || current.lastInspected) || 0, Number(current.updatedAt) || 0)) return {};
    return data.latestPatch(current, { status: record.result, statusAt: record.date, updatedAt: record.date });
  }
  return { VALUES, READING_UNITS, prepare, isComplete, proof, measurementProof, lightPatch };
});
