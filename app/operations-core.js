(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGOperationsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STATES = { draft: '배정 대기', assigned: '배정됨', in_progress: '작업 중', completed: '검수 대기', verified: '완료', cancelled: '취소' };
  const PRIORITIES = ['긴급', '높음', '보통', '낮음'];
  const TYPES = ['수리', '재점검', '신설검토', '철거', '기타'];
  const DIAGNOSES = { lamp: '램프', power: '전원', controller: '점멸기', fixture: '등기구', pole: '등주·기초', wiring: '배선', external: '외부 요인', unknown: '원인 미확정' };
  const REPAIR_ACTIONS = { replace: '부품 교체', repair: '수리', adjust: '조정', restore_power: '전원 복구', inspect: '점검·확인', refer: '관련 기관 이관', none: '현장 조치 없음' };
  const HOLD_REASONS = { material: '자재 입고 대기', external: '외부 협의', equipment: '장비·인력 필요', weather: '기상·현장 조건', other: '기타' };
  // the registry's columns (data/lights.json); addr/jibun/mgmt/posApprox came with the 2026-09-10 public-data merge
  const FIELDS = ['lampId', 'label', 'code', 'kind', 'dong', 'num', 'road', 'main', 'sub', 'lat', 'lng', 'lampType', 'pole', 'sw', 'removed', 'noPlate', 'dongGuess', 'addr', 'jibun', 'mgmt', 'posApprox'];
  const FLAGS = ['removed', 'noPlate', 'dongGuess', 'posApprox'];
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
      parts: values, costTotal: costTotal(values), accountedCost: 0, measurements: measurements(input.measurements || []), stockApplied: {},
      ...(input.workflowVersion === 2 ? { workflowVersion: 2, acknowledgedAt: 0, acknowledgedBy: '', hold: null, diagnosis: '', repairAction: '' } : {})
    };
  }
  function actions(order, actor, admin) {
    if (!order || (!admin && order.assignedTo !== actor)) return [];
    const graph = { draft: ['assigned', 'cancelled'], assigned: ['in_progress', 'cancelled'], in_progress: ['completed', 'assigned', 'cancelled'], completed: ['verified', 'in_progress'], verified: ['assigned'], cancelled: ['draft'] };
    return (graph[order.status] || []).filter(s => admin || (order.status === 'assigned' && s === 'in_progress') || (order.status === 'in_progress' && s === 'completed'));
  }
  function updateOrder(order, input, actor, admin, now) {
    if (!admin) fail('작업 정보는 관리자만 수정할 수 있어요.', 'permission-denied');
    if (!order || !['draft', 'assigned', 'in_progress', 'completed'].includes(order.status)) fail('진행 중인 작업의 정보만 수정할 수 있어요.', 'failed-precondition');
    if (!input || Number(input.expectedRevision) !== Number(order.revision)) fail('다른 직원이 작업을 변경했어요. 최신 내용을 확인해 주세요.', 'conflict');
    const fields = ['title', 'description', 'type', 'priority', 'assignedTo', 'dueAt', 'parts'];
    if (Object.keys(input).some(key => key !== 'expectedRevision' && !fields.includes(key))) fail('수정할 수 없는 작업 정보가 포함됐어요.');
    if (!fields.some(key => Object.prototype.hasOwnProperty.call(input, key))) fail('수정할 작업 정보를 입력해 주세요.');
    const next = clone(order); delete next.id;
    if (input.title !== undefined) { next.title = text(input.title, 120); if (!next.title) fail('작업 제목을 입력해 주세요.'); }
    if (input.description !== undefined) next.description = text(input.description, 2000);
    if (input.type !== undefined) { if (!TYPES.includes(input.type)) fail('작업 종류를 확인해 주세요.'); next.type = input.type; }
    if (input.priority !== undefined) { if (!PRIORITIES.includes(input.priority)) fail('우선순위를 확인해 주세요.'); next.priority = input.priority; }
    if (input.assignedTo !== undefined) next.assignedTo = text(input.assignedTo, 180);
    if (next.assignedTo !== order.assignedTo && next.status === 'completed') fail('검수 대기 작업의 담당자는 보완 요청으로 작업을 되돌린 뒤 바꿔 주세요.', 'failed-precondition');
    if (next.assignedTo !== order.assignedTo) { next.acknowledgedAt = 0; next.acknowledgedBy = ''; next.hold = null; }
    if (next.status !== 'draft' && !next.assignedTo) fail('담당자를 선택해 주세요.');
    if (input.dueAt !== undefined) { next.dueAt = finite(input.dueAt, 0, Number.MAX_SAFE_INTEGER, '완료 기한'); if (!Number.isSafeInteger(next.dueAt)) fail('완료 기한을 확인해 주세요.'); }
    if (input.parts !== undefined) {
      if (next.status === 'completed') fail('검수 대기 작업의 사용 자재는 작업 보완 후 수정해 주세요.', 'failed-precondition');
      next.parts = parts(input.parts); next.costTotal = costTotal(next.parts);
    }
    next.revision = order.revision + 1; next.updatedAt = now; next.updatedBy = actor;
    return next;
  }
  function transition(order, target, input, actor, admin, now) {
    if (!order || !actions(order, actor, admin).includes(target)) fail('현재 상태 또는 담당자 권한으로 처리할 수 없어요.', 'permission-denied');
    if (Number(input.expectedRevision) !== Number(order.revision)) fail('다른 직원이 작업을 변경했어요. 최신 내용을 확인해 주세요.', 'conflict');
    const next = clone(order); delete next.id;
    if (order.hold && ['in_progress', 'completed'].includes(target) && order.status !== 'completed') fail('보류를 해제한 뒤 작업을 진행해 주세요.', 'failed-precondition');
    next.status = target; next.revision = order.revision + 1; next.updatedAt = now; next.updatedBy = actor;
    if (admin && input.assignedTo !== undefined) next.assignedTo = text(input.assignedTo, 180);
    if (next.assignedTo !== order.assignedTo || order.status === 'verified' && target === 'assigned') { next.acknowledgedAt = 0; next.acknowledgedBy = ''; next.hold = null; }
    if (admin && input.dueAt !== undefined) next.dueAt = finite(input.dueAt, 0, Number.MAX_SAFE_INTEGER, '완료 기한');
    if (target === 'assigned' && !next.assignedTo) fail('담당자를 선택해 주세요.');
    if (target === 'completed') {
      next.afterPhotos = list(input.afterPhotos || next.afterPhotos, 6);
      if (!next.afterPhotos.length) fail('조치 후 사진을 한 장 이상 첨부해 주세요.');
      next.completionNote = text(input.completionNote, 2000);
      if (!next.completionNote) fail('조치 내용을 기록해 주세요.');
      if (order.workflowVersion === 2 || input.diagnosis !== undefined || input.repairAction !== undefined) {
        if (!Object.hasOwn(DIAGNOSES, input.diagnosis) || !Object.hasOwn(REPAIR_ACTIONS, input.repairAction)) fail('고장 원인과 조치 유형을 선택해 주세요.');
        next.diagnosis = input.diagnosis; next.repairAction = input.repairAction;
      }
      next.parts = parts(input.parts || next.parts || []); next.costTotal = costTotal(next.parts);
      next.measurements = measurements(input.measurements || next.measurements || []);
      next.completedAt = now; next.completedBy = actor;
    }
    if (['verified', 'cancelled'].includes(target)) next.hold = null;
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
  function workProcess(order, action, input, actor, admin, now) {
    if (!order || !['assigned', 'in_progress'].includes(order.status) || !actor || (!admin && order.assignedTo !== actor)) fail('현재 작업의 담당자 또는 관리자만 처리할 수 있어요.', 'permission-denied');
    if (Number(input?.expectedRevision) !== Number(order.revision)) fail('작업이 변경됐어요. 최신 내용을 확인해 주세요.', 'conflict');
    const next = clone(order); delete next.id;
    if (action === 'acknowledge') {
      if (order.assignedTo !== actor) fail('배정받은 담당자만 수신 확인할 수 있어요.', 'permission-denied');
      next.acknowledgedAt = now; next.acknowledgedBy = actor;
    } else if (action === 'hold') {
      const nextAt = Number(input.nextAt), note = text(input.note, 500), nextAction = text(input.nextAction, 500);
      if (!Object.hasOwn(HOLD_REASONS, input.reason) || !Number.isSafeInteger(nextAt) || nextAt <= now || !nextAction || input.reason === 'other' && !note) fail('보류 사유·다음 확인일·다음 할 일을 입력해 주세요.');
      next.hold = { reason: input.reason, note, nextAt, nextAction, since: order.hold?.since || now, by: actor };
    } else if (action === 'resume') {
      if (!order.hold) fail('현재 보류 중인 작업이 아니에요.'); next.hold = null;
    } else fail('지원하지 않는 작업 처리예요.');
    next.revision = order.revision + 1; next.updatedAt = now; next.updatedBy = actor;
    return next;
  }
  function attentionItems(orders, actor, admin, now = Date.now()) {
    // Work handed in for review is the administrator's to act on. A work with no acknowledgedAt field at all
    // was assigned before acknowledgement existed; reassignment records acknowledgedAt: 0 and flags it again.
    return (orders || []).filter(order => !['verified', 'cancelled'].includes(order.status) && (admin || order.assignedTo === actor && order.status !== 'completed')).map(order => {
      const reasons = [], tracksAcknowledgement = order.workflowVersion === 2 || Object.hasOwn(order, 'acknowledgedAt');
      if (order.assignedTo && tracksAcknowledgement && ['assigned', 'in_progress'].includes(order.status) && (!order.acknowledgedAt || order.acknowledgedBy !== order.assignedTo)) reasons.push('배정 미확인');
      if (order.priority === '긴급') reasons.push('긴급');
      if (order.dueAt && order.dueAt < now) reasons.push('기한 초과'); else if (order.dueAt && order.dueAt <= now + 86400000) reasons.push('기한 임박');
      if (order.hold?.nextAt <= now) reasons.push('보류 확인일 도래');
      return { ...order, reasons, urgency: reasons.includes('기한 초과') || reasons.includes('긴급') ? 0 : 1 };
    }).filter(order => order.reasons.length).sort((a, b) => a.urgency - b.urgency || (a.dueAt || Infinity) - (b.dueAt || Infinity) || a.id.localeCompare(b.id));
  }
  function inspectionState(light, days, now) {
    if (light.removed) return { key: 'removed', label: '철거', priority: 99 };
    if (light.redoNote) return { key: 'redo', label: '재점검 요청', priority: 0 };
    if (!Number.isFinite(light.lastInspected) || light.lastInspected <= 0) return { key: 'never', label: '점검 기록 없음', priority: 2 };
    const elapsed = Math.floor(Math.max(0, now - light.lastInspected) / 86400000);
    return elapsed > days ? { key: 'overdue', label: '기한 ' + (elapsed - days) + '일 초과', priority: 1, overdueDays: elapsed - days } : { key: 'current', label: '기한 내 점검', priority: 3, remainingDays: days - elapsed };
  }
  function kstDateKey(at = Date.now()) { return new Date(at + 9 * 3600000).toISOString().slice(0, 10); }
  function workQuery(filters, user, now = Date.now()) {
    const where = [], status = filters.status || 'open';
    if (status === 'open') where.push(['status', 'in', ['draft', 'assigned', 'in_progress', 'completed']]);
    else if (status !== 'all') where.push(['status', '==', status]);
    if (filters.mine) where.push(['assignedTo', '==', user]);
    if (filters.urgent) where.push(['priority', '==', '긴급']);
    const start = Date.parse(kstDateKey(now) + 'T00:00:00+09:00');
    if (filters.deadline === 'today') where.push(['dueAt', '>=', start], ['dueAt', '<', start + 86400000]);
    if (filters.deadline === 'overdue') where.push(['dueAt', '>', 0], ['dueAt', '<', now]);
    return { where, orderBy: filters.deadline && filters.deadline !== 'all' ? [['dueAt', 'asc']] : [['updatedAt', 'desc']] };
  }
  function filterOrders(orders, filters, options = {}) {
    const now = options.now || Date.now(), day = kstDateKey(now), { user, inDong, byId } = options;
    return orders.filter(w => {
      const open = !['verified', 'cancelled'].includes(w.status), status = filters.status || 'open';
      return (status === 'all' || status === 'open' ? status === 'all' || open : w.status === status)
        && (!filters.mine || w.assignedTo === user) && (!filters.urgent || w.priority === '긴급')
        && (filters.deadline !== 'today' || !!w.dueAt && kstDateKey(w.dueAt) === day)
        && (filters.deadline !== 'overdue' || !!w.dueAt && w.dueAt < now)
        && (!filters.dong || filters.dong === '전체' || (inDong ? inDong(byId?.(w.lightId) || w, filters.dong) : w.dong === filters.dong));
    });
  }
  function distance(a, b) {
    const rad = Math.PI / 180, dlat = (b.lat - a.lat) * rad, dlng = (b.lng - a.lng) * rad;
    const x = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
  }
  /* Visit order (노선) on straight lines: no road network is used, so this is a suggested order, not a driving route.
     1) duplicate facilities merge into one stop (their linked works are kept together);
     2) with a start position the route begins at the nearest stop, otherwise every stop is tried as the start;
     3) the nearest-neighbour chain is then improved with 2-opt (uncrossing legs) and Or-opt (moving 1~3 stops). */
  const PLAN_MAX = 200;
  function registryQuality(lights) {
    const active = lights.filter(l => !l.removed && l.reg !== '반려' && !(l.reg === '대장반영' && l.linkedId));
    return { total: lights.length, active: active.length, removed: lights.filter(l => l.removed).length,
      approximate: active.filter(l => l.posApprox).length, inferredDong: active.filter(l => l.dongGuess).length, noPlate: active.filter(l => l.noPlate).length };
  }
  function planVisits(lights, origin) {
    const merged = new Map(), approximate = new Map();
    for (const l of lights) {
      if (!l || l.removed || !Number.isFinite(l.lat) || !Number.isFinite(l.lng)) continue;
      if (l.posApprox) { approximate.set(l.id, { id: l.id, code: l.code, dong: l.dong }); continue; }
      const works = Array.isArray(l.workIds) ? l.workIds : [], seen = merged.get(l.id);
      if (seen) { for (const id of works) if (!seen.workIds.includes(id)) seen.workIds.push(id); continue; }
      merged.set(l.id, { id: l.id, code: l.code, dong: l.dong, lat: l.lat, lng: l.lng, workIds: [...new Set(works)] });
    }
    const left = [...merged.values()];
    if (left.length > PLAN_MAX) fail('한 방문 계획에는 최대 ' + PLAN_MAX + '개 시설을 선택해 주세요.');
    const start = origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng) ? { lat: origin.lat, lng: origin.lng } : null;
    const order = routeOrder(left, start);
    const stops = order.map(i => ({ ...left[i], distanceFromPrevious: 0, visited: false }));
    const plan = { stops, distance: 0, method: 'straight-line-optimized', createdAt: Date.now(), excludedApproximate: [...approximate.values()].filter(l => !merged.has(l.id)) };
    if (start) { plan.origin = start; plan.startDistance = stops.length ? Math.round(distance(start, stops[0])) : 0; }
    return planLegs(plan);
  }
  // Old plans did not retain posApprox. Recheck the current registry without losing the user's order or visited flags.
  function reconcilePlan(plan, lookup) {
    const next = clone(plan), approximate = new Map((next.excludedApproximate || []).map(s => [s.id, s])), unavailable = new Map((next.excludedUnavailable || []).map(s => [s.id, s]));
    const visible = next.stops || [], candidates = new Map([...(next.pendingPositions || []), ...visible].map(stop => [stop.id, stop]));
    const visibleIds = new Set(visible.map(stop => stop.id)); let index = 0;
    // Reordering visible stops keeps excluded stops in their old gaps. Keep the full stop, including visits/work IDs,
    // while the initial Firebase override snapshot is still missing or showing the uncorrected registry estimate.
    const order = (next.positionOrder || visible.map(stop => stop.id)).filter(id => candidates.has(id)).map(id => visibleIds.has(id) ? visible[index++].id : id);
    for (const id of candidates.keys()) if (!order.includes(id)) order.push(id);
    next.positionOrder = [...new Set(order)]; next.pendingPositions = [];
    next.stops = next.positionOrder.flatMap(id => {
      const stop = candidates.get(id);
      const current = lookup(stop.id);
      if (!current || current.removed || !Number.isFinite(current.lat) || !Number.isFinite(current.lng)) { approximate.delete(stop.id); unavailable.set(stop.id, { id: stop.id, code: stop.code }); next.pendingPositions.push(stop); return []; }
      if (current.posApprox) { unavailable.delete(stop.id); approximate.set(stop.id, { id: stop.id, code: current.code || stop.code, dong: current.dong }); next.pendingPositions.push(stop); return []; }
      approximate.delete(stop.id); unavailable.delete(stop.id);
      return [{ ...stop, code: current.code || stop.code, dong: current.dong || stop.dong, lat: current.lat, lng: current.lng }];
    });
    next.excludedApproximate = [...approximate.values()]; next.excludedUnavailable = [...unavailable.values()];
    planLegs(next); if (next.origin) next.startDistance = next.stops.length ? Math.round(distance(next.origin, next.stops[0])) : 0;
    return next;
  }
  /* legs between consecutive stops; the walk from the start position to the first stop is kept apart in startDistance */
  // Move one unfinished stop of a visit plan: 'next' to the first unfinished place, 'earlier'/'later' past the
  // neighbouring unfinished stop. Finished stops keep their place. Returns a new array, or null when nothing moves.
  function moveOpenStop(stops, id, where, isDone) {
    const open = stops.map((stop, index) => isDone(stop) ? -1 : index).filter(index => index >= 0), from = stops.findIndex(stop => stop.id === id), at = open.indexOf(from);
    if (at < 0) return null;
    const target = where === 'next' ? 0 : where === 'earlier' ? at - 1 : where === 'later' ? at + 1 : -1;
    if (target < 0 || target >= open.length || target === at) return null;
    const order = open.map(index => stops[index]), [moved] = order.splice(at, 1); order.splice(target, 0, moved);
    const next = stops.slice(); open.forEach((index, n) => { next[index] = order[n]; }); return next;
  }
  function planLegs(plan) {
    plan.stops.forEach((s, i) => { s.distanceFromPrevious = i ? Math.round(distance(plan.stops[i - 1], s)) : 0; });
    plan.distance = plan.stops.reduce((sum, s) => sum + s.distanceFromPrevious, 0);
    return plan;
  }
  function routeOrder(points, start) {
    const n = points.length; if (n < 2) return points.map((_, i) => i);
    // local flat projection in metres: accurate enough inside one district and much cheaper than haversine
    const lat0 = (start || points[0]).lat, k = Math.cos(lat0 * Math.PI / 180) * 111320, xy = points.map(p => [(p.lng - (start || points[0]).lng) * k, (p.lat - lat0) * 110574]);
    const D = (i, j) => Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]);
    const chain = first => {
      const used = new Uint8Array(n), out = [first]; used[first] = 1; let cur = first, total = 0;
      for (let step = 1; step < n; step++) { let best = -1, bd = Infinity; for (let j = 0; j < n; j++) if (!used[j]) { const d = D(cur, j); if (d < bd) { bd = d; best = j; } } used[best] = 1; out.push(best); total += bd; cur = best; }
      return { out, total };
    };
    let route, fixFirst = !!start;
    if (start) {
      let first = 0, bd = Infinity; // the projection is centred on the start, so it sits at (0, 0)
      xy.forEach(([x, y], i) => { const d = Math.hypot(x, y); if (d < bd) { bd = d; first = i; } });
      route = chain(first).out;
    } else {
      let best = null; for (let f = 0; f < n; f++) { const c = chain(f); if (!best || c.total < best.total) best = c; }
      route = best.out;
    }
    improveRoute(route, D, fixFirst);
    return route;
  }
  function improveRoute(r, D, fixFirst) {
    const n = r.length, lo = fixFirst ? 1 : 0, EPS = 1e-6;
    for (let pass = 0, improved = true; improved && pass < 60; pass++) {
      improved = false;
      // 2-opt on an open path: reverse r[i..j]
      for (let i = lo; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
        const before = (i > 0 ? D(r[i - 1], r[i]) : 0) + (j < n - 1 ? D(r[j], r[j + 1]) : 0);
        const after = (i > 0 ? D(r[i - 1], r[j]) : 0) + (j < n - 1 ? D(r[i], r[j + 1]) : 0);
        if (after < before - EPS) { for (let a = i, b = j; a < b; a++, b--) [r[a], r[b]] = [r[b], r[a]]; improved = true; }
      }
      // Or-opt: move a run of 1~3 stops (either way round) to the best other gap
      for (let len = 1; len <= 3; len++) for (let i = lo; i + len <= n; i++) {
        const seg = r.slice(i, i + len), prev = i > 0 ? r[i - 1] : -1, next = i + len < n ? r[i + len] : -1;
        const removeGain = (prev >= 0 ? D(prev, seg[0]) : 0) + (next >= 0 ? D(seg[len - 1], next) : 0) - (prev >= 0 && next >= 0 ? D(prev, next) : 0);
        const rest = [...r.slice(0, i), ...r.slice(i + len)];
        let bestCost = removeGain - EPS, bestAt = -1, bestRev = false;
        for (let g = fixFirst ? 1 : 0; g <= rest.length; g++) {
          if (g === i) continue; // the gap it came from
          const a = g > 0 ? rest[g - 1] : -1, b = g < rest.length ? rest[g] : -1;
          for (const rev of [false, true]) {
            const h = rev ? seg[len - 1] : seg[0], t = rev ? seg[0] : seg[len - 1];
            const cost = (a >= 0 ? D(a, h) : 0) + (b >= 0 ? D(t, b) : 0) - (a >= 0 && b >= 0 ? D(a, b) : 0);
            if (cost < bestCost) { bestCost = cost; bestAt = g; bestRev = rev; }
          }
        }
        if (bestAt >= 0) { const moved = bestRev ? seg.slice().reverse() : seg; rest.splice(bestAt, 0, ...moved); r.splice(0, n, ...rest); improved = true; }
      }
    }
    return r;
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
      for (const field of FIELDS) if (field !== 'lat' && field !== 'lng' && Object.prototype.hasOwnProperty.call(row, field)) out[field] = row[field] == null ? null : FLAGS.includes(field) ? !!row[field] : text(row[field], 200);
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
        if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
        const scalar = value => value == null ? null : FLAGS.includes(field) ? !!value : value;
        const a = scalar(previous[field]), b = scalar(row[field]);
        if (a !== b) {
          changes[field] = b;
          if (overrides && overrides[row.id] && Object.prototype.hasOwnProperty.call(overrides[row.id], field) && scalar(overrides[row.id][field]) !== a && scalar(overrides[row.id][field]) !== b) conflicts.push(field);
        }
      }
      if (Object.keys(changes).length) {
        const registryValues = { id: row.id };
        for (const field of FIELDS) if (Object.prototype.hasOwnProperty.call(previous, field)) registryValues[field] = clone(previous[field]);
        Object.assign(registryValues, clone(row));
        changed.push({ id: row.id, code: row.code, before: previous, changes, conflicts, registryValues, overrideBefore: clone(overrides && overrides[row.id] || {}) });
      }
    }
    for (const row of base) if (!seen.has(row.id)) missing.push({ ...row, overrideBefore: clone(overrides && overrides[row.id] || {}) });
    return { added, changed, missing, unchanged: incoming.length - added.length - changed.length, incomingCount: incoming.length };
  }
  function analytics(inspections, orders, reports, lights, from, to, events, topology = {}) {
    const inRange = t => typeof t === 'number' && t >= from && t <= to;
    const visits = inspections.filter(i => inRange(i.date)), opened = orders.filter(w => inRange(w.createdAt));
    const verified = Array.isArray(events) ? events.filter(e => e.toStatus === 'verified' && inRange(e.at)).map(e => ({ verifiedAt: e.at, createdAt: e.createdAt, cost: Number(e.costDelta == null ? e.costTotal : e.costDelta) || 0 })) : orders.filter(w => w.status === 'verified' && inRange(w.verifiedAt)).map(w => ({ verifiedAt: w.verifiedAt, createdAt: w.createdAt, cost: Number(w.costTotal) || 0 }));
    const unresolved = orders.filter(w => !['verified', 'cancelled'].includes(w.status));
    const faults = new Map(), circuits = new Map(), switchTypes = new Map();
    const links = new Map((topology.links || []).map(link => [link.lightId || link.id, link.circuitId]));
    const circuitNames = new Map((topology.circuits || []).map(circuit => [circuit.id, circuit.name || circuit.label || circuit.id]));
    const nameCounts = new Map(), circuitCodes = new Map((topology.circuits || []).map(circuit => [circuit.id, circuit.code]));
    for (const name of circuitNames.values()) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    const circuitLabel = id => { const name = circuitNames.get(id); return !name ? '회로 미등록' : nameCounts.get(name) > 1 ? name + ' (' + (circuitCodes.get(id) ? circuitCodes.get(id) + ' · ' : '') + id + ')' : name; };
    const byId = new Map(lights.map(l => [l.id, l]));
    for (const i of visits) {
      if (i.result !== '고장') continue;
      faults.set(i.lightId, (faults.get(i.lightId) || 0) + 1);
      const l = byId.get(i.lightId), linked = links.get(i.lightId), circuit = linked && circuitNames.has(linked) ? linked : null;
      circuits.set(circuit, (circuits.get(circuit) || 0) + 1);
      const switchType = l && l.sw || '점멸기 종류 미지정'; switchTypes.set(switchType, (switchTypes.get(switchType) || 0) + 1);
    }
    const now = Date.now(), durations = verified.filter(w => w.verifiedAt >= w.createdAt).map(w => (w.verifiedAt - w.createdAt) / 86400000);
    return { inspectionCount: visits.length, uniqueInspected: new Set(visits.map(i => i.lightId)).size,
      opened: opened.length, verified: verified.length, unresolved: unresolved.length,
      overdue: unresolved.filter(w => w.dueAt && w.dueAt < now).length,
      cost: verified.reduce((sum, w) => sum + w.cost, 0),
      averageDays: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      pendingReports: reports.filter(r => r.status !== '완료').length,
      repeated: [...faults].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]),
      circuits: [...circuits].sort((a, b) => b[1] - a[1]).map(([id, count]) => [circuitLabel(id), count]), switchTypes: [...switchTypes].sort((a, b) => b[1] - a[1]) };
  }
  function inventoryChange(item, delta, expectedRevision) {
    if (item.revision !== expectedRevision) fail('재고가 변경됐어요. 최신 수량을 확인해 주세요.', 'conflict');
    const next = finite(item.quantity, 0, 100000000, '현재 재고') + finite(delta, -100000000, 100000000, '입출고');
    if (next < 0) fail('재고보다 많은 수량을 출고할 수 없어요.');
    if (next > 100000000) fail('재고 수량이 허용 범위를 넘었어요.');
    return { ...item, quantity: Math.round(next * 1000) / 1000, revision: item.revision + 1 };
  }
  // Informational forecast only. Already deducted quantities on reopened work must not be counted twice.
  function inventoryForecast(inventory, orders) {
    const rows = (inventory || []).map(item => ({ id: item.id, name: item.name, unit: item.unit, quantity: Number(item.quantity) || 0, planned: 0, available: Number(item.quantity) || 0, shortage: 0, workIds: [] }));
    const byId = new Map(rows.map(row => [row.id, row])), unlinked = [];
    for (const work of orders || []) {
      if (!['draft', 'assigned', 'in_progress', 'completed'].includes(work.status)) continue;
      const wanted = new Map();
      for (const part of work.parts || []) {
        const qty = Number(part.qty); if (!Number.isFinite(qty) || qty <= 0) continue;
        if (!part.inventoryId || !byId.has(part.inventoryId)) { unlinked.push({ workId: work.id, name: part.name, qty, inventoryId: part.inventoryId || '' }); continue; }
        wanted.set(part.inventoryId, (wanted.get(part.inventoryId) || 0) + qty);
      }
      for (const [id, qty] of wanted) {
        const net = Math.max(0, qty - (Number(work.stockApplied?.[id]) || 0)); if (!net) continue;
        const row = byId.get(id); row.planned = Math.round((row.planned + net) * 1000) / 1000; row.workIds.push(work.id);
      }
    }
    for (const row of rows) { row.available = Math.round((row.quantity - row.planned) * 1000) / 1000; row.shortage = Math.max(0, -row.available); row.workIds = [...new Set(row.workIds)]; }
    return { rows, unlinked };
  }
  return { STATES, PRIORITIES, TYPES, DIAGNOSES, REPAIR_ACTIONS, HOLD_REASONS, FIELDS, text, list, parts, measurements, costTotal, createOrder, actions, updateOrder, transition, workProcess, attentionItems, inspectionState, kstDateKey, workQuery, filterOrders, distance, planLegs, moveOpenStop, PLAN_MAX, registryQuality, planVisits, reconcilePlan, normalizeRegistry, registryDiff, analytics, inventoryChange, inventoryForecast };
});
