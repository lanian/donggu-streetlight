/* Review scenarios: registry model, supplemental sources, and field evidence are shown separately. */
function invalidateLightingReview(reason) {
  S.rvRevision = (S.rvRevision || 0) + 1;
  if (!S.review) return;
  S.review = null; S.rvMessage = reason + ' 검토를 다시 실행해 주세요.';
  if (document.getElementById('rvMapSummary')) { closeSheet(); toast(S.rvMessage); }
}
function rvFresh() {
  const rv = S.review;
  if (rv && (rv.inputRevision !== (S.rvRevision || 0) || Date.now() >= rv.validUntil)) invalidateLightingReview('자료 또는 재확인 기한이 바뀌었어요.');
  return S.review;
}
function rvExpireAt(deadline) {
  clearTimeout(rvExpireAt.timer);
  if (!Number.isFinite(deadline)) return;
  rvExpireAt.timer = setTimeout(() => {
    if (S.review && Date.now() >= S.review.validUntil) { rvFresh(); render(); }
    else if (S.review) rvExpireAt(S.review.validUntil);
  }, Math.max(20, Math.min(2147483647, deadline - Date.now() + 20)));
}
function rvContext() { return DGLighting.context({ now: Date.now(), minute: S.rvMinute ?? 1260, weak: LIGHT_MODEL.weak }); }
function rvAreaContext() { return globalThis.DGLightingAreas ? DGLightingAreas.context() : null; }
function rvAreaDecision(context, point) { return context ? DGLightingAreaCore.decision(context, point) : { excluded: false, includeIds: [], excludeIds: [] }; }
function rvAreaPieces(context, start, end) { return context ? DGLightingAreaCore.splitSegment(context, start, end) : [{ start, end, point: { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 }, fraction: 1, excluded: false, includeIds: [], excludeIds: [] }]; }
function rvScopeSummary() { return { manualMeters: 0, manualPoints: 0, includedMeters: 0, byArea: {} }; }
function rvCountExcluded(summary, ids, length = 0) {
  summary[length ? 'manualMeters' : 'manualPoints'] += length || 1;
  for (const id of ids) { const row = summary.byArea[id] || (summary.byArea[id] = { meters: 0, points: 0 }); if (length) row.meters += length; else row.points++; }
}
function rvPointInScope(point, dong, kind, grid) {
  if ((!dong || dong === '전체') && kind === '전체') return true;
  const p = grid.toXY(point), near = grid.near(p.x, p.y, 90).filter(n => !n.it.l.removed).sort((a, b) => a.d - b.d).slice(0, 3).map(n => n.it.l);
  return rvPointInDong(point, dong, near[0]) && (kind === '전체' || !near.length || near.some(l => l.kind === kind));
}
function rvCandidateKey(c) {
  return c.a ? 'pair:' + [c.a.id, c.b.id].sort().join(':') : (c.point ? 'point:' + c.context.observations.map(o => o.id).sort().join(':') : 'road:' + (c.wayId || c.name) + ':' + JSON.stringify([c.pts?.[0], c.pts?.at(-1)])) + ':' + c.mid.lat.toFixed(7) + ':' + c.mid.lng.toFixed(7);
}
function rvEvaluate(ctx, G, point, base) {
  const xy = G.toXY(point);
  return DGLightingModel.evaluate(ctx, point, base, { registryNearby: G.near(xy.x, xy.y, 90).some(n => !n.it.l.removed) });
}
function rvAggregate(samples, unit = 'm') {
  const coverage = { total: 0, bright: 0, dark: 0, conflict: 0, external: 0, unobserved: 0, supported: 0, unit };
  const sources = new Map(), hints = new Map(), observations = new Map();
  let base = 0, adjusted = 0, external = 0, registry = false;
  for (const sample of samples) {
    const e = sample.evidence, weight = sample.length || 1; coverage.total += weight;
    base += e.base * weight; adjusted += e.adjusted * weight; external += e.external * weight;
    if (e.classification !== 'data_gap') registry = true;
    if (e.fieldLevel === 'bright' || e.fieldLevel === 'adequate') coverage.bright += weight;
    else if (e.fieldLevel === 'dark') coverage.dark += weight;
    else if (e.fieldLevel === 'conflict') coverage.conflict += weight;
    else coverage.unobserved += weight;
    if (e.base < LIGHT_MODEL.weak && e.adjusted >= LIGHT_MODEL.weak && e.external > 0) coverage.external += weight;
    if (e.fieldLevel === 'bright' || e.fieldLevel === 'adequate' || e.adjusted >= LIGHT_MODEL.weak && !['dark', 'conflict'].includes(e.fieldLevel)) coverage.supported += weight;
    for (const source of e.sources) { if (!sources.has(source.id) || sources.get(source.id).contribution < source.contribution) sources.set(source.id, source); }
    for (const hint of e.hints) hints.set(hint.id + ':' + hint.reason, hint);
    for (const observation of e.observations) observations.set(observation.id, observation);
  }
  const total = coverage.total || 1;
  const classification = coverage.conflict ? 'conflict' : coverage.dark ? 'observed_dark' : coverage.bright >= total - .01 ? 'observed_bright' : coverage.supported >= total - .01 ? 'external_supported' : coverage.supported > 0 ? 'partial_supported' : !registry ? 'data_gap' : base / total < LIGHT_MODEL.weak ? 'model_weak' : 'model_lit';
  return { base: base / total, adjusted: adjusted / total, external: external / total, classification, coverage, sources: [...sources.values()], hints: [...hints.values()], observations: [...observations.values()] };
}
function rvPriority(context) {
  return { conflict: 280, observed_dark: 250, data_gap: 80, model_weak: 100, partial_supported: 30, external_supported: -150, observed_bright: -160, model_lit: -170 }[context.classification] || 0;
}
function rvPointInDong(point, dong, nearest) {
  if (dong === '전체' || !dong) return true;
  if (dong.startsWith('a:') && ROADS?.bounds?.length) {
    const name = dong.slice(2);
    return ROADS.bounds.some(b => b.name === name && (b.polygons || []).some(p => DongguField.inPolygon(point.lng, point.lat, { outer: p.outer.map(q => [q[1], q[0]]), holes: (p.holes || []).map(r => r.map(q => [q[1], q[0]])) })));
  }
  return !!nearest && inDong(nearest, dong);
}
function rvAddObservationPoints(out, dong, kind, ctx, G, areaContext, automaticAreas = []) {
  const included = new Set(out.flatMap(c => c.context.observations.map(o => o.id))), seen = new Set();
  for (const record of ctx.records) {
    if (record.kind !== 'observation' || record.removed || included.has(record.id)) continue;
    const xy = G.toXY(record), E = G.lightAt(xy.x, xy.y), evidence = rvEvaluate(ctx, G, record, E);
    if (!['dark', 'conflict'].includes(evidence.fieldLevel) || !evidence.observations.some(o => o.id === record.id)) continue;
    const near = G.near(xy.x, xy.y, 90).filter(n => !n.it.l.removed).sort((a, b) => a.d - b.d).slice(0, 3).map(n => n.it.l);
    if (!rvPointInDong(record, dong, near[0]) || kind !== '전체' && near.length && !near.some(l => l.kind === kind)) continue;
    const key = evidence.observations.map(o => o.id).sort().join('|'); if (seen.has(key)) continue; seen.add(key);
    const context = rvAggregate([{ evidence, length: 1 }], 'point');
    const area = rvAreaDecision(areaContext, record);
    const automatic = !area.includeIds.length && automaticAreas.some(a => xy.x >= a.x0 && xy.x <= a.x1 && xy.y >= a.y0 && xy.y <= a.y1 && DongguField.inPolygon(xy.x, xy.y, a));
    out.push({ point: true, name: record.label, typeLabel: '현장 관찰 지점', mid: { lat: record.lat, lng: record.lng }, E, context, near, dong: near[0]?.dong || '', nolight: !near.length, dark: near.some(l => onOf(l) === 0), score: rvPriority(context) + 20, scopeException: area.excluded ? area.excludeIds : automatic ? ['automatic'] : [] });
  }
}
function lightReview(dong, kind) {
  const G = lightGrid(), ctx = rvContext(), areaContext = rvAreaContext(), seen = new Set(), cands = [], summary = rvScopeSummary();
  const items = G.items.filter(it => inDong(it.l, dong) && (kind === '전체' || it.l.kind === kind) && !it.l.removed);
  // Discover mixed-kind pairs symmetrically before removing the reversed ID pair.
  // Otherwise a 60m street/park pair disappears when the 50m park light has the lower ID.
  const searchRadius = Math.max(62, ...Object.values(LIGHT_MODEL.pairMax));
  for (const a of items) for (const { it: b, d } of G.near(a.x, a.y, searchRadius)) {
    if (b === a || b.l.removed || b.l.id < a.l.id || kind !== '전체' && b.l.kind !== kind) continue;
    if (d > Math.max(LIGHT_MODEL.pairMax[a.l.kind] || 62, LIGHT_MODEL.pairMax[b.l.kind] || 62)) continue;
    const need = (a.r + b.r) * LIGHT_MODEL.gapFactor;
    if (d <= need && a.on > 0 && b.on > 0) continue;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, E = G.lightAt(mx, my);
    if (E >= LIGHT_MODEL.weak || G.near(mx, my, d * .35).some(({ it }) => it !== a && it !== b && it.on > 0)) continue;
    const key = `${Math.round(mx / 15)},${Math.round(my / 15)}`; if (seen.has(key)) continue; seen.add(key);
    const mid = G.toLL(mx, my), dark = a.on === 0 || b.on === 0, context = rvAggregate([{ evidence: rvEvaluate(ctx, G, mid, E), length: 1 }], 'point');
    if (!rvPointInScope(mid, dong, kind, G)) continue;
    const area = rvAreaDecision(areaContext, mid);
    if (area.excluded && !['conflict', 'observed_dark'].includes(context.classification)) { rvCountExcluded(summary, area.excludeIds); continue; }
    cands.push({ a: a.l, b: b.l, d: Math.round(d), need: Math.round(need), E, dark, mid, context, score: rvPriority(context) + Math.min(70, d - need) + (LIGHT_MODEL.weak - E) * 40, dong: a.l.dong, scopeException: area.excluded ? area.excludeIds : [] });
  }
  rvAddObservationPoints(cands, dong, kind, ctx, G, areaContext); cands.sort((a, b) => b.score - a.score); cands.areaSummary = summary; return cands;
}
function roadReview(dong, kind) {
  const G = lightGrid(); if (!ROADS) return [];
  const ctx = rvContext(), areaContext = rvAreaContext(), summary = rvScopeSummary(), weak = LIGHT_MODEL.weak, out = [], areas = roadAreas(G), skip = { ways: 0, apt: 0, forest: 0 };
  const inArea = (x, y) => { for (const a of areas) if (x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1 && DongguField.inPolygon(x, y, a)) return a.t; return ''; };
  for (const w of ROADS.ways) {
    const wayExcluded = !!(w.sv && ROAD_SKIP_SERVICE.test(w.sv) || w.priv || /아파트|APT|주차장/i.test(w.name || ''));
    let acc = [], skippedWay = false;
    const flush = () => {
      const length = acc.reduce((sum, a) => sum + a.length, 0);
      if (length >= 24 - 1e-6) {
        let walked = 0, mid = acc[0];
        for (const piece of acc) {
          if (walked + piece.length >= length / 2) { const t = (length / 2 - walked) / piece.length; mid = { x: piece.start.x + (piece.end.x - piece.start.x) * t, y: piece.start.y + (piece.end.y - piece.start.y) * t }; break; }
          walked += piece.length;
        }
        const midLL = G.toLL(mid.x, mid.y), nb = G.near(mid.x, mid.y, 90).filter(n => !n.it.l.removed).sort((a, b) => a.d - b.d), near = nb.slice(0, 3).map(n => n.it.l);
        if ((kind === '전체' || !near.length || near.some(l => l.kind === kind)) && rvPointInDong(midLL, dong, near[0])) {
          const context = rvAggregate(acc), dark = nb.some(n => n.d < 70 && n.it.on === 0);
          out.push({ wayId: w.id || '', name: w.name || ROAD_LABEL[w.type] || w.type, type: w.type, typeLabel: ROAD_LABEL[w.type] || w.type, len: Math.round(length), mid: midLL, pts: [acc[0].start, ...acc.map(s => s.end)].map(p => G.toLL(p.x, p.y)), E: context.base, dark, nolight: !near.length, near, dong: near[0]?.dong || '', context, scopeException: [...new Set(acc.flatMap(s => s.scopeException || []))],
            score: rvPriority(context) + Math.min(length, 200) / 2 + (weak - context.base) * 40 });
        }
      }
      acc = [];
    };
    // Keep original road corners, then cut every <=8m straight piece at evidence-circle
    // boundaries. A small observed sliver must never mark an entire sample as observed.
    const vertices = w.pts.map(([lat, lng]) => G.toXY({ lat, lng }));
    for (let segment = 1; segment < vertices.length; segment++) for (const sample of DongguField.sampleLine([vertices[segment - 1], vertices[segment]], 8)) {
      const startLL = G.toLL(sample.start.x, sample.start.y), endLL = G.toLL(sample.end.x, sample.end.y);
      for (const areaPiece of rvAreaPieces(areaContext, startLL, endLL)) for (const piece of DGLightingModel.splitSegment(ctx, areaPiece.start, areaPiece.end)) {
        const point = G.toXY(piece.point), length = sample.length * areaPiece.fraction * piece.fraction;
        if (!rvPointInScope(piece.point, dong, kind, G)) { flush(); continue; }
        const E = G.lightAt(point.x, point.y), area = inArea(point.x, point.y);
        const evidence = rvEvaluate(ctx, G, piece.point, E);
        const excluded = areaPiece.excluded || !areaPiece.includeIds.length && (wayExcluded || area);
        const darkEvidence = ['dark', 'conflict'].includes(evidence.fieldLevel);
        if (excluded && !darkEvidence) {
          if (areaPiece.excluded) rvCountExcluded(summary, areaPiece.excludeIds, length);
          else if (wayExcluded) skippedWay = true;
          else skip[area] = (skip[area] || 0) + length;
          flush(); continue;
        }
        if (areaPiece.includeIds.length && (areaPiece.excludeIds.length || wayExcluded || area)) summary.includedMeters += length;
        if (E >= weak && !['dark', 'conflict'].includes(evidence.fieldLevel)) { flush(); continue; }
        acc.push({ ...point, start: G.toXY(piece.start), end: G.toXY(piece.end), length, E, evidence, scopeException: excluded ? (areaPiece.excludeIds.length ? areaPiece.excludeIds : ['automatic']) : [] });
      }
    }
    flush();
    if (skippedWay) skip.ways++;
  }
  rvAddObservationPoints(out, dong, kind, ctx, G, areaContext, areas); out.sort((a, b) => b.score - a.score);
  skip.apt = Math.round(skip.apt); skip.forest = Math.round(skip.forest); out.skip = skip; out.areaSummary = summary; return out;
}
function rvList(rv) {
  if (!rv) return [];
  const filter = S.rvEvidence || 'all', query = (S.rvQuery || '').trim().toLocaleLowerCase();
  const rows = rv.cands.filter(c => (filter === 'all' || filter === 'supported' && ['external_supported', 'observed_bright', 'partial_supported'].includes(c.context.classification) || filter === 'attention' && !['external_supported', 'observed_bright', 'model_lit'].includes(c.context.classification) || filter === 'gap' && c.nolight || filter === 'dark' && ['observed_dark', 'conflict'].includes(c.context.classification)) && (!query || [rvTitle(c), c.dong, c.typeLabel, ...(c.near || []).map(l => l.code)].join(' ').toLocaleLowerCase().includes(query)));
  if (S.rvSort === 'length') rows.sort((a, b) => (b.len || 0) - (a.len || 0) || b.score - a.score);
  else if (S.rvSort === 'name') rows.sort((a, b) => rvTitle(a).localeCompare(rvTitle(b), 'ko') || b.score - a.score);
  return rows;
}
function runLightingReview() {
  S.rvDong = $('#rvDong').value; S.rvKind = $('#rvKind').value; S.rvMinute = DGLighting.parseMinute($('#rvTime').value);
  if (!Number.isInteger(S.rvMinute) || S.rvMinute < 0 || S.rvMinute > 1439) return toast('검토할 한국 시간을 입력해 주세요.');
  if (!DGLighting.state.loaded || DGLighting.state.error) return toast('추가 광원·현장 관찰 자료를 새로고침한 뒤 검토해 주세요.');
  if (globalThis.DGLightingAreas && (!DGLightingAreas.state.loaded || DGLightingAreas.state.error)) return toast('검토 제외 구역을 새로고침한 뒤 검토해 주세요.');
  const mode = S.rvMode || (ROADS ? 'roads' : 'pairs'), button = $('#rvRun'); button.disabled = true; button.textContent = '계산 중…';
  setTimeout(() => {
    try {
      const actualMode = mode === 'roads' && ROADS ? 'roads' : 'pairs', now = Date.now(), cands = actualMode === 'roads' ? roadReview(S.rvDong, S.rvKind) : lightReview(S.rvDong, S.rvKind);
      const transitions = DGLighting.state.records.filter(r => !r.removed).flatMap(r => [r.observedAt, r.observedAt + r.validDays * 86400000]).filter(t => Number.isFinite(t) && t > now);
      for (const c of cands) c.key = rvCandidateKey(c);
      S.rvSelectedKey = ''; S.rvListScroll = 0;
      S.review = { mode: actualMode, dong: S.rvDong, kind: S.rvKind, minute: S.rvMinute, cands, show: 20, at: now, areas: globalThis.DGLightingAreas ? DGLightingAreas.snapshot() : [], areaSummary: cands.areaSummary || rvScopeSummary(), automaticExclusions: cands.skip || {}, inputRevision: S.rvRevision || 0, validUntil: Math.min(Infinity, ...transitions), n: S.lights.filter(l => !l.removed && inDong(l, S.rvDong) && (S.rvKind === '전체' || l.kind === S.rvKind)).length };
      rvExpireAt(S.review.validUntil); S.rvMessage = ''; render();
      if (globalThis.DGLightingWorkflows) DGLightingWorkflows.captureReview(S.review);
    } catch (error) { toast('검토 계산을 완료하지 못했어요: ' + error.message); if (button.isConnected) { button.disabled = false; button.textContent = '검토 실행'; } }
  }, 30);
}
function rvLabel(c) { const q = c.context.coverage; return (q.unit === 'm' && (q.dark > 0 && q.dark < q.total || q.conflict > 0 && q.conflict < q.total) ? '일부 ' : '') + DGLighting.classification(c.context.classification); }
function rvColor(c) { return { conflict: '#9b278e', observed_dark: '#C2372B', observed_bright: '#176d66', external_supported: '#176d66', partial_supported: '#337fa5', data_gap: '#4A5873' }[c.context.classification] || '#b97900'; }
function rvIndex(value) { return Number(value).toFixed(2); }
function rvAdvice(c) {
  return { conflict: '밝음·어두움 관찰이 겹쳐요. 현장을 다시 확인하세요.', observed_dark: '어둡다는 현장 근거가 있어요. 우선 확인하세요.', data_gap: '등록된 광원 자료가 부족해요. 실제로 어두운지는 확인이 필요해요.', model_weak: '대장 모델상 부족해요. 주변의 다른 빛과 현장을 확인하세요.', partial_supported: '일부 구간은 보완됐어요. 남은 구간을 확인하세요.', observed_bright: '이 시간과 관찰 범위에서는 밝음·보통 근거가 있어요.', external_supported: '확인된 외부 광원이 모델을 보완해요.', model_lit: '모델상 기준 이상이에요. 현장 근거도 함께 확인하세요.' }[c.context.classification] || '반영 근거를 확인하세요.';
}
function rvCoverage(c) {
  const q = c.context.coverage;
  if (q.unit !== 'm') return '지점 판단 · 관찰 반경 밖으로 확대하지 않음';
  return '표본 길이 ' + Math.round(q.total) + 'm 중 밝음·보통 ' + Math.round(q.bright) + 'm / 어두움 ' + Math.round(q.dark) + 'm / 관찰 충돌 ' + Math.round(q.conflict) + 'm / 현장 미확인 ' + Math.round(q.unobserved) + 'm · 외부 광원으로 모델 보완 ' + Math.round(q.external) + 'm';
}
function rvEvidenceHTML(c, details = true) {
  const e = c.context;
  return '<p class="rv-advice">' + esc(rvAdvice(c)) + '</p>' + (c.scopeException?.length ? '<p class="notice">제외 구역 안에도 어두움·충돌 관찰이 있어 확인 대상으로 남겼어요.</p>' : '') +
    (details ? '<details><summary>밝기 수치·반영 근거 보기</summary>' : '') +
    '<p><b>대장 모델 ' + rvIndex(e.base) + ' → 외부 광원 반영 ' + rvIndex(e.adjusted) + '</b><span class="muted"> (상대 지수 · lux 아님)</span></p><p class="muted">' + esc(rvCoverage(c)) + '</p>' +
    (c.dark ? '<p class="muted">주변에 고장·수리중 시설이 있어요. 구간 어두움의 원인으로 확정한 것은 아니에요.</p>' : '') +
    (details ?
      (e.sources.length ? e.sources.map(s => '<p>외부 광원: ' + esc(s.label) + ' · ' + esc(s.operator || DGLighting.categories[s.category] || '관리 주체 미확인') + '</p>').join('') : '<p>수치에 반영한 외부 광원이 없어요.</p>') +
      e.observations.map(o => '<p>현장: ' + esc(o.label) + ' · ' + esc(DGLighting.levels[o.level]) + ' · ' + esc(DGLighting.kstTime(o.observedAt)) + ' · 반경 ' + esc(o.radius) + 'm' + (o.lux != null ? ' · 실측 ' + esc(o.lux) + ' lux (' + esc(o.instrument) + ')' : '') + '</p>').join('') +
      e.hints.map(h => '<p>확인 필요: ' + esc(h.label) + ' · ' + esc(DGLighting.reason(h.reason)) + '</p>').join('') +
      '<p class="muted">반영되지 않은 기관 조명·건물 빛·가림·눈부심·임시 조명이 있을 수 있어요. 기록이 없다는 사실은 실제 어두움의 증거가 아니에요.</p></details>' : '');
}
function rvTitle(c) { return c.a ? c.a.code + ' ↔ ' + c.b.code : c.name; }
function rvButtons(c, i) {
  const point = ' data-lat="' + c.mid.lat + '" data-lng="' + c.mid.lng + '"';
  return '<div class="split rv-actions"><button class="btn sm" data-rvmap="' + i + '">지도 확인</button><button class="btn ghost sm" data-lc="new-observation"' + point + '>현장 밝기 기록</button>' + (globalThis.DGLightingAreas && can('admin') ? '<button class="btn ghost sm" data-la="candidate" data-candidate="' + i + '">이 주변 검토 제외</button>' : '') + (globalThis.DGLightingWorkflows ? '<button class="btn ghost sm" data-lw="candidate-task" data-candidate="' + i + '">재확인 업무로</button>' : '') + '</div><details class="rv-extra"><summary>광원 보완·시설 등록</summary><div class="split"><button class="btn ghost sm" data-lc="new-source"' + point + '>다른 기관·외부 광원 기록</button><button class="btn ghost sm" data-rvreg="' + i + '">관리 시설 등록 양식</button></div></details>';
}
function rvAreaSummaryHTML(rv) {
  const summary = rv.areaSummary || {}, records = rv.areas || [], active = records.filter(r => !r.disabled);
  return '<div class="rv-scope-summary"><p>지정 구역 적용: 제외 ' + active.filter(r => r.effect === 'exclude').length + '개 · 보행로 등 예외 ' + active.filter(r => r.effect === 'include').length + '개' + (rv.mode === 'roads' ? ' · 제외한 도로 ' + Math.round(summary.manualMeters || 0) + 'm · 예외로 포함 ' + Math.round(summary.includedMeters || 0) + 'm' : ' · 제외한 간격 후보 ' + (summary.manualPoints || 0) + '곳') + '</p><button class="btn ghost sm" data-asec="lightingareas">제외 범위 확인·수정</button></div>';
}
function reviewSection() {
  const rv = rvFresh(), mode = S.rvMode || (ROADS ? 'roads' : 'pairs'), cs = rvList(rv), sk = rv?.cands.skip || {};
  const active = DGLighting.state.records.filter(r => !r.removed);
  return '<div class="panel"><h3>밝기 검토 · 주변 광원과 현장 근거</h3><p>대장에 표시되지 않은 등이나 건물 빛 때문에 실제로는 밝을 수 있어요. <b>대장 모델·외부 광원·현장 관찰</b>을 함께 확인하세요.</p>' +
    (globalThis.DGLightingWorkflows ? DGLightingWorkflows.reviewHistoryStatus(rv) : '') +
    '<div class="split"><button class="btn ghost sm" data-asec="lightingcontext">외부 광원·관찰 관리 (' + active.length + ')</button><button class="btn ghost sm" data-asec="lightingareas">산·숲 등 검토 제외 구역</button><button class="btn ghost sm" data-lc="new-observation">현장 밝기 기록</button></div>' +
    (DGLighting.state.error ? '<p class="notice">' + esc(DGLighting.state.error) + ' <button class="btn ghost sm" data-lc="reload">자료 다시 읽기</button></p>' : '') +
    (globalThis.DGLightingAreas?.state.error ? '<p class="notice">검토 구역을 읽지 못했어요: ' + esc(DGLightingAreas.state.error) + ' <button class="btn ghost sm" data-la="reload">구역 다시 읽기</button></p>' : '') +
    '<details class="help"><summary>계산과 한계</summary><p>대장 시설의 간격·종류·상태로 상대 지수를 계산해요. 0.30 미만 지점 또는 도로의 24m 이상 구간은 모델상 부족 후보로 남겨요. 외부 광원은 확인된 반경·점등 시간·재확인 기한 안에서 보완하고, 대장 시설과 중복되거나 야간·시간 정보가 불명확한 자료는 확인 대상으로 표시해요. 반경과 영향 정도는 모델 가정이에요.</p><p>현장 밝기와 조도계 lux는 별도 근거로 표시하며 모델에 더하지 않아요. 모델상 밝아도 현장 어두움 관찰이 있으면 검토 대상으로 남아요. 도로는 8m 이하 조각을 광원·관찰 반경의 경계에서 다시 나누어 집계해요. 표시 길이는 좌표와 입력 반경에 따른 근사치예요. 아파트·학교·숲·사유지 길은 도로 검토에서 제외하지만 현장 어두움 지점은 별도로 표시해요. 상대 지수는 밝기 백분율·실측 조도·법정 기준 충족률이 아니며 조명 설치 결정을 대신하지 않아요.</p></details>' +
    '<div class="seg"><button data-rvmode="roads" aria-pressed="' + (mode === 'roads') + '" ' + (ROADS ? '' : 'disabled') + '>도로 따라 검토</button><button data-rvmode="pairs" aria-pressed="' + (mode === 'pairs') + '">등 간격으로 검토</button></div>' +
    '<div class="split">' + (ROADS ? '<span class="muted">도로 ' + ROADS.ways.length.toLocaleString() + '개 · © OpenStreetMap contributors</span>' : '') + (!ROADS || can('admin') ? '<button class="btn ghost sm" id="rvRoads"' + (ROADS ? ' data-refetch="1"' : '') + '>' + (ROADS ? '도로망 다시 받기' : '도로망 불러오기') + '</button>' : '') + '<span class="muted" id="rvRoadsStat">' + esc(S.rvRoadsStat || '') + '</span></div>' +
    '<div class="grid2"><div><label class="f" for="rvDong">검토 지역</label><select class="f-in" id="rvDong">' + dongOptions(S.rvDong || '전체', '모든 동') + '</select></div><div><label class="f" for="rvKind">관리 시설 종류</label><select class="f-in" id="rvKind">' + ['전체', ...KINDS].map(k => '<option' + (k === (S.rvKind || '전체') ? ' selected' : '') + '>' + esc(k) + '</option>').join('') + '</select></div></div>' +
    '<label class="f" for="rvTime">검토할 야간 시간 (한국 시간 · KST)</label><input class="f-in" id="rvTime" type="time" value="' + DGLighting.minuteText(S.rvMinute ?? 1260) + '"><p class="muted">예: 21:00의 상가 빛과 02:00의 폐점 후 상황을 각각 검토할 수 있어요. 관찰의 최근성은 현재 날짜를 기준으로 확인해요.</p><button class="btn block" id="rvRun">검토 실행</button>' +
    (S.rvMessage ? '<p class="notice" role="status">' + esc(S.rvMessage) + '</p>' : '') +
    (rv ? '<p class="muted">' + esc(dongLabel(rv.dong)) + ' · ' + DGLighting.minuteText(rv.minute) + ' KST · 관리 대장 ' + rv.n.toLocaleString() + '개 · 검토 ' + esc(DGLighting.kstTime(rv.at)) + '</p>' + rvAreaSummaryHTML(rv) + '<div class="rv-toolbar"><div class="grid2"><div><label class="f" for="rvEvidence">근거별 보기</label><select class="f-in" id="rvEvidence">' + Object.entries({ all: '전체 후보 · 보완된 곳도 유지', attention: '우선 현장 확인', dark: '현장 어두움·관찰 충돌', supported: '외부 광원·밝음 관찰로 보완', gap: '90m 안 등록 광원 자료 부족' }).map(([v, t]) => '<option value="' + v + '"' + (v === (S.rvEvidence || 'all') ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div><div><label class="f" for="rvSort">정렬</label><select class="f-in" id="rvSort">' + Object.entries({ priority: '확인 우선순위', length: '긴 도로 구간부터', name: '장소 이름순' }).map(([v, t]) => '<option value="' + v + '"' + (v === (S.rvSort || 'priority') ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div></div><label class="f" for="rvQuery">장소·동·주변 시설 검색</label><input class="f-in" type="search" id="rvQuery" value="' + esc(S.rvQuery || '') + '" placeholder="도로 이름이나 주변 표찰 번호"><div class="split"><strong role="status">표시 ' + cs.length + '곳 / 전체 ' + rv.cands.length + '곳' + (rv.mode === 'roads' ? ' · ' + (cs.reduce((s, c) => s + (c.len || 0), 0) / 1000).toFixed(2) + 'km' : '') + '</strong><button class="btn ghost sm" data-rvclear>보기 초기화</button></div>' + (cs.length ? '<div class="split"><button class="btn sm" data-rvmap="all">표시 후보 지도</button><button class="btn ghost sm" id="csv4">현재 보기 CSV</button></div>' : '') + '</div>' +
      (sk.ways || sk.apt || sk.forest ? '<p class="muted">제외: 사유지·주차장 통로 ' + (sk.ways || 0) + '개 · 단지 ' + (sk.apt || 0) + 'm · 산·숲 ' + (sk.forest || 0) + 'm</p>' : '') +
      (cs.length ? cs.slice(0, rv.show).map((c, i) => '<article tabindex="-1" class="panel rv-candidate' + (c.key === S.rvSelectedKey ? ' rv-selected' : '') + '" data-rvkey="' + esc(c.key || rvCandidateKey(c)) + '" style="border-left:5px solid ' + rvColor(c) + '"><div class="split"><b>#' + (i + 1) + ' ' + esc(rvTitle(c)) + '</b><span class="chip">' + esc(rvLabel(c)) + '</span></div><p class="muted">' + esc(c.dong || '지역 확인 필요') + ' · ' + (c.point ? '현장 관찰 지점' : c.len != null ? esc(c.typeLabel) + ' · ' + c.len + 'm' : '시설 간격 ' + c.d + 'm · 대장 기준 간격 ' + c.need + 'm') + (c.nolight ? ' · 90m 안 등록 광원 자료 부족' : '') + '</p>' + rvEvidenceHTML(c) + rvButtons(c, i) + '</article>').join('') : '<p class="empty">현재 자료와 조건에서 표시할 후보가 없어요.' + (rv.cands.length ? ' 검색어나 근거별 보기 조건을 바꿔 보세요.' : ' 제외 범위도 확인해 주세요. 실제로 모두 밝다는 뜻은 아니에요.') + '</p>') +
      (cs.length > rv.show ? '<button class="btn ghost block" id="rvMore">더 보기 · ' + (cs.length - rv.show) + '곳 남음</button>' : '') : '') + '</div>';
}
async function exportReviewCSV() {
  const rv = rvFresh(); if (!rv) return toast(S.rvMessage || '먼저 검토를 실행해 주세요.');
  const rows = [['순위', '구분', '동', '장소', '유형', '길이m_지점은빈칸', '대장상대지수_lux아님', '외부반영상대지수_lux아님', '검토시각_KST', '자료기준시각_KST', '밝음보통관찰m', '어두움관찰m', '충돌관찰m', '현장미확인m', '외부보완m', '외부광원', '관찰기록', '실측lux_모델에합산안함', '확인할자료', '제외구역_현장근거유지', '위도', '경도'], ...rvList(rv).map((c, i) => {
    const e = c.context, q = e.coverage, meters = value => q.unit === 'm' ? Math.round(value) : '';
    return [i + 1, rvLabel(c), c.dong, rvTitle(c), c.point ? '관찰 지점' : c.len != null ? '도로 구간' : '등 사이 중간 지점', c.len ?? '', rvIndex(e.base), rvIndex(e.adjusted), DGLighting.minuteText(rv.minute), DGLighting.kstTime(rv.at), meters(q.bright), meters(q.dark), meters(q.conflict), meters(q.unobserved), meters(q.external), e.sources.map(s => s.label + ' (' + (s.operator || '관리 미확인') + ')').join(' / '), e.observations.map(o => o.label + ': ' + DGLighting.levels[o.level] + ', ' + DGLighting.kstTime(o.observedAt) + ', 반경 ' + o.radius + 'm').join(' / '), e.observations.filter(o => o.lux != null).map(o => o.lux + ' lux / ' + o.instrument).join(' ; '), e.hints.map(h => h.label + ': ' + DGLighting.reason(h.reason)).join(' / '), (c.scopeException || []).map(id => id === 'automatic' ? '자동 제외 영역의 어두움·충돌 근거' : ((rv.areas || []).find(a => a.id === id)?.label || id) + ' · 어두움·충돌 근거 유지').join(' / '), c.mid.lat.toFixed(6), c.mid.lng.toFixed(6)];
  })];
  const csv = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  try { if (dl) await dl.save({ filename: '동구가로등_밝기검토_' + fmtD(Date.now()).replace(/\./g, '') + '.csv', data: csv }); else toast('내려받기 기능을 준비하지 못했어요.'); } catch (e) { if (!['cancelled', 'declined'].includes(e.code)) toast('CSV를 내려받지 못했어요.'); }
}
function cleanupLightingReviewMap() {
  if (gmap) {
    meStop(); if (gmap.stop) gmap.stop();
    // Remove paths while their renderer still has its drawing context. Removing
    // the map first can let later path removal queue a redraw on a dead canvas.
    if (gmapLayer?.clearLayers) gmapLayer.clearLayers();
    if (gmap.eachLayer && globalThis.L?.Path) gmap.eachLayer(layer => { if (layer instanceof L.Path) gmap.removeLayer(layer); });
    gmap.remove(); gmap = null; gmapLayer = null; gmapMe = null; gmapPts = [];
  }
}
function rememberLightingReviewCandidate(index) {
  const rv = rvFresh(), c = rv && rvList(rv)[Number(index)];
  if (!c) return;
  S.rvSelectedKey = c.key || rvCandidateKey(c); S.rvMapEntryKey = S.rvSelectedKey;
  if ($('#asecBody')) S.rvListScroll = $('#sheet').scrollTop;
}
function returnLightingReview() {
  const rv = rvFresh();
  cleanupLightingReviewMap();
  if (rv) {
    const selected = rvList(rv).findIndex(c => (c.key || rvCandidateKey(c)) === S.rvSelectedKey);
    if (selected >= 0) rv.show = Math.max(rv.show, Math.ceil((selected + 1) / 20) * 20);
  }
  S.tab = 'admin'; openAdminSection('light');
  const body = $('#asecBody');
  requestAnimationFrame(() => {
    if (body !== $('#asecBody') || !$('#sheet').classList.contains('open')) return;
    const selected = [...body.querySelectorAll('[data-rvkey]')].find(el => el.dataset.rvkey === S.rvSelectedKey);
    $('#sheet').scrollTop = S.rvListScroll || 0;
    if (selected) { selected.focus({ preventScroll: true }); if (S.rvMapEntryKey !== S.rvSelectedKey) selected.scrollIntoView({ block: 'center' }); }
  });
}
function openReviewMap(idx, pageIndex) {
  const rv = rvFresh(); if (!rv) return toast(S.rvMessage || '먼저 검토를 실행해 주세요.');
  const all = rvList(rv), multi = idx === 'all', previousMap = !!$('#rvMapSummary');
  if (!all.length) return toast('현재 보기의 후보가 없어요.');
  if (!previousMap && $('#asecBody')) { S.rvListScroll = $('#sheet').scrollTop; S.rvMapEntryKey = idx === 'all' ? '' : all[Number(idx)]?.key; }
  const page = multi ? Math.max(0, Math.min(Math.ceil(all.length / 200) - 1, Number.isInteger(pageIndex) ? pageIndex : 0)) : 0;
  const selectedIndex = multi ? -1 : Number(idx), cs = multi ? all.slice(page * 200, (page + 1) * 200) : [all[selectedIndex]];
  if (!cs[0]) return toast('후보 목록이 바뀌었어요. 목록에서 다시 선택하세요.');
  if (!multi) S.rvSelectedKey = cs[0].key || rvCandidateKey(cs[0]);
  const center = multi ? null : cs[0].mid;
  const nav = multi ? '<button class="btn ghost sm" data-rvpage="' + (page - 1) + '"' + (page === 0 ? ' disabled' : '') + '>이전 200곳</button><span>' + (page * 200 + 1) + '–' + Math.min(all.length, (page + 1) * 200) + ' / ' + all.length + '곳</span><button class="btn ghost sm" data-rvpage="' + (page + 1) + '"' + ((page + 1) * 200 >= all.length ? ' disabled' : '') + '>다음 200곳</button>' : '<button class="btn ghost sm" data-rvmap="' + (selectedIndex - 1) + '"' + (selectedIndex === 0 ? ' disabled' : '') + '>이전 후보</button><span>' + (selectedIndex + 1) + ' / ' + all.length + '곳</span><button class="btn ghost sm" data-rvmap="' + (selectedIndex + 1) + '"' + (selectedIndex === all.length - 1 ? ' disabled' : '') + '>다음 후보</button>';
  cleanupLightingReviewMap();
  S.asec = null;
  // one level for the whole map: candidate previous/next and page moves replace it, back returns to the list
  if (typeof navRoute === 'function') navRoute('rvmap', () => openReviewMap(idx, pageIndex), { back: () => returnLightingReview() });
  openSheet('<div class="sheet-head"><div id="rvMapSummary"><h3>' + (multi ? '밝기 검토 지도' : esc(rvTitle(cs[0]))) + '</h3><p>' + DGLighting.minuteText(rv.minute) + ' KST · ' + (multi ? '현재 보기 전체 ' + all.length + '곳' : esc(rvLabel(cs[0]))) + '</p></div><button class="x" data-close aria-label="닫기">×</button></div><div class="rv-map-nav"><button class="btn sm" data-rvback>검토 목록으로</button><div class="split">' + nav + '</div></div><div class="gmap rv-map" id="gmap"><button class="btn sm locbtn" id="mapLoc" aria-pressed="false">내 위치</button></div><div class="maplegend">회색: 검토 제외 · 초록 경계: 예외 포함 · 파랑 점선: 관찰 범위 · <span id="mapNote"></span></div><p class="muted">제외 구역은 조명 검토 범위 설정이에요. 구역 안의 어두움·충돌 관찰은 계속 표시해요.</p>' + (!multi ? '<article class="panel" id="rvMapCandidate">' + rvEvidenceHTML(cs[0]) + rvButtons(cs[0], selectedIndex) + '</article>' : '') + '<button class="btn ghost block" data-asec="lightingareas">검토 제외 구역 확인·수정</button>');
  if (!window.L) { $('#mapNote').textContent = '지도를 불러오지 못했어요. 목록과 근거는 확인할 수 있어요.'; return; }
  // Candidate navigation replaces the map rapidly. SVG paths have no queued
  // canvas redraw that can outlive the renderer during these replacements.
  gmap = L.map('gmap', { preferCanvas: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }); const ownerMap = gmap;
  DongguPWA.tileLayer(L).addTo(gmap); gmapLayer = L.layerGroup().addTo(gmap); gmapPts = []; meStop();
  if (rv.mode === 'roads') for (const area of ROADS?.areas || []) {
    L.polygon([area.pts, ...(area.holes || [])], { color: '#89919a', weight: 1, dashArray: '3 6', fillOpacity: .08 }).bindPopup('<b>자동 제외 · ' + esc(area.name || (area.t === 'forest' ? '산·숲' : '단지 내부')) + '</b><p>도로 자료의 영역을 기준으로 제외해요. 실제 보행로는 별도 예외 포함 구역으로 지정할 수 있어요.</p><button class="btn ghost sm" data-asec="lightingareas">검토 구역 관리</button>').addTo(gmapLayer);
  }
  for (const area of rv.areas || []) {
    if (area.disabled) continue;
    const options = { color: area.effect === 'include' ? '#168174' : '#5f6670', weight: 2, dashArray: area.effect === 'include' ? '7 4' : null, fillColor: '#69737f', fillOpacity: area.effect === 'include' ? .03 : .16 };
    const layer = area.shape === 'circle' ? L.circle([area.lat, area.lng], { ...options, radius: area.radius }) : L.polygon(area.vertices.map(p => [p.lat, p.lng]), options);
    layer.bindPopup('<b>' + esc(area.label) + '</b><p>' + esc(DGLightingAreaCore.effects[area.effect]) + ' · ' + esc(DGLightingAreaCore.reasons[area.reason]) + '</p><button class="btn ghost sm" data-la="edit" data-id="' + esc(area.id) + '">구역 확인·수정</button>').addTo(gmapLayer);
  }
  const pts = S.lights.filter(l => !l.removed && Number.isFinite(l.lat) && Number.isFinite(l.lng) && (center ? distM(center, l) <= Math.max(180, cs[0].len || 0) : inDong(l, rv.dong)));
  for (const l of pts) L.circle([l.lat, l.lng], { radius: reachOf(l), color: onOf(l) ? '#9b7500' : '#C2372B', weight: 1, fillColor: '#F5C542', fillOpacity: onOf(l) ? .16 : .03 }).bindPopup(esc(l.code) + ' · ' + esc(l.status) + '<br>대장 모델 반경 ' + reachOf(l) + 'm<br><button class="btn sm" data-map-open="' + esc(l.id) + '">시설 열기</button>').addTo(gmapLayer);
  for (const record of DGLighting.state.records) {
    if (record.removed || !Number.isFinite(record.lat) || !Number.isFinite(record.lng) || Math.abs(record.lat) > 90 || Math.abs(record.lng) > 180 || !Number.isFinite(record.radius) || record.radius < 5 || record.radius > 80 || center && distM(center, record) > Math.max(200, cs[0].len || 0)) continue;
    const source = record.kind === 'source';
    L.circle([record.lat, record.lng], { radius: record.radius, color: source ? '#168174' : '#2466ba', dashArray: '4 5', weight: 2, fillOpacity: .04 }).bindPopup('<b>' + esc(record.label) + '</b><br>' + esc(DGLighting.recordSummary(record)) + '<br>' + esc(DGLighting.kstTime(record.observedAt)) + '<br>입력한 범위이며, 수치 반영 여부는 후보의 근거를 확인하세요.<br><button class="btn sm" data-lc="edit" data-id="' + esc(record.id) + '">기록 보기</button>').addTo(gmapLayer);
  }
  cs.forEach((c, i) => {
    const index = multi ? page * 200 + i : selectedIndex;
    if (c.pts) L.polyline(c.pts.map(p => [p.lat, p.lng]), { color: rvColor(c), weight: 7, opacity: .8 }).addTo(gmapLayer);
    else if (c.a) L.polyline([[c.a.lat, c.a.lng], [c.b.lat, c.b.lng]], { color: rvColor(c), weight: 3, dashArray: '6 5' }).addTo(gmapLayer);
    L.circleMarker([c.mid.lat, c.mid.lng], { radius: 8, color: rvColor(c), fillOpacity: .9 }).bindPopup('<b>#' + (index + 1) + ' ' + esc(rvTitle(c)) + '</b><p>' + esc(rvLabel(c)) + (c.len ? ' · ' + c.len + 'm' : '') + '</p><p>' + esc(rvAdvice(c)) + '</p><button class="btn sm" data-rvmap="' + index + '">이 후보 자세히 확인</button>').addTo(gmapLayer);
  });
  const backView = typeof NAV !== 'undefined' ? NAV.mapView : null; if (typeof NAV !== 'undefined') NAV.mapView = null;
  if (backView && backView.center) gmap.setView(backView.center, backView.zoom); // back from a screen opened on this map
  else if (center && !cs[0].pts) gmap.setView([center.lat, center.lng], 18);
  else gmap.fitBounds(L.latLngBounds(cs.flatMap(c => c.pts || [c.mid]).map(p => [p.lat, p.lng])).pad(.15), { maxZoom: multi ? 17 : 18 });
  setTimeout(() => { if (gmap === ownerMap) ownerMap.invalidateSize(); }, 250);
}
function reviewToForm(idx) {
  const rv = rvFresh(), c = rv && rvList(rv)[+idx]; if (!c) return toast(S.rvMessage || '먼저 검토를 실행해 주세요.');
  closeSheet(true); S.tab = 'admin'; render(); openAdminSection('reg'); const dong = $('#nDong'); if (!dong) return toast('시설 등록 권한이 없어요.');
  $('#nNoPlate').checked = true; for (const id of ['nNum', 'nRoad']) if ($('#' + id)) $('#' + id).disabled = true;
  $('#nKind').value = c.a?.kind || c.near?.[0]?.kind || '보안등'; if (DONGS.includes(c.dong)) dong.value = c.dong;
  $('#nAddr').value = rvTitle(c) + ' 검토 지점';
  $('#nNote').value = '현장 확인용: ' + rvLabel(c) + ', 대장 모델 ' + rvIndex(c.context.base) + ' → 외부 반영 ' + rvIndex(c.context.adjusted) + ' (lux 아님), ' + DGLighting.minuteText(rv.minute) + ' KST. 실제 시설·관리기관 확인 후 등록. 신설 필요 판정 아님.';
  $('#nLat').value = c.mid.lat.toFixed(6); $('#nLng').value = c.mid.lng.toFixed(6); toast('좌표와 검토 근거를 넣었어요. 실제 관리 시설이 있는지 확인 후 등록하세요.');
}
