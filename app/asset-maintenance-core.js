/* Physical asset relationships and immutable component service records. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGAssetMaintenanceCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const COLLECTIONS = Object.freeze({ cabinet: 'cabinets', circuit: 'circuits', link: 'assetLinks', incident: 'outageIncidents', replacement: 'assetReplacements' });
  const COMPONENTS = Object.freeze({ lamp: '램프', fixture: '등기구', driver: '안정기·드라이버', pole: '등주', cabinet: '분전함 부품', other: '기타 부품' });
  const META = ['schemaVersion', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'revision', 'operationId'];
  const MAX_TIME = 8640000000000000;
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = (message, code = 'invalid-argument') => { throw Object.assign(new Error(message), { code }); };
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  function id(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('자료 식별자를 확인해 주세요.');
    return value;
  }
  function text(value, max, label, required = false) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || required && !value.trim()) fail(label + '을 확인해 주세요.');
    return value.trim();
  }
  function actor(value) { return text(value, 128, '작성자', true); }
  function number(value, min, max, label, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) fail(label + ' 범위를 확인해 주세요.');
    return value;
  }
  function fields(input, names) {
    if (!plain(input) || Object.keys(input).some(key => !names.includes(key) && !META.includes(key))) fail('자료 형식을 확인해 주세요.');
  }
  function ids(values, max, label, required = false) {
    if (!Array.isArray(values) || values.length > max || required && !values.length || new Set(values).size !== values.length) fail(label + ' 목록을 확인해 주세요.');
    return values.map(id);
  }
  function parents(input) {
    const cabinetId = input.cabinetId === '' ? '' : id(input.cabinetId), circuitId = input.circuitId === '' ? '' : id(input.circuitId);
    if (!!cabinetId !== !!circuitId) fail('분전함과 회로를 함께 선택해 주세요.');
    return { cabinetId, circuitId };
  }
  function normalize(entity, input) {
    if (!Object.hasOwn(COLLECTIONS, entity)) fail('지원하지 않는 시설 관리 자료예요.');
    if (entity === 'cabinet') {
      fields(input, ['code', 'label', 'dong', 'lat', 'lng', 'note', 'disabled']);
      if (typeof input.disabled !== 'boolean' || (input.lat === null) !== (input.lng === null)) fail('분전함의 사용 상태와 좌표를 확인해 주세요.');
      return { code: text(input.code, 100, '분전함 번호', true), label: text(input.label, 100, '분전함 이름', true), dong: text(input.dong, 80, '행정동'), lat: input.lat === null ? null : number(input.lat, -90, 90, '위도'), lng: input.lng === null ? null : number(input.lng, -180, 180, '경도'), note: text(input.note, 1000, '메모'), disabled: input.disabled };
    }
    if (entity === 'circuit') {
      fields(input, ['cabinetId', 'code', 'label', 'note', 'disabled']); if (typeof input.disabled !== 'boolean') fail('회로의 사용 상태를 확인해 주세요.');
      return { cabinetId: id(input.cabinetId), code: text(input.code, 100, '회로 번호', true), label: text(input.label, 100, '회로 이름', true), note: text(input.note, 1000, '메모'), disabled: input.disabled };
    }
    if (entity === 'link') {
      fields(input, ['lightId', 'cabinetId', 'circuitId', 'confirmationNote']);
      return { lightId: id(input.lightId), ...parents(input), confirmationNote: text(input.confirmationNote, 1000, '연결 확인·해제 사유', true) };
    }
    if (entity === 'incident') {
      fields(input, ['title', 'cabinetId', 'circuitId', 'lightIds', 'reportIds', 'workIds', 'confirmedLightIds', 'status', 'note', 'resolutionNote']);
      const out = { title: text(input.title, 120, '장애 제목', true), ...parents(input), lightIds: ids(input.lightIds, 100, '관련 시설', true), reportIds: ids(input.reportIds, 20, '관련 신고'), workIds: ids(input.workIds, 20, '관련 작업'), confirmedLightIds: ids(input.confirmedLightIds, 100, '복구 확인 시설'), status: input.status, note: text(input.note, 1500, '장애 내용'), resolutionNote: text(input.resolutionNote, 1000, '복구 확인 내용') };
      if (!['open', 'resolved'].includes(out.status) || out.confirmedLightIds.some(value => !out.lightIds.includes(value))) fail('장애의 상태와 복구 확인 대상을 확인해 주세요.');
      if (out.status === 'resolved' && (!out.resolutionNote || out.lightIds.length !== out.confirmedLightIds.length)) fail('모든 시설의 복구 확인과 조치 내용을 기록해 주세요.');
      if (out.status === 'open' && out.resolutionNote) fail('복구 완료 내용은 전체 복구를 확인한 뒤 기록해 주세요.');
      return out;
    }
    fields(input, ['lightId', 'component', 'replacedAt', 'manufacturer', 'model', 'warrantyEnd', 'workId', 'note']);
    const replacedAt = number(input.replacedAt, 1, MAX_TIME, '교체 시각', true), warrantyEnd = number(input.warrantyEnd, 0, MAX_TIME, '보증 종료일', true);
    if (!Object.hasOwn(COMPONENTS, input.component) || warrantyEnd && warrantyEnd < replacedAt) fail('교체 부품과 보증 기간을 확인해 주세요.');
    const out = { lightId: id(input.lightId), component: input.component, replacedAt, manufacturer: text(input.manufacturer, 100, '제조사'), model: text(input.model, 100, '모델'), warrantyEnd, workId: input.workId === '' ? '' : id(input.workId), note: text(input.note, 1000, '교체 내용') };
    if (out.component === 'other' && !out.note) fail('기타 부품의 교체 내용을 기록해 주세요.');
    return out;
  }
  function validateRecord(entity, record) {
    const data = normalize(entity, record);
    if (record.schemaVersion !== 1) fail('시설 관리 자료 버전을 확인해 주세요.');
    number(record.revision, 1, Number.MAX_SAFE_INTEGER, '자료 버전', true); id(record.operationId); actor(record.createdBy); actor(record.updatedBy);
    number(record.createdAt, 1, MAX_TIME, '작성 시각', true); number(record.updatedAt, record.createdAt, MAX_TIME, '수정 시각', true);
    if (entity === 'replacement' && (record.revision !== 1 || data.replacedAt > record.createdAt || record.updatedAt !== record.createdAt || record.updatedBy !== record.createdBy)) fail('교체 이력은 최초 기록을 유지해야 해요.');
    return { ...data, ...Object.fromEntries(META.map(key => [key, record[key]])) };
  }
  return Object.freeze({ COLLECTIONS, COMPONENTS, META, MAX_TIME, normalize, validateRecord, id, actor, fail, clone });
});
