/* Review-only areas. Geometry never changes facility records or field observations. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGLightingAreaCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const EARTH = 6371000, RAD = Math.PI / 180, EPS = 1e-6, FRACTION_EPS = 1e-11;
  const REASONS = Object.freeze({ mountain: '산·숲', private: '사유지·단지 내부', non_walkway: '통행로가 아닌 곳', water: '하천·수면', other: '기타', public_path: '실제 보행로·검토 필요 구역' });
  const EFFECTS = Object.freeze({ exclude: '검토 제외', include: '예외 포함' });
  const MAX_VERTICES = 32, MAX_RADIUS = 1000, MAX_EXTENT = 5000;
  const internals = new WeakMap();
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = (message, code = 'invalid-argument') => { throw Object.assign(new Error(message), { code }); };
  function text(value, max, label, required = false) {
    if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(label + '을 확인해 주세요.');
    return value.trim();
  }
  function number(value, min, max, label) {
    if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) fail(label + '을 입력해 주세요.');
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) fail(label + ' 범위를 확인해 주세요.');
    return n === 0 ? 0 : n;
  }
  function id(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('구역 식별자를 확인해 주세요.');
    return value;
  }
  function point(value) {
    if (!plain(value)) fail('구역의 좌표를 확인해 주세요.');
    return { lat: number(value.lat, -85, 85, '위도'), lng: number(value.lng, -180, 180, '경도') };
  }
  function projector(anchor) {
    const scaleX = EARTH * RAD * Math.cos(anchor.lat * RAD), scaleY = EARTH * RAD;
    return p => ({ x: (p.lng - anchor.lng) * scaleX, y: (p.lat - anchor.lat) * scaleY });
  }
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const minus = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  function onSegment(p, a, b) {
    const d = minus(b, a), q = minus(p, a), length = Math.hypot(d.x, d.y);
    if (length <= EPS) return Math.hypot(q.x, q.y) <= EPS;
    return Math.abs(cross(d, q)) <= EPS * length && dot(q, d) >= -EPS * length && dot(q, d) <= length * length + EPS * length;
  }
  // Includes endpoint intersections and collinear overlap. This is also used to
  // reject self-touching polygons, whose inside would otherwise be ambiguous.
  function intersections(a, b, c, d) {
    const u = minus(b, a), v = minus(d, c), q = minus(c, a), denominator = cross(u, v);
    const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
    if (lu <= EPS) return onSegment(a, c, d) ? [0] : [];
    if (Math.abs(denominator) > 1e-12 * Math.max(1, lu * lv)) {
      const t = cross(q, v) / denominator, s = cross(q, u) / denominator;
      return t >= -FRACTION_EPS && t <= 1 + FRACTION_EPS && s >= -FRACTION_EPS && s <= 1 + FRACTION_EPS ? [Math.max(0, Math.min(1, t))] : [];
    }
    if (Math.abs(cross(q, u)) > EPS * lu) return [];
    const square = dot(u, u), t0 = dot(q, u) / square, t1 = dot(minus(d, a), u) / square;
    if (Math.max(t0, t1) < -FRACTION_EPS || Math.min(t0, t1) > 1 + FRACTION_EPS) return [];
    return [Math.max(0, Math.min(1, t0)), Math.max(0, Math.min(1, t1))];
  }
  function polygonContains(vertices, p) {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const a = vertices[j], b = vertices[i];
      if (onSegment(p, a, b)) return true;
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  function normalize(input) {
    if (!plain(input)) fail('검토 구역을 확인해 주세요.');
    if (!Object.hasOwn(EFFECTS, input.effect) || !Object.hasOwn(REASONS, input.reason) || !['circle', 'polygon'].includes(input.shape)) fail('구역의 적용 방식과 사유를 확인해 주세요.');
    if (input.effect === 'include' && !['public_path', 'other'].includes(input.reason)) fail('예외 포함 구역의 사유는 실제 보행로 또는 기타로 지정해 주세요.');
    if (typeof input.disabled !== 'boolean') fail('구역의 사용 상태를 확인해 주세요.');
    if (!Array.isArray(input.vertices)) fail('구역 경계 목록을 확인해 주세요.');
    const out = { label: text(input.label, 100, '구역 이름', true), effect: input.effect, reason: input.reason, note: text(input.note === undefined ? '' : input.note, 1000, '구역 메모'), shape: input.shape, lat: 0, lng: 0, radius: 0, vertices: [], disabled: input.disabled };
    if (input.shape === 'circle') {
      if (input.vertices.length) fail('원형 구역에는 다각형 경계를 함께 저장할 수 없어요.');
      Object.assign(out, point(input), { radius: number(input.radius, 5, MAX_RADIUS, '반경') });
      // A circle crossing the date line cannot be represented by this local map.
      const margin = out.radius / (EARTH * RAD * Math.cos(out.lat * RAD));
      if (out.lng - margin < -180 || out.lng + margin > 180) fail('날짜 변경선을 넘는 구역은 나누어 등록해 주세요.');
      return out;
    }
    if (input.vertices.length < 3 || input.vertices.length > MAX_VERTICES) fail('다각형 경계는 3–32개 지점으로 지정해 주세요.');
    const vertices = input.vertices.map(point);
    const longitudes = vertices.map(p => p.lng);
    if (Math.max(...longitudes) - Math.min(...longitudes) > 180) fail('날짜 변경선을 넘는 구역은 나누어 등록해 주세요.');
    out.lat = vertices.reduce((sum, p) => sum + p.lat, 0) / vertices.length;
    out.lng = vertices.reduce((sum, p) => sum + p.lng, 0) / vertices.length;
    out.vertices = vertices;
    const project = projector(out), xy = vertices.map(project);
    if (xy.some(p => Math.hypot(p.x, p.y) > MAX_EXTENT)) fail('한 다각형은 중심에서 5km 이내로 나누어 지정해 주세요.');
    for (let i = 0; i < xy.length; i++) for (let j = i + 1; j < xy.length; j++) {
      if (Math.hypot(xy[i].x - xy[j].x, xy[i].y - xy[j].y) < .01) fail('겹치는 경계 지점을 제거해 주세요. 마지막 지점에 첫 지점을 반복하지 않아요.');
    }
    for (let i = 0; i < xy.length; i++) {
      const j = (i + 1) % xy.length;
      const previous = xy[(i + xy.length - 1) % xy.length], next = xy[j];
      if (onSegment(next, previous, xy[i]) || onSegment(previous, xy[i], next)) fail('경계가 되돌아가거나 겹쳐요. 지점 순서를 확인해 주세요.');
      for (let k = i + 1; k < xy.length; k++) {
        const l = (k + 1) % xy.length;
        if (j === k || l === i) continue;
        if (intersections(xy[i], xy[j], xy[k], xy[l]).length) fail('서로 교차하는 경계는 저장할 수 없어요. 바깥 경계를 순서대로 지정해 주세요.');
      }
    }
    const area = Math.abs(xy.reduce((sum, p, i) => sum + cross(p, xy[(i + 1) % xy.length]), 0)) / 2;
    if (area < 1) fail('다각형 면적은 1㎡ 이상이어야 해요. 경계 지점을 확인해 주세요.');
    return out;
  }
  function freezeRecord(record) {
    for (const vertex of record.vertices) Object.freeze(vertex);
    Object.freeze(record.vertices);
    return Object.freeze(record);
  }
  function compile(records = []) {
    if (!Array.isArray(records)) fail('검토 구역 목록을 확인해 주세요.');
    const seen = new Set(), snapshot = [], entries = [];
    for (const input of records) {
      if (!plain(input)) fail('검토 구역 목록에 잘못된 기록이 있어요.');
      const recordId = id(input.id);
      if (seen.has(recordId)) fail('검토 구역 식별자가 중복돼요. 자료를 다시 읽어 주세요.');
      seen.add(recordId);
      const record = { id: recordId, ...normalize(input) };
      if (input.schemaVersion !== undefined && input.schemaVersion !== 1) fail('지원하지 않는 검토 구역 버전이에요.');
      for (const key of ['createdAt', 'updatedAt', 'revision']) if (input[key] !== undefined) {
        if (!Number.isSafeInteger(input[key]) || input[key] < 0) fail('검토 구역의 기록 버전을 확인해 주세요.');
        record[key] = input[key];
      }
      for (const key of ['createdBy', 'updatedBy']) if (input[key] !== undefined) record[key] = text(input[key], 128, '기록 계정', true);
      if (input.operationId !== undefined) record.operationId = id(input.operationId);
      if (input.schemaVersion !== undefined) record.schemaVersion = input.schemaVersion;
      freezeRecord(record); snapshot.push(record);
      if (record.disabled) continue;
      const project = projector(record), xy = record.vertices.map(project), r = record.radius;
      const bounds = record.shape === 'circle' ? { x0: -r, y0: -r, x1: r, y1: r } : { x0: Math.min(...xy.map(p => p.x)), y0: Math.min(...xy.map(p => p.y)), x1: Math.max(...xy.map(p => p.x)), y1: Math.max(...xy.map(p => p.y)) };
      entries.push({ record, project, xy, bounds });
    }
    const order = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    snapshot.sort(order); entries.sort((a, b) => order(a.record, b.record));
    const ctx = Object.freeze({ records: Object.freeze(snapshot), count: snapshot.length, activeCount: entries.length, excludeCount: entries.filter(e => e.record.effect === 'exclude').length, includeCount: entries.filter(e => e.record.effect === 'include').length });
    internals.set(ctx, entries);
    return ctx;
  }
  function entriesOf(ctx) {
    const entries = ctx && internals.get(ctx);
    if (!entries) fail('이 모듈에서 만든 검토 구역 문맥이 필요해요.');
    return entries;
  }
  function decide(entries, at) {
    const includeIds = [], excludeIds = [];
    for (const entry of entries) {
      const p = entry.project(at), b = entry.bounds;
      if (p.x < b.x0 - EPS || p.x > b.x1 + EPS || p.y < b.y0 - EPS || p.y > b.y1 + EPS) continue;
      const inside = entry.record.shape === 'circle' ? Math.hypot(p.x, p.y) <= entry.record.radius + EPS : polygonContains(entry.xy, p);
      if (inside) (entry.record.effect === 'include' ? includeIds : excludeIds).push(entry.record.id);
    }
    return { excluded: excludeIds.length > 0 && includeIds.length === 0, includeIds, excludeIds };
  }
  function decision(ctx, at) { return decide(entriesOf(ctx), point(at)); }
  function splitSegment(ctx, start, end) {
    const entries = entriesOf(ctx), a = point(start), b = point(end);
    if (Math.abs(b.lng - a.lng) > 180) fail('날짜 변경선을 넘는 구간은 나누어 검토해 주세요.');
    const cuts = [0, 1];
    for (const entry of entries) {
      const p = entry.project(a), q = entry.project(b), bounds = entry.bounds;
      if (Math.max(p.x, q.x) < bounds.x0 - EPS || Math.min(p.x, q.x) > bounds.x1 + EPS || Math.max(p.y, q.y) < bounds.y0 - EPS || Math.min(p.y, q.y) > bounds.y1 + EPS) continue;
      if (entry.record.shape === 'polygon') {
        for (let i = 0; i < entry.xy.length; i++) cuts.push(...intersections(p, q, entry.xy[i], entry.xy[(i + 1) % entry.xy.length]));
      } else {
        const d = minus(q, p), aa = dot(d, d);
        if (aa <= EPS * EPS) continue;
        const bb = 2 * dot(p, d), cc = dot(p, p) - entry.record.radius ** 2, disc = bb * bb - 4 * aa * cc;
        const offset = Math.abs(cross(p, d)) / Math.sqrt(aa);
        if (Math.abs(offset - entry.record.radius) <= EPS) {
          const t = -bb / (2 * aa);
          if (t > 0 && t < 1) cuts.push(t);
          continue;
        }
        if (disc < -1e-12 * Math.max(1, bb * bb, Math.abs(4 * aa * cc))) continue;
        const root = Math.sqrt(Math.max(0, disc));
        for (const t of [(-bb - root) / (2 * aa), (-bb + root) / (2 * aa)]) if (t > 0 && t < 1) cuts.push(t);
      }
    }
    cuts.sort((x, y) => x - y);
    const unique = [0], out = [];
    for (const t of cuts) if (t > FRACTION_EPS && t < 1 - FRACTION_EPS && t - unique[unique.length - 1] > FRACTION_EPS) unique.push(t);
    unique.push(1);
    const at = t => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    for (let i = 1; i < unique.length; i++) {
      const t0 = unique[i - 1], t1 = unique[i];
      if (t1 - t0 <= FRACTION_EPS) continue;
      const middle = at((t0 + t1) / 2);
      out.push({ start: at(t0), end: at(t1), point: middle, fraction: t1 - t0, ...decide(entries, middle) });
    }
    return out;
  }
  return Object.freeze({ normalize, compile, decision, splitSegment, reasons: REASONS, effects: EFFECTS, MAX_VERTICES, MAX_RADIUS, MAX_EXTENT, fail, id });
});
