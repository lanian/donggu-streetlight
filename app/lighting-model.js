/* A relative screening model, never an illuminance (lux) or standards-compliance model.
   External sources and local field observations stay separate from the managed-light registry.
   This module performs no I/O and never changes its input records. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DGLightingModel = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000, EARTH = 6371000, RAD = Math.PI / 180;
  const STRENGTH = Object.freeze({ low: .6, medium: 1, high: 1.4 });
  const ENUMS = Object.freeze({
    kind: ['source', 'observation'], category: ['other_public', 'private', 'shop', 'building', 'unknown', 'field'],
    strength: Object.keys(STRENGTH), status: ['on', 'off', 'unknown'],
    level: ['bright', 'adequate', 'dark', 'unknown'], schedule: ['always', 'hours', 'unknown']
  });
  const contexts = new WeakMap();
  const fail = message => { const e = new Error(message); e.code = 'invalid-argument'; throw e; };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const number = (value, min, max, label, integer = false) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) fail(label + ' 값을 확인해 주세요.');
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) fail(label + ' 범위를 확인해 주세요.');
    return n;
  };
  const text = (value, max, label, required = false) => {
    if (value == null) value = '';
    if (typeof value !== 'string') fail(label + ' 형식을 확인해 주세요.');
    const out = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (out.length > max || (required && !out)) fail(label + (required ? '을(를) 입력하고 길이를 확인해 주세요.' : ' 길이를 확인해 주세요.'));
    return out;
  };
  const member = (value, key, fallback) => {
    const out = value === undefined ? fallback : value;
    if (!ENUMS[key].includes(out)) fail(key + ' 항목을 확인해 주세요.');
    return out;
  };
  const bool = (value, label) => {
    if (value === undefined) return false;
    if (typeof value !== 'boolean') fail(label + ' 확인 여부를 선택해 주세요.');
    return value;
  };
  const nowValue = options => number(options && options.now !== undefined ? options.now : Date.now(), 0, 8640000000000000, '기준 시각');

  // Only domain fields are returned. The command layer supplies IDs, revisions and authors.
  function normalizeRecord(input, options = {}) {
    if (!object(input)) fail('조명 근거 기록을 확인해 주세요.');
    const now = nowValue(options), kind = member(input.kind, 'kind');
    const schedule = member(input.schedule, 'schedule', 'unknown');
    const startMinute = number(input.startMinute === undefined ? 1080 : input.startMinute, 0, 1439, '시작 시각', true);
    const endMinute = number(input.endMinute === undefined ? 360 : input.endMinute, 0, 1439, '종료 시각', true);
    if (schedule === 'hours' && startMinute === endMinute) fail('시간 범위의 시작과 종료를 다르게 선택해 주세요.');
    const observedAt = number(input.observedAt, 1, 8640000000000000, '확인 시각', true);
    if (observedAt > now + 300000) fail('확인 시각은 현재보다 5분 이상 미래일 수 없어요.');
    const linkedLightId = text(input.linkedLightId, 180, '연결 시설 ID');
    if (linkedLightId.includes('/')) fail('연결 시설 ID 형식을 확인해 주세요.');
    const emptyLux = input.lux == null || (typeof input.lux === 'string' && !input.lux.trim());
    const record = {
      kind, label: text(input.label, 100, '이름', true),
      category: member(input.category, 'category', kind === 'observation' ? 'field' : 'unknown'),
      operator: text(input.operator, 100, '관리 주체'),
      lat: number(input.lat, -90, 90, '위도'), lng: number(input.lng, -180, 180, '경도'),
      radius: number(input.radius, 5, kind === 'source' ? 80 : 30, '영향 범위'),
      strength: member(input.strength, 'strength', 'medium'), status: member(input.status, 'status', 'unknown'),
      level: member(input.level, 'level', 'unknown'), schedule, startMinute, endMinute, observedAt,
      validDays: number(input.validDays === undefined ? (kind === 'source' ? 90 : 30) : input.validDays, 1, 365, '유효 기간', true),
      nightConfirmed: bool(input.nightConfirmed, '야간 현장'),
      lux: emptyLux ? null : number(input.lux, 0, 200000, '실측 조도'),
      instrument: text(input.instrument, 100, '측정 장비', !emptyLux), note: text(input.note, 1000, '메모'),
      linkedLightId, distinct: bool(input.distinct, '별개 광원'), removed: bool(input.removed, '보관')
    };
    const provenanceKeys = ['sourceAgency', 'sourceRecordId', 'sourceDataset', 'sourceUpdatedAt', 'importedAt', 'importBatchId'];
    if (provenanceKeys.some(key => Object.prototype.hasOwnProperty.call(input, key))) {
      if (kind !== 'source' || !provenanceKeys.every(key => Object.prototype.hasOwnProperty.call(input, key))) fail('외부 자료의 출처 항목을 모두 확인해 주세요.');
      Object.assign(record, {
        sourceAgency: text(input.sourceAgency, 100, '원본 관리기관', true), sourceRecordId: text(input.sourceRecordId, 180, '기관 시설 ID', true),
        sourceDataset: text(input.sourceDataset, 300, '자료 출처', true), sourceUpdatedAt: number(input.sourceUpdatedAt, 0, now + 300000, '원본 갱신 시각', true),
        importedAt: number(input.importedAt, 1, now + 300000, '자료 반입 시각', true), importBatchId: text(input.importBatchId, 180, '반입 작업 ID', true)
      });
      if (!/^[A-Za-z0-9_-]{1,180}$/.test(record.importBatchId)) fail('반입 작업 ID 형식을 확인해 주세요.');
    }
    const originKeys = ['originKind', 'originId', 'originPointId', 'positionAccuracy'];
    if (originKeys.some(key => Object.prototype.hasOwnProperty.call(input, key))) {
      if (kind !== 'observation' || !originKeys.every(key => Object.prototype.hasOwnProperty.call(input, key)) || !['patrol', 'task'].includes(input.originKind)) fail('현장 관찰의 원본 연결을 확인해 주세요.');
      Object.assign(record, { originKind: input.originKind, originId: text(input.originId, 180, '원본 업무 ID', true), originPointId: text(input.originPointId, 180, '원본 지점 ID'), positionAccuracy: number(input.positionAccuracy, 0, 10000, '위치 정확도') });
    }
    return record;
  }

  function minuteOfKst(at) {
    const value = number(at, -8640000000000000, 8640000000000000, '시각');
    return ((Math.floor(value / 60000) + 540) % 1440 + 1440) % 1440;
  }
  function optionsOf(options = {}) {
    return {
      now: nowValue(options),
      minute: number(options.minute === undefined ? 1260 : options.minute, 0, 1439, '검토 시각', true),
      weak: number(options.weak === undefined ? .3 : options.weak, Number.MIN_VALUE, Number.MAX_VALUE, '모델 기준')
    };
  }
  function stateOf(record, options) {
    const expiresAt = record.observedAt + record.validDays * DAY;
    const future = record.observedAt > options.now, stale = options.now >= expiresAt;
    const inSchedule = record.schedule === 'always' || (record.schedule === 'hours' &&
      (record.startMinute < record.endMinute
        ? options.minute >= record.startMinute && options.minute < record.endMinute
        : options.minute >= record.startMinute || options.minute < record.endMinute));
    let reason = '';
    if (record.removed) reason = 'removed';
    else if (future) reason = 'future';
    else if (stale) reason = 'stale';
    else if (!record.nightConfirmed) reason = 'not_night_confirmed';
    else if (record.schedule === 'unknown') reason = 'unknown_schedule';
    else if (!inSchedule) reason = 'outside_schedule';
    else if (record.kind === 'source' && record.status !== 'on') reason = record.status === 'off' ? 'off' : 'unknown_status';
    return { active: !reason, reason, fresh: !future && !stale, future, stale, inSchedule, expiresAt, ageDays: Math.max(0, options.now - record.observedAt) / DAY };
  }
  function recordState(record, options = {}) {
    const configured = optionsOf(options);
    try { return stateOf(normalizeRecord(record, configured), configured); }
    catch (error) { return { active: false, reason: 'invalid_record', fresh: false, future: false, stale: false, inSchedule: false, expiresAt: null, ageDays: null, message: error.message }; }
  }

  const validPoint = p => object(p) && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  // A 3-D grid on the earth's surface handles high latitudes and the date line without
  // an unbounded longitude scan. Chord queries are followed by exact great-circle distance.
  const position = p => {
    const lat = p.lat * RAD, lng = p.lng * RAD, c = Math.cos(lat);
    return [EARTH * c * Math.cos(lng), EARTH * c * Math.sin(lng), EARTH * Math.sin(lat)];
  };
  const distance = (a, b) => 2 * EARTH * Math.asin(Math.min(1, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / (2 * EARTH)));
  function grid(cell = 80) {
    const buckets = new Map();
    return {
      add(entry) {
        const key = entry.pos.map(n => Math.floor(n / cell)).join(',');
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(entry);
      },
      near(pos, radius) {
        const out = [], lo = pos.map(n => Math.floor((n - radius) / cell)), hi = pos.map(n => Math.floor((n + radius) / cell));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
          const bucket = buckets.get(x + ',' + y + ',' + z);
          if (bucket) for (const entry of bucket) {
            const d = distance(pos, entry.pos);
            if (d <= radius + 1e-7) out.push({ entry, d });
          }
        }
        return out;
      }
    };
  }
  const finiteMeta = n => Number.isFinite(n) ? n : 0;
  const stringId = r => typeof r.id === 'string' ? r.id : '';
  const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const fingerprint = r => JSON.stringify(Object.keys(r).sort().map(key => [key, r[key]]));
  const newestRevision = (a, b) => finiteMeta(b.revision) - finiteMeta(a.revision) || finiteMeta(b.updatedAt) - finiteMeta(a.updatedAt) || finiteMeta(b.observedAt) - finiteMeta(a.observedAt) || compareText(fingerprint(a), fingerprint(b));
  const newestObservation = (a, b) => b.record.observedAt - a.record.observedAt || finiteMeta(b.record.updatedAt) - finiteMeta(a.record.updatedAt) || compareText(a.record.id, b.record.id) || compareText(fingerprint(a.record), fingerprint(b.record));
  const identityText = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  function withMetadata(input, normalized) {
    const record = { id: stringId(input), ...normalized };
    for (const key of ['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'revision', 'operationId']) {
      if (typeof input[key] === 'string' || Number.isFinite(input[key])) record[key] = input[key];
    }
    return Object.freeze(record);
  }

  function createContext(records = [], managedLights = [], options = {}) {
    if (!Array.isArray(records) || !Array.isArray(managedLights)) fail('조명 기록과 시설 대장은 배열이어야 해요.');
    const configured = optionsOf(options), managed = grid(), managedIds = new Set();
    for (const light of managedLights) {
      if (!object(light)) continue;
      if (typeof light.id === 'string' && light.id) managedIds.add(light.id);
      if (validPoint(light) && !light.removed) managed.add({ pos: position(light) });
    }
    // A list may contain successive revisions of one document. A tombstone must win
    // over an old revision before removed records are omitted from the spatial index.
    const ids = new Map(), unique = [], invalidRecords = [];
    for (const record of records) {
      if (!object(record)) { invalidRecords.push({ id: '', label: '', reason: 'invalid_record' }); continue; }
      const id = stringId(record);
      if (!id) unique.push(record);
      else if (!ids.has(id) || newestRevision(record, ids.get(id)) < 0) ids.set(id, record);
    }
    unique.push(...ids.values());
    const entries = [];
    for (const input of unique) {
      try {
        const record = withMetadata(input, normalizeRecord(input, configured));
        if (!record.removed) entries.push({ record, pos: position(record), state: stateOf(record, configured), excluded: '' });
      } catch (error) {
        const hint = { id: stringId(input), label: typeof input.label === 'string' ? input.label.slice(0, 100) : '', reason: 'invalid_record', message: error.message };
        invalidRecords.push(hint);
        // Invalid records cannot contribute. When their location and radius are usable,
        // keep a local hint instead of silently losing the evidence of a data problem.
        if (validPoint(input) && Number.isFinite(input.radius) && input.radius >= 5 && input.radius <= 80 && input.removed !== true) {
          entries.push({ record: Object.freeze({ id: hint.id, label: hint.label, radius: input.radius }), pos: position(input), state: { stale: false }, excluded: 'invalid_record' });
        }
      }
    }
    const sources = entries.filter(e => e.record.kind === 'source').sort(newestObservation);
    // Deduplicate connected groups of same-name/same-operator sources within 2 m.
    // Even a newer off/unknown/stale record suppresses an older 'on' assertion.
    const sourceGrid = grid(), parents = sources.map((_, i) => i);
    const find = index => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
    for (let index = 0; index < sources.length; index++) {
      const entry = sources[index]; entry.index = index;
      entry.identity = identityText(entry.record.label) + '\u0000' + identityText(entry.record.operator);
      for (const { entry: other } of sourceGrid.near(entry.pos, 2)) if (entry.identity === other.identity) {
        const a = find(index), b = find(other.index);
        parents[Math.max(a, b)] = Math.min(a, b);
      }
      sourceGrid.add(entry);
    }
    for (let index = 0; index < sources.length; index++) {
      const entry = sources[index], record = entry.record;
      if (find(index) !== index) entry.excluded = 'duplicate_source';
      else if (record.linkedLightId) entry.excluded = managedIds.has(record.linkedLightId) ? 'linked_registry' : 'unresolved_link';
      else if (!record.distinct && managed.near(entry.pos, 5).length) entry.excluded = 'possible_registry_duplicate';
    }
    // Fixed insertion order gives reproducible sums and output for shuffled input arrays.
    entries.sort((a, b) => compareText(a.record.id, b.record.id) || compareText(fingerprint(a.record), fingerprint(b.record)));
    const spatial = grid(), maxRadius = entries.reduce((max, e) => Math.max(max, e.record.radius), 0);
    for (const entry of entries) spatial.add(entry);
    const context = Object.freeze({
      ...configured, unit: 'relative_index',
      records: Object.freeze(entries.filter(e => e.record.kind).map(e => e.record)),
      sourceCount: sources.length, activeSourceCount: sources.filter(e => !e.excluded && e.state.active).length,
      observationCount: entries.filter(e => e.record.kind === 'observation').length,
      invalidRecords: Object.freeze(invalidRecords.map(Object.freeze)), invalidCount: invalidRecords.length,
      duplicateCount: sources.filter(e => e.excluded === 'duplicate_source').length
    });
    contexts.set(context, { spatial, maxRadius });
    return context;
  }

  function evaluate(context, point, baseIndex, options = {}) {
    const internal = contexts.get(context);
    if (!internal) fail('이 모델에서 생성한 검토 문맥이 필요해요.');
    if (!validPoint(point)) fail('검토 지점의 좌표를 확인해 주세요.');
    if (!Number.isFinite(baseIndex) || baseIndex < 0) fail('기존 상대 모델 지수를 확인해 주세요.');
    if (options.registryNearby !== undefined && typeof options.registryNearby !== 'boolean') fail('주변 대장 여부를 확인해 주세요.');
    const sources = [], hints = [], observations = [];
    let external = 0, staleCount = 0;
    for (const { entry, d } of internal.spatial.near(position(point), internal.maxRadius)) {
      const record = entry.record, state = entry.state;
      if (d > record.radius + 1e-7) continue;
      if (state.stale) staleCount++;
      const reason = entry.excluded || state.reason;
      if (reason) { hints.push({ id: record.id, label: record.label, reason }); continue; }
      if (record.kind === 'observation') { observations.push(record); continue; }
      const contribution = STRENGTH[record.strength] / (1 + (d / (.6 * record.radius)) ** 2);
      external += contribution;
      sources.push({ id: record.id, label: record.label, operator: record.operator, category: record.category, contribution });
    }
    const dark = observations.some(o => o.level === 'dark'), bright = observations.some(o => o.level === 'bright'), adequate = observations.some(o => o.level === 'adequate');
    const fieldLevel = dark && (bright || adequate) ? 'conflict' : dark ? 'dark' : bright ? 'bright' : adequate ? 'adequate' : null;
    const adjusted = baseIndex + external;
    const classification = fieldLevel === 'conflict' ? 'conflict' : fieldLevel === 'dark' ? 'observed_dark' : fieldLevel ? 'observed_bright'
      : baseIndex < context.weak && adjusted >= context.weak && external > 0 ? 'external_supported'
        : adjusted >= context.weak ? 'model_lit' : options.registryNearby === false ? 'data_gap' : 'model_weak';
    sources.sort((a, b) => b.contribution - a.contribution || compareText(a.id, b.id) || compareText(a.label, b.label));
    hints.sort((a, b) => compareText(a.reason, b.reason) || compareText(a.id, b.id) || compareText(a.label, b.label));
    observations.sort((a, b) => b.observedAt - a.observedAt || compareText(a.id, b.id));
    return { base: baseIndex, external, adjusted, sources, hints, observations, fieldLevel, classification, staleCount, unit: 'relative_index' };
  }

  // Split one straight road fragment at every nearby evidence-circle boundary. Callers
  // must first split at the original road's vertices: an endpoint chord cannot describe a bend.
  // Fractions are arc-length fractions of this fragment, not lengths inferred from a midpoint.
  function splitSegment(context, start, end) {
    const internal = contexts.get(context);
    if (!internal) fail('이 모델에서 생성한 검토 문맥이 필요해요.');
    if (!validPoint(start) || !validPoint(end)) fail('도로 조각의 좌표를 확인해 주세요.');
    const a = position(start), b = position(end), dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const u = a.map(n => n / EARTH), chord = b.map((n, i) => n - a[i]), radial = dot(chord, u);
    const tangent = chord.map((n, i) => n - radial * u[i]), tangentLength = Math.hypot(...tangent);
    const theta = Math.atan2(tangentLength, EARTH + radial), length = theta * EARTH;
    // Review callers provide fragments of at most 8 m. Bound malformed inputs so a
    // spatial bucket query cannot turn into a world-wide scan.
    if (length > 1000) fail('도로 조각을 1,000m 이하로 나눈 뒤 검토해 주세요.');
    if (length < 1e-7) return [{ start: { ...start }, end: { ...end }, point: { ...start }, fraction: 1 }];
    const v = tangent.map(n => n / tangentLength);
    const at = fraction => {
      const angle = theta * fraction, along = EARTH * Math.sin(angle), radial = -2 * EARTH * Math.sin(angle / 2) ** 2;
      return a.map((n, i) => n + radial * u[i] + along * v[i]);
    };
    const toPoint = fraction => {
      if (fraction === 0) return { lat: start.lat, lng: start.lng };
      if (fraction === 1) return { lat: end.lat, lng: end.lng };
      const p = at(fraction);
      return { lat: Math.atan2(p[2], Math.hypot(p[0], p[1])) / RAD, lng: Math.atan2(p[1], p[0]) / RAD };
    };
    const cuts = [0, 1];
    for (const { entry } of internal.spatial.near(at(.5), internal.maxRadius + length / 2)) {
      const delta = entry.pos.map((n, i) => n - a[i]), x = dot(delta, u), y = dot(delta, v);
      const perpendicular2 = Math.max(0, dot(delta, delta) - x * x - y * y);
      const radius2 = (2 * EARTH * Math.sin(entry.record.radius / (2 * EARTH))) ** 2;
      // Work in metres relative to the start to avoid subtracting nearly equal
      // cosines for a 5 m circle on a 6,371 km sphere.
      const outside = fraction => {
        const angle = theta * fraction;
        return (-2 * EARTH * Math.sin(angle / 2) ** 2 - x) ** 2 + (EARTH * Math.sin(angle) - y) ** 2 + perpendicular2 - radius2;
      };
      const closest = Math.max(0, Math.min(1, Math.atan2(y, EARTH + x) / theta));
      const minimum = outside(closest), tolerance = Math.max(1e-9, radius2 * 1e-12);
      if (minimum > tolerance) continue;
      if (minimum >= -tolerance) { cuts.push(closest); continue; } // A tangent has no positive coverage length.
      const rootBetween = (lo, hi) => {
        const loOutside = outside(lo) > 0;
        for (let i = 0; i < 40; i++) {
          const middle = (lo + hi) / 2;
          if ((outside(middle) > 0) === loOutside) lo = middle; else hi = middle;
        }
        return (lo + hi) / 2;
      };
      if (outside(0) > 0) cuts.push(rootBetween(0, closest));
      if (outside(1) > 0) cuts.push(rootBetween(closest, 1));
    }
    const interior = cuts.filter(value => value > 1e-10 && value < 1 - 1e-10).sort((a, b) => a - b);
    const unique = [0, ...interior.filter((value, index) => !index || value - interior[index - 1] > 1e-10), 1];
    return unique.slice(1).map((end, index) => {
      const start = unique[index];
      return { start: toPoint(start), end: toPoint(end), point: toPoint((start + end) / 2), fraction: end - start };
    });
  }
  return Object.freeze({ normalizeRecord, normalize: normalizeRecord, createContext, evaluate, splitSegment, recordState, minuteOfKst, STRENGTH });
});
