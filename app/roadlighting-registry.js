/* Native roadlighting point files are partial, provider-owned updates, never a replacement for the merged registry. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGRoadlightingRegistry = api;
})(globalThis, function () {
  'use strict';
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const dongNames = ['금남로1가','금남로2가','금남로3가','금남로4가','금남로5가','충장로1가','충장로2가','충장로3가','충장로4가','충장로5가','계림동','광산동','궁동','금동','남동','대의동','대인동','동명동','불로동','산수동','서석동','소태동','수기동','용산동','운림동','월남동','장동','지산동','학동','호남동','황금동'];
  const invalid = message => { throw new Error(message); };
  const scalar = value => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value);
  function isNative(value) {
    return Array.isArray(value) ? value.some(row => row && typeof row === 'object' && own(row, 'lamp_id')) : !!value && typeof value === 'object' && own(value, 'DATA');
  }
  function isRoadlighting(row) {
    if (!row || !scalar(row.lampId) || typeof row.lampId === 'number' && !Number.isSafeInteger(row.lampId)) return false;
    const id = String(row.lampId);
    return !!id && id.length <= 180 && !/[\/\\\u0000-\u001f\u007f]/.test(id) && row.id === 'p' + id;
  }
  function normalize(value) {
    if (value && !Array.isArray(value)) {
      if (value.truncated || value.hasMore || value.has_more || value.nextCursor || value.next_cursor || value.complete === false || value.metadata?.truncated || value.metadata?.hasMore || value.metadata?.has_more || value.metadata?.complete === false) invalid('일부만 포함된 운영 대장 파일은 적용할 수 없어요. 전체 자료를 다시 받아 주세요.');
    }
    const rows = Array.isArray(value) ? value : value && value.DATA;
    if (!Array.isArray(rows) || !rows.length || rows.length > 100000) invalid('운영 대장은 비어 있지 않은 DATA 배열 또는 시설 배열이어야 해요(최대 100,000개).');
    if (!Array.isArray(value)) for (const key of ['count','totalCount','total_count','TOTAL_CNT','TOTAL_COUNT']) {
      if (own(value, key) && (!Number.isSafeInteger(Number(value[key])) || Number(value[key]) !== rows.length)) invalid('운영 대장 건수와 실제 행 수가 달라요. 전체 자료인지 확인해 주세요.');
    }
    const seen = new Set();
    return rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('운영 대장 시설 행을 확인해 주세요.');
      if (!scalar(row.lamp_id) || typeof row.lamp_id === 'number' && !Number.isSafeInteger(row.lamp_id)) invalid('시설 ID는 문자열 또는 정확한 정수여야 해요.');
      const lampId = String(row.lamp_id);
      if (!lampId || lampId !== lampId.trim() || lampId.length > 180 || /[\/\\\u0000-\u001f\u007f]/.test(lampId) || seen.has(lampId)) invalid('시설 ID가 없거나 중복/잘못된 값이에요: ' + lampId.replace(/[\u0000-\u001f\u007f]/g, ''));
      seen.add(lampId);
      if (!scalar(row.label_no)) invalid('시설 표찰/이름은 문자 또는 숫자여야 해요: ' + lampId);
      const label = String(row.label_no).trim();
      if (!label || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label)) invalid('시설 표찰/이름을 확인해 주세요: ' + lampId);
      const coordinate = (raw, max, name) => {
        if (!scalar(raw) || String(raw).trim() === '' || typeof raw === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) || !Number.isFinite(Number(raw)) || Math.abs(Number(raw)) > max) invalid(name + ' 좌표가 올바르지 않아요: ' + lampId);
        return Math.round(Number(raw) * 1e7) / 1e7;
      };
      const out = { id: 'p' + lampId, lampId, label, code: label, lat: coordinate(row.latitude, 90, '위도'), lng: coordinate(row.longitude, 180, '경도') };
      for (const [source, target] of [['facility_class','kind'],['lampName','lampType'],['poleName','pole'],['jumName','sw'],['addr','addr'],['jibun','jibun'],['mgmt','mgmt'],['posApprox','posApprox']]) {
        if (!own(row, source)) continue;
        const value = row[source];
        if (value === null) out[target] = null;
        else if (target === 'posApprox') {
          if (![true, false, 0, 1].includes(value)) invalid('추정 좌표 표시값을 확인해 주세요: ' + lampId);
          out[target] = value === true || value === 1;
        } else {
          if (!scalar(value) || String(value).length > 200 || /[\u0000-\u001f\u007f]/.test(String(value))) invalid('시설 속성 ' + source + ' 값을 확인해 주세요: ' + lampId);
          out[target] = String(value).trim();
        }
      }
      const compact = label.replace(/\s+/g, ''), dong = dongNames.find(name => compact.startsWith(name));
      if (dong) {
        out.dong = dong;
        const rest = label.replace(new RegExp('^' + dong + '\\s*'), ''), numeric = compact.slice(dong.length).replace(/\(.*$/, '');
        out.code = rest ? dong + ' ' + rest : dong;
        if (/^\d+(-\d+)*$/.test(numeric)) out.num = numeric;
      }
      if (/철거/.test(compact)) out.removed = true;
      if (/표찰없음/.test(compact)) out.noPlate = true;
      return out;
    });
  }
  function scopedDiff(base, incoming, overrides, core) {
    if (!core || typeof core.registryDiff !== 'function') invalid('대장 비교 기능을 준비하지 못했어요. 앱을 다시 열어 주세요.');
    const all = new Map(base.map(row => [row.id, row]));
    for (const row of incoming) {
      if (!isRoadlighting(row)) invalid('운영 대장 시설 ID와 lampId 연결을 확인해 주세요.');
      const previous = all.get(row.id);
      if (previous && (!isRoadlighting(previous) || String(previous.lampId) !== String(row.lampId))) invalid('다른 출처 시설과 ID가 겹쳐요. 식별 정보를 확인해 주세요: ' + row.id);
      if (!previous && (typeof row.kind !== 'string' || !row.kind.trim())) invalid('새 시설의 종류를 확인해 주세요: ' + row.id);
    }
    const scoped = base.filter(isRoadlighting), diff = core.registryDiff(scoped, incoming, overrides);
    return { ...diff, scope: 'roadlighting-gjd', scopeLabel: 'gjd.roadlighting.kr 운영 대장', retainedOtherCount: base.length - scoped.length, allowRemoveMissing: false };
  }
  return { isNative, isRoadlighting, normalize, scopedDiff };
});
