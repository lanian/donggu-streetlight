(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGOperationsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STATES = { draft: '배정 대기', assigned: '배정됨', in_progress: '작업 중', completed: '검수 대기', verified: '완료', cancelled: '취소' };
  const PRIORITIES = ['긴급', '높음', '보통', '낮음'];
  const TYPES = ['수리', '재점검', '신설검토', '철거', '기타'];
  const FIELDS = ['lampId', 'label', 'code', 'kind', 'dong', 'num', 'road', 'main', 'sub', 'lat', 'lng', 'lampType', 'pole', 'sw', 'removed', 'noPlate', 'dongGuess'];
  const text = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
  const list = (values, max) => [...new Set((Array.isArray(values) ? values : []).filter(x => typeof x === 'string' && x && x.length <= 180))].slice(0, max);
  const clone = value => JSON.parse(JSON.stringify(value));
  function fail(message, code) { const error = new Error(message); error.code = code || 'invalid-argument'; throw error; }
  function finite(value, min, max, label) { const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) fail(label + ' 값이 올바르지 않아요.'); return n; }
  function parts(input) {
    if (!Array.isArray(input) || input.length > 30) fail('사용 자재는 최대 30종까지 기록할 수 있어요.');
    if (new Set(input.filter(p => p && p.inventoryId).map(p => p.inventoryId)).size > 10) fail('한 작업에서 재고에 연결할 수 있는 자재는 최대 10종이에요. 나머지는 별도 작업으로 등록해 주세요.');
    return input.filter(p => p && text(p.name, 100)).map(p => ({ name: text(p.name, 100), qty: finite(p.qty, 0.001, 1000000, '수량'), unitCost: finite(p.unitCost, 0, 1000000000, '단가'), ...(p.inventoryId ? { inventoryId: text(p.inventoryId, 180) } : {}) }));
  }
  function costTotal(values) { const total = Math.round(values.reduce((sum, p) => sum + p.qty * p.unitCost, 0)); if (!Number.isSafeInteger(total)) fail('자재 비용 합계가 허용 범위를 넘었어요.'); return total; }
  function measurements(input) {
    if (!Array.isArray(input) || input.length > 20) fail('실측 조도는 최대 20개까지 기록할 수 있어요.');
    return input.map(m => ({ lux: finite(m.lux, 0, 200000, '조도(lux)'), at: finite(m.at, 1, Number.MAX_SAFE_INTEGER, '측정 시각'), by: text(m.by, 180), note: text(m.note, 300) }));
  }
  function createOrder(input, light, actor, now) {
    if (!actor || !light || !light.id) fail('시설과 작성자를 확인해 주세요.');
    const title = text(input.title, 120); if (!title) fail('작업 제목을 입력해 주세요.');
    const assignedTo = text(input.assignedTo, 180), values = parts(input.parts || []);
    const dueAt = Number(input.dueAt || 0); if (!Number.isFinite(dueAt) || dueAt < 0) fail('완료 기한을 확인해 주세요.');
    return {
      schemaVersion: 1, lightId: light.id, code: text(light.code, 120), dong: text(light.dong, 80), title,
      description: text(input.description, 2000), type: TYPES.includes(input.type) ? input.type : '수리',
      priority: PRIORITIES.includes(input.priority) ? input.priority : '보통', status: assignedTo ? 'assigned' : 'draft',
      assignedTo, dueAt, createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor, revision: 1,
      reportIds: list(input.reportIds, 20), inspectionIds: list(input.inspectionIds, 20),
      beforePhotos: list(input.beforePhotos, 6), afterPhotos: [], completionNote: '', verificationNote: '',
      parts: values, costTotal: costTotal(values), accountedCost: 0, measurements: measurements(input.measurements || []), stockApplied: {}
    };
  }
  function actions(order, actor, admin) {
    if (!order || (!admin && order.assignedTo !== actor)) return [];
    const graph = { draft: ['assigned', 'cancelled'], assigned: ['in_progress', 'cancelled'], in_progress: ['completed', 'assigned', 'cancelled'], completed: ['verified', 'in_progress'], verified: ['assigned'], cancelled: ['draft'] };
    return (graph[order.status] || []).filter(s => admin || (order.status === 'assigned' && s === 'in_progress') || (order.status === 'in_progress' && s === 'completed'));
  }
  function transition(order, target, input, actor, admin, now) {
    if (!order || !actions(order, actor, admin).includes(target)) fail('현재 상태 또는 담당자 권한으로 처리할 수 없어요.', 'permission-denied');
    if (Number(input.expectedRevision) !== Number(order.revision)) fail('다른 직원이 작업을 변경했어요. 최신 내용을 확인해 주세요.', 'conflict');
    const next = clone(order); delete next.id;
    next.status = target; next.revision = order.revision + 1; next.updatedAt = now; next.updatedBy = actor;
    if (admin && input.assignedTo !== undefined) next.assignedTo = text(input.assignedTo, 180);
    if (admin && input.dueAt !== undefined) next.dueAt = finite(input.dueAt, 0, Number.MAX_SAFE_INTEGER, '완료 기한');
    if (target === 'assigned' && !next.assignedTo) fail('담당자를 선택해 주세요.');
    if (target === 'completed') {
      next.afterPhotos = list(input.afterPhotos || next.afterPhotos, 6);
      if (!next.afterPhotos.length) fail('조치 후 사진을 한 장 이상 첨부해 주세요.');
      next.completionNote = text(input.completionNote, 2000);
      if (!next.completionNote) fail('조치 내용을 기록해 주세요.');
      next.parts = parts(input.parts || next.parts || []); next.costTotal = costTotal(next.parts);
      next.measurements = measurements(input.measurements || next.measurements || []);
      next.completedAt = now; next.completedBy = actor;
    }
    if (target === 'verified') { next.verificationNote = text(input.verificationNote, 2000); next.verifiedAt = now; next.verifiedBy = actor; }
    if (target === 'in_progress' && order.status === 'completed') {
      next.verificationNote = text(input.verificationNote, 2000);
      if (!next.verificationNote) fail('보완 요청 사유를 기록해 주세요.');
    }
    if (order.status === 'verified' && target === 'assigned') {
      next.verificationNote = ''; next.afterPhotos = []; next.completionNote = '';
      delete next.verifiedAt; delete next.verifiedBy; delete next.completedAt; delete next.completedBy;
    }
    return next;
  }
  function inspectionState(light, days, now) {
    if (light.removed) return { key: 'removed', label: '철거', priority: 99 };
    if (light.redoNote && light.status === '점검필요') return { key: 'redo', label: '재점검 요청', priority: 0 };
    if (!Number.isFinite(light.lastInspected) || light.lastInspected <= 0) return { key: 'never', label: '점검 기록 없음', priority: 2 };
    const elapsed = Math.floor(Math.max(0, now - light.lastInspected) / 86400000);
    return elapsed > days ? { key: 'overdue', label: '기한 ' + (elapsed - days) + '일 초과', priority: 1, overdueDays: elapsed - days } : { key: 'current', label: '기한 내 점검', priority: 3, remainingDays: days - elapsed };
  }
  function distance(a, b) {
    const rad = Math.PI / 180, dlat = (b.lat - a.lat) * rad, dlng = (b.lng - a.lng) * rad;
    const x = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
  }
  function planVisits(lights, origin) {
    const left = lights.filter(l => !l.removed && Number.isFinite(l.lat) && Number.isFinite(l.lng)).map(l => ({ id: l.id, code: l.code, dong: l.dong, lat: l.lat, lng: l.lng }));
    if (left.length > 200) fail('한 방문 계획에는 최대 200개 시설을 선택해 주세요.');
    const result = []; let current = origin || left[0], total = 0;
    while (left.length) {
      let index = 0, best = Infinity;
      left.forEach((p, i) => { const d = distance(current, p); if (d < best) { best = d; index = i; } });
      const next = left.splice(index, 1)[0]; total += best; result.push({ ...next, distanceFromPrevious: Math.round(best), visited: false }); current = next;
    }
    return { stops: result, distance: Math.round(total), method: 'straight-line-nearest', createdAt: Date.now() };
  }
  function normalizeRegistry(value) {
    let rows;
    if (Array.isArray(value)) rows = value;
    else if (value && Array.isArray(value.cols) && Array.isArray(value.rows)) {
      if (value.count != null && value.count !== value.rows.length) fail('대장 건수와 실제 행 수가 달라요.');
      rows = value.rows.map(row => { if (!Array.isArray(row) || row.length !== value.cols.length) fail('대장 열 수가 맞지 않아요.'); return Object.fromEntries(value.cols.map((k, i) => [k, row[i]])); });
    } else fail('cols/rows 형식의 대장 JSON 또는 시설 배열을 선택해 주세요.');
    if (!rows.length || rows.length > 100000) fail('대장은 1~100,000개 시설을 포함해야 해요.');
    const ids = new Set();
    return rows.map(row => {
      const id = text(row.id, 180);
      if (!id || id.includes('/') || ids.has(id)) fail('시설 ID가 없거나 중복돼요: ' + id);
      ids.add(id);
      if (row.lat === '' || row.lat == null || row.lng === '' || row.lng == null) fail('시설 좌표가 비어 있어요: ' + id);
      const out = { id, lat: finite(row.lat, -90, 90, '위도'), lng: finite(row.lng, -180, 180, '경도') };
      for (const field of FIELDS) if (field !== 'lat' && field !== 'lng' && row[field] != null) out[field] = ['removed', 'noPlate', 'dongGuess'].includes(field) ? !!row[field] : text(row[field], 200);
      if (!out.code) fail('시설 표찰/이름이 비어 있어요: ' + id);
      return out;
    });
  }
  function registryDiff(base, incoming, overrides) {
    const old = new Map(base.map(x => [x.id, { ...x, ...(overrides && overrides[x.id] && overrides[x.id].registryValues || {}) }])), seen = new Set(), added = [], changed = [], missing = [];
    for (const row of incoming) {
      seen.add(row.id); const previous = old.get(row.id);
      if (!previous) { added.push(row); continue; }
      const changes = {}, conflicts = [];
      for (const field of FIELDS) {
        const scalar = value => value == null ? null : ['removed', 'noPlate', 'dongGuess'].includes(field) ? !!value : value;
        const a = scalar(previous[field]), b = scalar(row[field]);
        if (a !== b) {
          changes[field] = b;
          if (overrides && overrides[row.id] && Object.prototype.hasOwnProperty.call(overrides[row.id], field) && scalar(overrides[row.id][field]) !== a && scalar(overrides[row.id][field]) !== b) conflicts.push(field);
        }
      }
      if (Object.keys(changes).length) changed.push({ id: row.id, code: row.code, before: previous, changes, conflicts, registryValues: clone(row), overrideBefore: clone(overrides && overrides[row.id] || {}) });
    }
    for (const row of base) if (!seen.has(row.id)) missing.push({ ...row, overrideBefore: clone(overrides && overrides[row.id] || {}) });
    return { added, changed, missing, unchanged: incoming.length - added.length - changed.length, incomingCount: incoming.length };
  }
  function analytics(inspections, orders, reports, lights, from, to, events) {
    const inRange = t => typeof t === 'number' && t >= from && t <= to;
    const visits = inspections.filter(i => inRange(i.date)), opened = orders.filter(w => inRange(w.createdAt));
    const verified = Array.isArray(events) ? events.filter(e => e.toStatus === 'verified' && inRange(e.at)).map(e => ({ verifiedAt: e.at, createdAt: e.createdAt, cost: Number(e.costDelta == null ? e.costTotal : e.costDelta) || 0 })) : orders.filter(w => w.status === 'verified' && inRange(w.verifiedAt)).map(w => ({ verifiedAt: w.verifiedAt, createdAt: w.createdAt, cost: Number(w.costTotal) || 0 }));
    const unresolved = orders.filter(w => !['verified', 'cancelled'].includes(w.status));
    const faults = new Map(), circuits = new Map();
    const byId = new Map(lights.map(l => [l.id, l]));
    for (const i of visits) {
      if (i.result !== '고장') continue;
      faults.set(i.lightId, (faults.get(i.lightId) || 0) + 1);
      const l = byId.get(i.lightId), circuit = l && l.sw || '점멸기 미지정';
      circuits.set(circuit, (circuits.get(circuit) || 0) + 1);
    }
    const now = Date.now(), durations = verified.filter(w => w.verifiedAt >= w.createdAt).map(w => (w.verifiedAt - w.createdAt) / 86400000);
    return { inspectionCount: visits.length, uniqueInspected: new Set(visits.map(i => i.lightId)).size,
      opened: opened.length, verified: verified.length, unresolved: unresolved.length,
      overdue: unresolved.filter(w => w.dueAt && w.dueAt < now).length,
      cost: verified.reduce((sum, w) => sum + w.cost, 0),
      averageDays: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      pendingReports: reports.filter(r => r.status !== '완료').length,
      repeated: [...faults].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]),
      circuits: [...circuits].sort((a, b) => b[1] - a[1]) };
  }
  function inventoryChange(item, delta, expectedRevision) {
    if (item.revision !== expectedRevision) fail('재고가 변경됐어요. 최신 수량을 확인해 주세요.', 'conflict');
    const next = finite(item.quantity, 0, 100000000, '현재 재고') + finite(delta, -100000000, 100000000, '입출고');
    if (next < 0) fail('재고보다 많은 수량을 출고할 수 없어요.');
    return { ...item, quantity: Math.round(next * 1000) / 1000, revision: item.revision + 1 };
  }
  return { STATES, PRIORITIES, TYPES, FIELDS, text, list, parts, measurements, costTotal, createOrder, actions, transition, inspectionState, distance, planVisits, normalizeRegistry, registryDiff, analytics, inventoryChange };
});
