(function (root) {
  'use strict';
  /* in-app confirmation when app/dialog.js is present; the plain confirm() keeps bare test sandboxes working */
  const ask = (message, opts) => root.DGDialog ? root.DGDialog.confirm(message, opts) : Promise.resolve(confirm(message));
  const C = root.DGOperationsCore;
  let api, attached = false, loading = null, registryLoad = 0;
  let inventoryRequest = 0, inventoryEditRequest = 0, inventoryWrites = Promise.resolve();
  const inventoryDrafts = new Map();
  const today = new Date(), localDate = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const state = { from: localDate(new Date(today.getFullYear(), today.getMonth(), 1)), to: localDate(today), analytics: null, loadedRange: '', error: '', at: 0, registry: null, source: '', registryError: '', registryProgress: '', dashboardSource: 'unknown', dashboardComplete: false, audit: [], auditLoaded: false, auditLoading: false, auditAttempted: false, auditError: '', auditCursor: null, auditMore: false, auditAt: 0, health: null, healthLoading: false, healthAttempted: false, healthError: '' };
  Object.assign(state, { inventoryOwner: '', inventoryForecast: null, inventoryForecastOrders: {}, inventoryForecastLoading: false, inventoryForecastAttempted: false, inventoryForecastError: '', inventoryForecastSource: 'unknown', inventoryForecastComplete: false, inventoryForecastAt: 0 });
  const E = v => api.esc(v), Q = s => document.querySelector(s), notify = () => api.render();
  const heading = (title, sub) => '<div class="sheet-head"><div><h3>' + E(title) + '</h3><p class="muted">' + E(sub || '') + '</p></div><button class="x" data-close aria-label="닫기">×</button></div>';
  const bounds = () => ({ from: new Date(state.from + 'T00:00:00').getTime(), to: new Date(state.to + 'T23:59:59.999').getTime() });
  function supported() { return api.state().me === 'local' || !!api.firebase(); }
  const sourceLabel = source => ({ server: '서버에서 전체 조회', local: '이 기기 저장 자료', cache: '오프라인 보관 자료 · 전체 자료가 아닐 수 있음', mixed: '서버·기기 보관 자료 혼합 · 일부 자료일 수 있음', artifact: '공유 저장소 조회 · 서버의 전체 범위 보증 없음', unknown: '자료 출처 확인 필요' }[source] || '자료 출처 확인 필요');
  const dashboardReady = () => !!state.analytics && !loading && !state.error && state.loadedRange === state.from + '/' + state.to;
  function requireDashboard() { if (!dashboardReady()) throw new Error('선택한 기간을 다시 조회한 뒤 내보내 주세요.'); }
  async function loadDashboard() {
    if (loading) return loading;
    const range = state.from + '/' + state.to, b = bounds();
    if (!Number.isFinite(b.from) || !Number.isFinite(b.to) || b.from > b.to) { state.error = '시작일과 종료일을 확인해 주세요.'; notify(); return; }
    state.error = '';
    loading = (async () => {
      try {
        const metadata = [], request = { requireServer: !!api.firebase() && navigator.onLine !== false, onMetadata: value => metadata.push(value) };
        const [inspections, orders, reports, events] = await Promise.all([
          api.readAll('inspections', { ...request, where: [['date', '>=', b.from], ['date', '<=', b.to]], orderBy: [['date', 'desc']] }),
          api.readAll('workOrders', request), api.readAll('reports', request),
          api.readAll('workEvents', { ...request, where: [['at', '>=', b.from], ['at', '<=', b.to]], orderBy: [['at', 'desc']] })
        ]);
        state.analytics = C.analytics(inspections, orders, reports, api.state().lights, b.from, b.to, events);
        const sources = [...new Set(metadata.map(value => value.source))];
        state.dashboardSource = sources.length === 1 ? sources[0] : sources.length > 1 ? 'mixed' : api.state().me === 'local' ? 'local' : request.requireServer ? 'server' : api.firebase() ? 'cache' : 'unknown';
        state.dashboardComplete = metadata.length ? metadata.every(value => value.complete) : ['local', 'server'].includes(state.dashboardSource);
        state.loadedRange = range; state.at = Date.now();
      } catch (error) { state.error = error.message || '기간 자료를 불러오지 못했어요.'; }
      finally { loading = null; notify(); }
    })();
    return loading;
  }
  function dashboard() {
    if (!state.analytics && !loading && !state.error) setTimeout(loadDashboard, 0);
    const a = state.analytics, stale = state.loadedRange !== state.from + '/' + state.to;
    const metrics = a ? [['기간 점검', a.inspectionCount + '건'], ['점검한 시설', a.uniqueInspected + '개'], ['기간 작업 접수', a.opened + '건'], ['기간 검수 완료 횟수', a.verified + '건'], ['현재 미완료 작업', a.unresolved + '건'], ['현재 기한 초과', a.overdue + '건'], ['현재 미처리 신고', a.pendingReports + '건'], ['검수까지 평균 소요일', a.averageDays == null ? '자료 없음' : a.averageDays.toFixed(1) + '일'], ['기간 자재비 증감', a.cost.toLocaleString() + '원']] : [];
    return '<div class="panel"><div class="grid2"><div><label class="f" for="dgDashFrom">시작일</label><input class="f-in" id="dgDashFrom" type="date" value="' + state.from + '"></div><div><label class="f" for="dgDashTo">종료일</label><input class="f-in" id="dgDashTo" type="date" value="' + state.to + '"></div></div><div class="split"><button class="btn sodium" data-mgmt="dashboard-load"' + (loading ? ' disabled' : '') + '>기간 조회</button><button class="btn ghost" data-mgmt="dashboard-csv"' + (!dashboardReady() ? ' disabled' : '') + '>CSV</button><button class="btn ghost" data-mgmt="dashboard-print"' + (!dashboardReady() ? ' disabled' : '') + '>인쇄 / PDF</button></div><p class="muted">기간 자료를 끝까지 조회해 집계해요. 미완료·기한 초과·미처리 신고는 조회 시점 기준이에요. 검수 실적은 변경 불가 이력으로 집계하며, 재검수 자재비는 이전 검수와의 차이(반납은 음수)만 반영해요.</p></div>' +
      (state.error ? '<div class="notice" role="alert">' + E(state.error) + '</div>' : '') + (loading ? '<p role="status">기간 전체 자료를 불러오는 중…</p>' : '') +
      (a ? '<div id="dgDashboardReport"><h3>' + E(state.loadedRange.replace('/', ' ~ ')) + ' 업무 현황</h3><p class="muted">조회 ' + api.fmtDT(state.at) + ' · ' + E(sourceLabel(state.dashboardSource)) + (state.dashboardComplete ? '' : ' · 참고용 집계') + (stale ? ' · 날짜가 바뀌었어요. 다시 조회해 주세요.' : '') + '</p><div class="dg-metrics">' + metrics.map(([name, value]) => '<div class="panel"><span>' + E(name) + '</span><strong>' + E(value) + '</strong></div>').join('') + '</div><h3>반복 고장 시설</h3><p class="muted">선택 기간에 고장 점검이 두 번 이상 기록된 시설이에요. 원인 확인과 교체 검토 후보로 사용해요.</p>' + (a.repeated.length ? '<div class="list">' + a.repeated.map(([id, n]) => '<button class="light-row" data-light="' + E(id) + '"><b>' + E((api.byId(id) || {}).code || id) + '</b><span>' + n + '회</span></button>').join('') + '</div>' : '<p class="empty">반복 고장 기록이 없어요.</p>') + '<h3>점멸기·회로별 고장 기록</h3><div class="dg-table"><table><thead><tr><th>대장 점멸기</th><th>고장 점검</th></tr></thead><tbody>' + a.circuits.map(([id, n]) => '<tr><td>' + E(id) + '</td><td>' + n + '회</td></tr>').join('') + '</tbody></table></div><p class="muted">대장의 점멸기 값으로 묶은 통계예요. 실제 전기 회로 연결은 현장에서 확인해 주세요.</p></div>' : '');
  }
  function dashboardRows() {
    requireDashboard(); const a = state.analytics;
    return [['기간', state.loadedRange], ['조회 시각', api.fmtDT(state.at)], ['자료 출처', sourceLabel(state.dashboardSource)], ['조회 범위', state.dashboardComplete ? '전체 조회' : '참고용 · 누락된 자료가 있을 수 있음'], ['지표', '값'], ['기간 점검', a.inspectionCount], ['점검 시설', a.uniqueInspected], ['기간 작업 접수', a.opened], ['기간 검수 완료 횟수', a.verified], ['현재 미완료', a.unresolved], ['현재 기한 초과', a.overdue], ['현재 미처리 신고', a.pendingReports], ['평균 완료 일수', a.averageDays == null ? '' : a.averageDays.toFixed(2)], ['기간 자재비 증감', a.cost], [], ['반복 고장 시설', '횟수'], ...a.repeated.map(([id, n]) => [(api.byId(id) || {}).code || id, n]), [], ['점멸기', '고장 점검'], ...a.circuits];
  }
  function registryView() {
    const diff = state.registry;
    return '<div class="panel"><p>새 대장 JSON을 비교한 뒤 적용해요. 시설 ID는 유지되며 점검·사진·신고·보수 이력은 같은 ID에 연결돼요.</p><label class="f" for="dgRegistryFile">새 대장 JSON</label><input id="dgRegistryFile" type="file" accept="application/json,.json"><p class="muted">cols/rows 형식 또는 시설 배열 · 최대 30MB. 원본 getPoint.json은 저장소의 대장 변환 스크립트로 변환해 주세요.</p>' + (!supported() ? '<p class="notice">안전한 갱신은 이 기기 저장 또는 Firebase 공유 저장에서 지원해요.</p>' : '') + '</div>' +
      (state.registryError ? '<div class="notice" role="alert">' + E(state.registryError) + '</div>' : '') +
      (diff ? '<div class="panel"><h3>' + E(state.source) + '</h3><p>신규 ' + diff.added.length + '개 · 변경 ' + diff.changed.length + '개 · 새 대장에서 빠짐 ' + diff.missing.length + '개 · 동일 ' + diff.unchanged + '개</p><label class="dg-option"><input id="dgKeepOverrides" type="checkbox" checked> 현장에서 수정한 값은 유지</label><label class="dg-option"><input id="dgRemoveMissing" type="checkbox"> 새 대장에 빠진 시설은 철거 표시</label><p class="muted">기본값은 누락 시설 유지예요. 현장 수정 보존을 끄면 아래 충돌 필드에도 새 대장 값을 적용해요. 표찰 변경 전 번호는 검색 별칭으로 남겨요.</p><button class="btn sodium" data-mgmt="registry-apply"' + (!supported() ? ' disabled' : '') + '>검토한 변경 적용</button><p id="dgRegistryProgress" role="status">' + E(state.registryProgress) + '</p></div><div class="dg-table"><table><thead><tr><th>시설</th><th>구분</th><th>변경 필드 / 충돌</th></tr></thead><tbody>' + [...diff.added.slice(0, 40).map(r => '<tr><td>' + E(r.code) + '</td><td>신규</td><td>' + E(r.id) + '</td></tr>'), ...diff.changed.slice(0, 160).map(r => '<tr><td>' + E(r.code) + '</td><td>변경</td><td>' + E(Object.keys(r.changes).join(', ')) + (r.conflicts.length ? '<strong class="dg-conflict">현장 수정: ' + E(r.conflicts.join(', ')) + '</strong>' : '') + '</td></tr>'), ...diff.missing.slice(0, 40).map(r => '<tr><td>' + E(r.code) + '</td><td>새 대장에서 빠짐</td><td>기본값: 유지</td></tr>')].join('') + '</tbody></table></div><p class="muted">화면에는 신규·누락 각각 40개, 변경 160개까지 표시해요. 전체 비교 내역을 CSV로 확인할 수 있어요.</p><button class="btn ghost" data-mgmt="registry-csv">전체 비교 CSV</button>' : '');
  }
  async function registryFile(file) {
    const token = ++registryLoad;
    state.registryError = ''; state.registry = null; state.registryProgress = '';
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error('대장 파일은 30MB 이하로 선택해 주세요.');
      const values = C.normalizeRegistry(JSON.parse(await file.text()));
      if (token !== registryLoad) return;
      const base = api.registry(), known = new Set(base.map(l => l.id));
      const prior = [...base, ...(api.state().allLights || api.state().lights).filter(l => !known.has(l.id) && l.registryJobId)];
      state.registry = C.registryDiff(prior, values, api.overrides()); state.source = file.name;
    } catch (error) { if (token !== registryLoad) return; state.registryError = error.message || '대장 형식을 확인해 주세요.'; }
    const input = Q('#dgRegistryFile'); if (input) input.value = '';
    notify();
  }
  async function applyRegistry(button) {
    if (!api.can('admin') || !supported() || !state.registry) return;
    const keep = Q('#dgKeepOverrides').checked, removeMissing = Q('#dgRemoveMissing').checked, diff = state.registry;
    const entries = [], overrides = api.overrides(), snapshot = v => JSON.parse(JSON.stringify(v));
    for (const row of diff.added) entries.push({ id: row.id, added: true, before: {}, patch: { ...row, status: '정상', lastInspected: null }, registryValues: row });
    for (const row of diff.changed) {
      const patch = {}, current = row.overrideBefore || {}, before = { registryJobId: current.registryJobId || null };
      for (const [field, value] of Object.entries(row.changes)) {
        if (keep && row.conflicts.includes(field)) continue;
        if (JSON.stringify(current[field] == null ? null : current[field]) === JSON.stringify(value)) continue;
        patch[field] = value; before[field] = current[field] == null ? null : snapshot(current[field]);
      }
      entries.push({ id: row.id, oldCode: current.code || row.before.code, before, patch, registryValues: row.registryValues });
    }
    if (removeMissing) for (const row of diff.missing) {
      const current = row.overrideBefore || {}; if (current.removed) continue;
      entries.push({ id: row.id, before: { removed: current.removed || null, registryJobId: current.registryJobId || null }, patch: { removed: true, removedAt: Date.now() } });
    }
    if (!entries.length) return api.toast('보존 정책을 적용하면 변경할 항목이 없어요.');
    if (!await ask(entries.length + '개 시설의 대장 정보를 적용해요.' + (removeMissing ? ' 새 대장에 빠진 시설에 철거 표시가 추가돼요.' : ''), { title: '대장을 적용할까요?', ok: '적용', danger: removeMissing })) return;
    const job = { id: root.DGOperations.uuid('registry'), actor: api.state().me, at: Date.now(), source: state.source, preserveOverrides: keep, markMissingRemoved: removeMissing, entries, counts: { added: diff.added.length, changed: diff.changed.length, missing: diff.missing.length } };
    button.disabled = true;
    try {
      const result = await root.DGOffline.submit('registry', job, { id: job.id, summary: '대장 갱신 · ' + entries.length + '개' });
      if (result.state === 'synced') { if (state.registry === diff) state.registry = null; api.toast('대장 갱신을 완료했어요.'); }
      else if (['failed', 'conflict'].includes(result.state)) { state.registryError = result.error + ' 이미 반영된 청크는 유지돼요. 저장 대기함에서 재시도하거나 새 비교를 만들어 주세요.'; }
      else api.toast('대장 갱신을 저장 대기함에서 계속 처리해요.');
    } finally { button.disabled = false; notify(); }
  }
  function inventoryView() {
    const O = root.DGOperations;
    if (!O.state.loaded) setTimeout(() => O.load(), 0);
    inventoryOwner();
    if (!state.inventoryForecastAttempted && !state.inventoryForecastLoading) { state.inventoryForecastAttempted = true; setTimeout(loadInventoryForecast, 0); }
    return '<div class="panel"><p>입출고는 수량 충돌을 확인한 뒤 기록해요. 보수 작업의 사용 자재는 완료 검수 때 한 번만 출고돼요.</p><button class="btn sodium" data-mgmt="inventory-new"' + (!supported() ? ' disabled' : '') + '>자재 등록</button><button class="btn ghost" data-mgmt="inventory-refresh"' + (state.inventoryForecastLoading ? ' disabled' : '') + '>새로고침</button><button class="btn ghost" data-mgmt="inventory-csv">CSV</button></div>' + inventoryForecastView() + (O.state.error ? '<p class="notice">' + E(O.state.error) + '</p>' : '') + '<div class="list">' + O.state.inventory.map(item => '<div class="panel"><div class="split"><b>' + E(item.name) + '</b><strong>' + item.quantity.toLocaleString() + ' ' + E(item.unit) + '</strong></div><p class="muted">단가 ' + item.unitCost.toLocaleString() + '원 · 수정 ' + api.fmtDT(item.updatedAt) + '</p><button class="btn ghost" data-mgmt="inventory-open" data-id="' + E(item.id) + '">정보 수정 / 입출고 / 이력</button></div>').join('') + '</div>' + (O.state.loaded && !O.state.inventory.length ? '<p class="empty">등록한 자재가 없어요.</p>' : '');
  }
  function inventoryOwner() {
    const owner = api.state().me + '/' + (!!api.firebase());
    if (state.inventoryOwner !== owner) {
      inventoryRequest++; state.inventoryOwner = owner;
      Object.assign(state, { inventoryForecast: null, inventoryForecastOrders: {}, inventoryForecastAttempted: false, inventoryForecastLoading: false, inventoryForecastError: '', inventoryForecastSource: 'unknown', inventoryForecastComplete: false, inventoryForecastAt: 0 });
    }
    return owner;
  }
  async function loadInventoryForecast() {
    const owner = inventoryOwner(); if (state.inventoryForecastLoading) return;
    const request = ++inventoryRequest, current = () => request === inventoryRequest && owner === api.state().me + '/' + (!!api.firebase());
    state.inventoryForecastAttempted = true; state.inventoryForecastLoading = true; state.inventoryForecastError = ''; notify();
    try {
      const metadata = [], options = { requireServer: !!api.firebase(), onMetadata: value => metadata.push(value) };
      const [inventory, orders] = await Promise.all([api.readAll('inventory', options), api.readAll('workOrders', { ...options, where: [['status', 'in', ['draft', 'assigned', 'in_progress', 'completed']]] })]);
      if (!current()) return;
      state.inventoryForecast = C.inventoryForecast(inventory, orders);
      state.inventoryForecastOrders = Object.fromEntries(orders.map(order => [order.id, order.title || order.id]));
      const sources = [...new Set(metadata.map(value => value.source))];
      state.inventoryForecastSource = sources.length === 1 ? sources[0] : sources.length > 1 ? 'mixed' : api.state().me === 'local' ? 'local' : options.requireServer ? 'server' : 'unknown';
      state.inventoryForecastComplete = metadata.length ? metadata.every(value => value.complete) : ['local', 'server'].includes(state.inventoryForecastSource);
      state.inventoryForecastAt = Date.now();
    } catch (error) { if (current()) state.inventoryForecastError = error.message || '예정 자재 소요를 불러오지 못했어요.'; }
    finally { if (current()) { state.inventoryForecastLoading = false; notify(); } }
  }
  function inventoryForecastView() {
    const result = state.inventoryForecast;
    return '<div class="panel"><h3>예정 자재 소요 · 부족 예상</h3><p class="muted">전체 미완료 작업에 저장된 자재를 합산해요. 완료 전에는 예정량, 검수 대기 중에는 실제 기록량이에요. 재고를 예약하거나 차감하지 않으며, 아직 입력하지 않은 자재는 포함되지 않아요.</p>' +
      (state.inventoryForecastLoading ? '<p role="status">전체 작업과 재고를 조회하는 중…</p>' : '') +
      (state.inventoryForecastError ? '<p class="notice" role="alert">' + E(state.inventoryForecastError) + ' 새로고침하면 다시 조회해요.</p>' : '') +
      (result ? '<p class="muted">조회 ' + api.fmtDT(state.inventoryForecastAt) + ' · ' + E(sourceLabel(state.inventoryForecastSource)) + (!state.inventoryForecastComplete ? ' · 참고용 예상' : '') + (state.inventoryForecastError || state.inventoryForecastLoading ? ' · 이전 조회 결과' : '') + '</p>' +
        (result.rows.length ? '<div class="dg-table"><table><thead><tr><th>자재</th><th>현재</th><th>예정 소요</th><th>사용 후 예상</th><th>부족 예상</th></tr></thead><tbody>' + result.rows.map(row => '<tr><td><button class="btn ghost sm" data-mgmt="inventory-open" data-id="' + E(row.id) + '">' + E(row.name) + '</button><small>' + E(row.unit) + '</small>' + (row.workIds.length ? '<details><summary>예정 작업 ' + row.workIds.length + '건</summary>' + row.workIds.map(id => '<button class="btn ghost sm" data-dg="open-work" data-id="' + E(id) + '">' + E(state.inventoryForecastOrders[id] || id) + '</button>').join('') + '</details>' : '') + '</td><td>' + row.quantity.toLocaleString() + '</td><td>' + row.planned.toLocaleString() + '</td><td>' + row.available.toLocaleString() + '</td><td>' + (row.shortage > 0 ? '<strong class="dg-conflict">' + row.shortage.toLocaleString() + ' 부족</strong>' : '충분') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="empty">조회된 자재가 없어요.</p>') +
        (result.unlinked.length ? '<p class="notice">재고와 연결되지 않은 자재 ' + result.unlinked.length + '건은 부족 수량을 계산할 수 없어요.</p><details><summary>자재 연결이 필요한 작업</summary>' + result.unlinked.map(part => '<p><button class="btn ghost sm" data-dg="open-work" data-id="' + E(part.workId) + '">' + E(state.inventoryForecastOrders[part.workId] || part.workId) + '</button> ' + E(part.name) + ' · ' + part.qty + '</p>').join('') + '</details>' : '') : '') + '</div>';
  }
  function newInventory() {
    api.navigate(heading('자재 등록', '초기 수량과 기준 단가를 기록해요.') + '<div class="panel"><label class="f" for="dgItemName">자재명</label><input class="f-in" id="dgItemName" maxlength="100"><label class="f" for="dgItemUnit">단위</label><input class="f-in" id="dgItemUnit" maxlength="20" value="개"><label class="f" for="dgItemQty">초기 수량</label><input class="f-in" id="dgItemQty" type="number" min="0" step="0.001" value="0"><label class="f" for="dgItemCost">단가 (원)</label><input class="f-in" id="dgItemCost" type="number" min="0" value="0"><button class="btn sodium block" data-mgmt="inventory-create">등록</button></div>', { key: 'inv:new', reopen: () => newInventory() });
  }
  async function openInventory(id) {
    const owner = inventoryOwner(), request = ++inventoryEditRequest, gen = api.navGen?.();
    const current = () => request === inventoryEditRequest && owner === api.state().me + '/' + (!!api.firebase()) && (gen == null || api.navAlive(gen));
    const item = root.DGOperations.state.inventory.find(x => x.id === id); if (!item) return;
    const draft = await inventoryDraft(item); if (!current()) return;
    const pending = !!draft.jobId;
    api.navigate(heading(item.name, '현재 ' + item.quantity + item.unit) + '<div class="panel" id="dgInventoryEdit" data-id="' + E(id) + '"><h3>기본정보 수정</h3><p class="muted">단위 ' + E(item.unit) + ' · 현재 수량과 과거 입출고·작업 단가는 유지돼요.</p>' +
      (draft.expectedRevision !== item.revision ? '<p class="notice">자재 정보가 변경됐어요. 최신 내용과 비교한 뒤 수정해 주세요.</p>' : '') +
      (draft.error ? '<p class="notice" role="alert">' + E(draft.error) + '</p>' : '') +
      (pending ? '<p class="notice" role="status">저장 대기 작업이 있어요. 결과를 확인한 뒤 이어서 수정할 수 있어요.</p><button class="btn ghost" data-mgmt="inventory-edit-check" data-id="' + E(id) + '">저장 결과 확인</button><button class="btn ghost" data-asec="outbox">저장 대기함</button>' : '') +
      ((draft.error || draft.expectedRevision !== item.revision) ? '<p class="muted">최신 기준: ' + E(item.name) + ' · 단가 ' + item.unitCost.toLocaleString() + '원</p><button class="btn ghost" data-mgmt="inventory-edit-refresh" data-id="' + E(id) + '">최신 정보와 비교하고 다시 수정</button>' : '') +
      '<fieldset style="border:0;padding:0;margin:0;min-width:0"' + (pending ? ' disabled' : '') + '><label class="f" for="dgEditItemName">자재명</label><input class="f-in" id="dgEditItemName" maxlength="100" value="' + E(draft.name) + '"><label class="f" for="dgEditItemCost">기준 단가 (원)</label><input class="f-in" id="dgEditItemCost" type="number" min="0" max="1000000000" value="' + E(draft.unitCost) + '"><label class="f" for="dgEditItemReason">수정 사유</label><input class="f-in" id="dgEditItemReason" maxlength="300" value="' + E(draft.reason) + '" placeholder="품목명 오타, 구매 기준 단가 정정 등"><button class="btn sodium block" data-mgmt="inventory-update" data-id="' + E(id) + '"' + (draft.expectedRevision !== item.revision ? ' disabled' : '') + '>기본정보 저장</button></fieldset><button class="btn ghost block" data-mgmt="inventory-edit-discard" data-id="' + E(id) + '">수정 초안 버리기</button></div>' +
      '<div class="panel"><h3>수량 입출고</h3><label class="f" for="dgMoveDelta">입출고 수량 (출고는 음수)</label><input class="f-in" id="dgMoveDelta" type="number" step="0.001" value="1"><label class="f" for="dgMoveReason">사유</label><input class="f-in" id="dgMoveReason" maxlength="300" placeholder="구매 입고, 반납, 실사 조정 등"><button class="btn sodium block" data-mgmt="inventory-move" data-id="' + E(id) + '" data-revision="' + item.revision + '">입출고 기록</button></div><h3>입출고 · 정보 수정 이력</h3><div id="dgStockHistory" data-id="' + E(id) + '">불러오는 중…</div>', { key: 'inv:' + id, reopen: () => openInventory(id) });
    const historyGen = api.navGen?.();
    try {
      const rows = (await api.readAll('inventoryMoves', { where: [['itemId', '==', id]] })).sort((a, b) => b.at - a.at), box = Q('#dgStockHistory');
      if (box && box.dataset.id === id && (historyGen == null || api.navAlive(historyGen))) box.innerHTML = rows.length ? rows.map(r => '<div class="hist"><b>' + (r.delta === 0 ? '기본정보 수정 / 수량 변동 없음' : (r.delta > 0 ? '+' : '') + r.delta + E(item.unit)) + '</b> ' + E(r.reason) + '<div class="muted">' + api.fmtDT(r.at) + ' · ' + E(api.state().names[r.by] || r.by) + '</div></div>').join('') : '<p class="empty">입출고 이력이 없어요.</p>';
    } catch (error) { const box = Q('#dgStockHistory'); if (box && box.dataset.id === id && (historyGen == null || api.navAlive(historyGen)) && owner === api.state().me + '/' + (!!api.firebase())) box.textContent = error.message; }
  }
  async function inventoryDraft(item) {
    const owner = api.state().me, key = owner + '/' + item.id;
    if (inventoryDrafts.has(key)) return inventoryDrafts.get(key);
    const stored = root.DGOffline.ready ? await root.DGOffline.get('inventoryDraft', item.id) : null;
    const draft = stored?.actor === owner && stored.itemId === item.id ? stored : { actor: owner, itemId: item.id, expectedRevision: item.revision, name: item.name, unitCost: String(item.unitCost), reason: '', jobId: '', error: '', baselineName: item.name, baselineUnitCost: item.unitCost };
    if (!Object.prototype.hasOwnProperty.call(draft, 'baselineName')) {
      draft.baselineName = draft.expectedRevision === item.revision ? item.name : null;
      draft.baselineUnitCost = draft.expectedRevision === item.revision ? item.unitCost : null;
    }
    inventoryDrafts.set(key, draft); return draft;
  }
  function captureInventoryDraft(draft) {
    if (!draft.jobId) {
      if (Q('#dgEditItemName')) draft.name = Q('#dgEditItemName').value;
      if (Q('#dgEditItemCost')) draft.unitCost = Q('#dgEditItemCost').value;
      if (Q('#dgEditItemReason')) draft.reason = Q('#dgEditItemReason').value;
    }
    return draft;
  }
  function persistInventoryDraft(draft) {
    if (!root.DGOffline.ready) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(draft)), namespace = root.DGOffline.namespace, backend = api.firebase();
    const pending = inventoryWrites.catch(() => {}).then(() => {
      if (api.state().me !== snapshot.actor || namespace !== root.DGOffline.namespace || backend !== api.firebase()) return;
      if (!snapshot.jobId && snapshot.baselineName !== null && String(snapshot.name).trim() === snapshot.baselineName && snapshot.unitCost !== '' && Number(snapshot.unitCost) === snapshot.baselineUnitCost && !String(snapshot.reason).trim()) return root.DGOffline.remove('inventoryDraft', snapshot.itemId);
      return root.DGOffline.put('inventoryDraft', snapshot.itemId, snapshot);
    });
    inventoryWrites = pending; return pending;
  }
  async function clearInventoryDraft(draft) {
    const namespace = root.DGOffline.namespace, backend = api.firebase();
    await inventoryWrites.catch(() => {}); inventoryDrafts.delete(draft.actor + '/' + draft.itemId);
    if (root.DGOffline.ready && api.state().me === draft.actor && namespace === root.DGOffline.namespace && backend === api.firebase()) await root.DGOffline.remove('inventoryDraft', draft.itemId);
    state.inventoryForecastAttempted = false; state.inventoryForecast = null;
  }
  async function updateInventory(button) {
    const actor = api.state().me, backend = api.firebase(), namespace = root.DGOffline.namespace, gen = api.navGen?.();
    const owned = () => actor === api.state().me && backend === api.firebase() && namespace === root.DGOffline.namespace;
    const visible = () => owned() && (gen == null || api.navAlive(gen));
    const id = button.dataset.id, item = root.DGOperations.state.inventory.find(x => x.id === id); if (!item) return;
    const draft = await inventoryDraft(item); if (!visible()) return; if (draft.jobId) return api.toast('이미 저장 대기 중이에요. 저장 결과를 확인해 주세요.');
    captureInventoryDraft(draft);
    if (!draft.name.trim() || !draft.reason.trim() || draft.unitCost === '' || !Number.isFinite(Number(draft.unitCost)) || Number(draft.unitCost) < 0 || Number(draft.unitCost) > 1000000000) throw new Error('자재명·기준 단가·수정 사유를 확인해 주세요.');
    const job = { id: root.DGOperations.uuid('stock-edit'), kind: 'inventory-update', itemId: id, input: { name: draft.name, unitCost: Number(draft.unitCost) }, expectedRevision: draft.expectedRevision, reason: draft.reason, actor: api.state().me, at: Date.now() };
    draft.jobId = job.id; draft.error = ''; await persistInventoryDraft(draft); button.disabled = true;
    if (!owned()) { button.disabled = false; return; }
    try {
      const result = await root.DGOperations.submit(job, '자재 기본정보 수정 · ' + draft.name);
      if (result.state === 'synced' && owned()) { await clearInventoryDraft(draft); if (owned()) await root.DGOperations.load(true); }
    } catch (error) { draft.error = error.message || '저장하지 못했어요.'; if (owned()) await persistInventoryDraft(draft); }
    finally { button.disabled = false; }
    if (visible()) await openInventory(id);
  }
  async function checkInventoryEdit(id, rebase) {
    const actor = api.state().me, backend = api.firebase(), namespace = root.DGOffline.namespace, gen = api.navGen?.();
    const owned = () => actor === api.state().me && backend === api.firebase() && namespace === root.DGOffline.namespace;
    const visible = () => owned() && (gen == null || api.navAlive(gen));
    const item = root.DGOperations.state.inventory.find(x => x.id === id); if (!item) return;
    const draft = captureInventoryDraft(await inventoryDraft(item));
    const job = draft.jobId && (await root.DGOffline.jobs()).find(value => value.id === draft.jobId);
    if (!visible()) return;
    if (job?.state === 'synced') { await clearInventoryDraft(draft); if (!owned()) return; await root.DGOperations.load(true); return visible() ? openInventory(id) : undefined; }
    if (job && !['failed', 'conflict'].includes(job.state)) return api.toast('아직 저장 대기 중이에요. 전송이 끝난 뒤 결과를 확인해 주세요.');
    if (rebase) {
      await root.DGOperations.load(true);
      if (!visible()) return;
      const latest = root.DGOperations.state.inventory.find(x => x.id === id); if (!latest) throw new Error('자재를 찾을 수 없어요.');
      if (job) await root.DGOffline.discard(job.id); if (!owned()) return;
      draft.jobId = ''; draft.expectedRevision = latest.revision; draft.error = ''; draft.baselineName = latest.name; draft.baselineUnitCost = latest.unitCost;
    } else draft.error = job?.error || '저장 대기 작업이 없어요. 최신 정보와 비교한 뒤 다시 수정해 주세요.';
    await persistInventoryDraft(draft); return visible() ? openInventory(id) : undefined;
  }
  async function resumeInventoryDraft(id) {
    if (!api.can('admin')) throw new Error('관리자 권한이 필요해요.');
    const actor = api.state().me, backend = api.firebase(), namespace = root.DGOffline.namespace, gen = api.navGen?.(), request = ++inventoryEditRequest;
    const current = () => request === inventoryEditRequest && actor === api.state().me && backend === api.firebase() && namespace === root.DGOffline.namespace && (gen == null || api.navAlive(gen));
    await inventoryWrites.catch(() => {}); if (!current()) return false;
    await root.DGOperations.load(true); if (!current()) return false;
    if (!root.DGOperations.state.inventory.some(item => item.id === id)) { api.toast('자재를 찾을 수 없어요. 초안은 저장 대기함에 남겨 두었어요.'); return false; }
    await openInventory(id); return true;
  }
  async function discardInventoryDraft(id, options = {}) {
    if (!api.can('admin')) throw new Error('관리자 권한이 필요해요.');
    const actor = api.state().me, backend = api.firebase(), namespace = root.DGOffline.namespace, gen = api.navGen?.();
    const current = () => actor === api.state().me && backend === api.firebase() && namespace === root.DGOffline.namespace && (gen == null || api.navAlive(gen));
    await inventoryWrites.catch(() => {}); if (!current()) return false;
    const key = actor + '/' + id, draft = inventoryDrafts.get(key) || (root.DGOffline.ready ? await root.DGOffline.get('inventoryDraft', id) : null);
    if (!current() || !draft || draft.actor !== actor || draft.itemId !== id) return false;
    const getJob = async () => draft.jobId && root.DGOffline.ready ? (await root.DGOffline.jobs()).find(job => job.id === draft.jobId) : null;
    const job = await getJob(); if (!current()) return false;
    if (job && ['queued', 'sending'].includes(job.state)) { api.toast('전송 중이거나 저장 대기 중이에요. 결과를 확인한 뒤 수정 초안을 정리해 주세요.'); return false; }
    if (!options.confirmed && !await ask('저장하지 않은 자재 정보 수정을 버려요. 이미 저장된 자재·재고·변경 이력은 유지돼요.', { title: '수정 초안을 버릴까요?', ok: '초안 버리기', danger: true })) return false;
    if (!current()) return false;
    const latestJob = await getJob(); if (!current()) return false;
    if (latestJob && ['queued', 'sending'].includes(latestJob.state)) { api.toast('전송 상태가 바뀌었어요. 저장 결과를 확인한 뒤 정리해 주세요.'); return false; }
    if (latestJob && ['failed', 'conflict'].includes(latestJob.state)) { await root.DGOffline.discard(latestJob.id); if (!current()) return false; }
    await clearInventoryDraft(draft); return current();
  }
  function settingsView() {
    const privacySupported = root.DGPrivacy.supported({ database: api.database?.(), firebase: api.firebase() });
    const s = root.DGOperations.state.settings;
    if (!root.DGOperations.state.loaded && !root.DGOperations.state.error) setTimeout(() => root.DGOperations.load(), 0);
    return '<div class="panel"><h3>업무 기준</h3><label class="f" for="dgInspectionDays">정기 점검 주기 (일)</label><input class="f-in" id="dgInspectionDays" type="number" min="1" max="3650" value="' + Number(s.inspectionDays) + '"><label class="f" for="dgPrivacyDays">신고 연락처 보관 기간 (일)</label><input class="f-in" id="dgPrivacyDays" type="number" min="1" max="3650" value="' + Number(s.privacyDays) + '"><p class="muted">점검 주기는 미점검·기한 초과 목록에 반영돼요. 연락처 자동 파기는 Firebase 예약 함수를 배포한 환경에서 실행돼요. 수동 파기는 Firebase 또는 기기 체험 저장소에서 사용할 수 있어요. 이외의 공유 저장소에서는 수동 파기를 지원하지 않아요.</p><button class="btn sodium" data-mgmt="settings-save">기준 저장</button><button class="btn ghost" data-mgmt="privacy-purge"' + (privacySupported ? '' : ' disabled') + '>보관 기간 지난 신고자 정보 파기</button></div><div class="panel"><h3>기기 저장과 계정</h3><p>' + (root.DGOffline.durable ? '이 기기는 초안과 저장 대기 작업을 보관해요.' : '공유 기기 모드로 현재 창에서만 초안을 보관해요.') + '</p><button class="btn ghost" data-asec="roles">사용자·권한 / 기기 모드</button></div>';
  }
  async function saveSettings() {
    if (!api.can('admin')) return;
    const inspectionDays = Number(Q('#dgInspectionDays').value), privacyDays = Number(Q('#dgPrivacyDays').value);
    if (![inspectionDays, privacyDays].every(n => Number.isInteger(n) && n >= 1 && n <= 3650)) throw new Error('기간은 1~3650일의 정수로 입력해 주세요.');
    const value = { schemaVersion: 1, inspectionDays, privacyDays, updatedAt: Date.now(), updatedBy: api.state().me };
    await api.database().doc('settings/operations').set(value); Object.assign(root.DGOperations.state.settings, value); api.toast('업무 기준을 저장했어요.'); notify();
  }
  // What a citizen gave us that identifies them or where they were: contact, photo, GPS position, and the position text
  // an imported QR report carries (`ext`). Same list as the server's expiry job (functions/core.js PRIVATE_FIELDS).
  const privateLeft = r => root.DGPrivacy.privateLeft(r);
  const privatePatch = r => root.DGPrivacy.privatePatch(r);
  async function purgeContacts() {
    if (!api.can('admin')) return;
    if (!root.DGPrivacy.supported({ database: api.database(), firebase: api.firebase() })) throw new Error(root.DGPrivacy.unsupported);
    const days = root.DGPrivacy.days(root.DGOperations.state.settings.privacyDays), at = Date.now();
    const records = Object.fromEntries(await Promise.all(root.DGPrivacy.COLLECTIONS.map(async collection => [collection, await api.readAll(collection, { requireServer: !!api.firebase() })])));
    const values = root.DGPrivacy.targets(records, at, days);
    if (!values.length) return api.toast('보관 기간이 지난 신고자 정보가 없어요.');
    if (!await ask('개별 보관 만료일 또는 현재 보관 기간(' + days + '일)이 지난 원본·이관 신고 ' + values.length + '건의 연락처·사진·신고 위치를 파기해요. 신고 내용과 처리 이력은 유지돼요.', { title: '신고자 정보를 파기할까요?', ok: '파기', danger: true })) return;
    const job = { id: root.DGOperations.uuid('privacy'), actor: api.state().me, at, privacyDays: days, targets: values };
    const result = await root.DGOffline.submit('privacy', job, { id: job.id, summary: '연락처 보관 기간 만료 · ' + values.length + '건' });
    api.toast(result.state === 'synced' ? '기한이 지난 연락처를 파기했어요.' : result.error || '저장 대기함에서 처리를 이어가요.');
  }
  async function auditLoad(more = false) {
    if (state.auditLoading) return;
    state.auditLoading = true; state.auditAttempted = true; state.auditError = '';
    try {
      const collection = api.firebase() ? 'auditEvents' : 'workEvents';
      const options = { requireServer: !!api.firebase(), orderBy: [['at', 'desc']], pageSize: 40, cursor: more ? state.auditCursor : null };
      const page = api.readPage ? await api.readPage(collection, options) : { rows: await api.readAll(collection, options), nextCursor: null, hasMore: false };
      state.audit = more ? [...new Map([...state.audit, ...page.rows].map(row => [row.id, row])).values()] : page.rows;
      state.auditCursor = page.nextCursor; state.auditMore = page.hasMore;
      state.auditLoaded = true; state.auditAt = Date.now();
    } catch (error) { state.auditError = error.message || '감사 기록을 불러오지 못했어요.'; }
    finally { state.auditLoading = false; notify(); }
  }
  function auditView() {
    if (!state.auditAttempted && !state.auditLoading) { state.auditAttempted = true; setTimeout(() => auditLoad(), 0); }
    return '<div class="panel"><p>' + (api.firebase() ? '서버 감사 함수가 남긴 변경 이벤트를 조회해요. 함수 배포 전의 과거 변경은 여기에 생성되지 않아요.' : '로컬 체험의 보수 작업 이력이에요. 서버가 보증하는 감사 로그는 Firebase 환경에서 제공돼요.') + '</p><button class="btn ghost" data-mgmt="audit-refresh"' + (state.auditLoading ? ' disabled' : '') + '>다시 조회</button><button class="btn ghost" data-mgmt="audit-csv"' + (state.auditLoading ? ' disabled' : '') + '>전체 CSV</button></div>' +
      (state.auditLoading ? '<p role="status">감사 기록 조회 중…</p>' : '') +
      (state.auditError ? '<p class="notice" role="alert">' + E(state.auditError) + ' 다시 조회를 누르면 재시도해요.</p>' : '') +
      '<div class="list">' + state.audit.map(r => '<div class="hist"><b>' + E(r.action || r.type || '변경') + '</b> ' + E(r.path || r.workId || '') + '<div>' + E(r.note || (r.fromStatus ? r.fromStatus + ' → ' + r.toStatus : '')) + '</div><small>' + api.fmtDT(typeof r.at === 'number' ? r.at : r.at && r.at.seconds * 1000) + ' · ' + E(r.actor || r.by || '서버') + '</small></div>').join('') + '</div>' +
      '<p class="muted">조회한 기록 ' + state.audit.length + '건' + (state.auditAt ? ' · ' + api.fmtDT(state.auditAt) : '') + ' · 전체 CSV는 서버 자료를 끝까지 다시 조회해요.</p>' +
      (state.auditMore ? '<button class="btn ghost block" data-mgmt="audit-more"' + (state.auditLoading ? ' disabled' : '') + '>이전 기록 더 보기</button>' : '');
  }
  async function healthLoad() {
    if (state.healthLoading) return;
    state.healthAttempted = true; state.healthLoading = true; state.healthError = '';
    try {
      if (!api.firebase() || !root.FIREBASE_CONFIG?.functionsEnabled || !root.DGSecurity?.call) throw new Error('공유 서버와 운영 함수를 연결한 뒤 확인할 수 있어요.');
      state.health = await root.DGSecurity.call('getOperationalHealth', {});
    } catch (error) { state.healthError = error.message || '운영 상태를 확인하지 못했어요.'; }
    finally { state.healthLoading = false; notify(); }
  }
  function healthView() {
    const enabled = !!api.firebase() && !!root.FIREBASE_CONFIG?.functionsEnabled;
    if (enabled && !state.healthAttempted && !state.healthLoading) { state.healthAttempted = true; setTimeout(healthLoad, 0); }
    const h = state.health, labels = { gateway: '주민 접수', audit: '변경 이력 기록', retention: '보관 기간 정리' }, statuses = { unknown: '확인 기록 없음', ok: '정상 기록 있음', error: '최근 실패', stale: '최근 성공 확인 필요' };
    return '<div class="panel"><h3>공유 운영 상태</h3><p>서버가 기록한 최근 실행 결과와 처리 대기 건수를 확인해요.</p>' +
      (!enabled ? '<p class="notice">서버 관리 함수가 연결되지 않아 이 화면에서 접수·감사·예약 정리의 실행 상태를 확인할 수 없어요. 직원 공유 저장은 Firebase 설정에 따르며, 관리자 업무 기준에서 원본·이관 신고자 정보를 수동 파기할 수 있어요.</p>' : '<button class="btn ghost" data-mgmt="health-refresh"' + (state.healthLoading ? ' disabled' : '') + '>운영 상태 다시 확인</button>') +
      (state.healthLoading ? '<p role="status">서버 상태 확인 중…</p>' : '') + (state.healthError ? '<p class="notice" role="alert">' + E(state.healthError) + '</p>' : '') + '</div>' +
      (h ? (h.maintenance?.active ? '<p class="notice" role="alert">업무 자료 이전이 진행 중이에요. 완료 전까지 공동 자료의 조회·편집이 일시 중지됩니다.</p>' : '') + '<p class="muted">서버 확인 ' + api.fmtDT(h.checkedAt) + (state.healthError ? ' · 이전 조회 결과' : '') + '</p><div class="grid2">' + Object.entries(labels).map(([key, label]) => {
        const item = h.services?.[key] || {}, status = statuses[item.state] || statuses.unknown;
        return '<div class="panel"><h3>' + label + '</h3><b>' + E(status) + '</b><p class="muted">마지막 성공 ' + (item.lastSuccessAt ? api.fmtDT(item.lastSuccessAt) : '기록 없음') + '</p>' + (item.lastFailureAt ? '<p class="notice">실패 ' + api.fmtDT(item.lastFailureAt) + (item.lastErrorCode ? ' · ' + E(item.lastErrorCode) : '') + '</p>' : '') + '</div>';
      }).join('') + '</div><div class="panel"><h3>처리 대기 업무</h3><p>' + (h.scope === 'assigned' ? '본인에게 배정된 범위' : '조회 권한에 맞는 업무 범위') + '</p>' + Object.entries({ unimportedReports: '직원 신고함으로 옮기지 않은 접수', openWorkOrders: '미완료 보수 작업', overdueWorkOrders: '기한 초과 작업', myOpenWorkOrders: '내 미완료 작업' }).filter(([key]) => h.counts?.[key] != null).map(([key, label]) => '<p>' + label + ' <b>' + E(h.counts[key]) + '건</b></p>').join('') + '<button class="btn ghost" data-asec="works">보수 작업 보기</button></div>' : '');
  }
  async function handle(button) {
    const action = button.dataset.mgmt;
    if (action === 'dashboard-load') { state.from = Q('#dgDashFrom').value; state.to = Q('#dgDashTo').value; return loadDashboard(); }
    if (action === 'dashboard-csv') return root.DGOperations.download('동구_업무현황_' + state.from + '_' + state.to, dashboardRows());
    if (action === 'dashboard-print') { requireDashboard(); return api.print(Q('#dgDashboardReport').innerHTML); }
    if (action === 'health-refresh') return healthLoad();
    if (!api.can('admin')) throw new Error('관리자 권한이 필요해요.');
    if (action === 'registry-apply') return applyRegistry(button);
    if (action === 'registry-csv') { const d = state.registry; return root.DGOperations.download('동구_대장비교', [['구분', 'ID', '표찰', '변경 필드', '현장 충돌'], ...d.added.map(r => ['신규', r.id, r.code, '', '']), ...d.changed.map(r => ['변경', r.id, r.code, Object.keys(r.changes).join(', '), r.conflicts.join(', ')]), ...d.missing.map(r => ['누락', r.id, r.code, '', ''])]); }
    if (action === 'inventory-new') return newInventory();
    if (action === 'inventory-refresh') { await root.DGOperations.load(true); return loadInventoryForecast(); }
    if (action === 'inventory-csv') return root.DGOperations.download('동구_자재재고', [['자재', '수량', '단위', '단가', '수정'], ...root.DGOperations.state.inventory.map(i => [i.name, i.quantity, i.unit, i.unitCost, api.fmtDT(i.updatedAt)])]);
    if (action === 'inventory-open') return openInventory(button.dataset.id);
    if (action === 'inventory-update') return updateInventory(button);
    if (action === 'inventory-edit-check' || action === 'inventory-edit-refresh') return checkInventoryEdit(button.dataset.id, action === 'inventory-edit-refresh');
    if (action === 'inventory-edit-discard') {
      const gen = api.navGen?.(), id = button.dataset.id;
      if (await discardInventoryDraft(id)) { if (gen != null && !api.navAlive(gen)) return; await root.DGOperations.load(true); if (gen == null || api.navAlive(gen)) return openInventory(id); }
      return;
    }
    if (action === 'inventory-create' || action === 'inventory-move') {
      const create = action === 'inventory-create';
      const job = { id: root.DGOperations.uuid('stock-command'), kind: create ? 'inventory-create' : 'inventory-move', itemId: create ? root.DGOperations.uuid('item') : button.dataset.id, actor: api.state().me, at: Date.now(), ...(create ? { input: { name: Q('#dgItemName').value, unit: Q('#dgItemUnit').value, quantity: Number(Q('#dgItemQty').value), unitCost: Number(Q('#dgItemCost').value) } } : { delta: Number(Q('#dgMoveDelta').value), expectedRevision: Number(button.dataset.revision), reason: Q('#dgMoveReason').value }) };
      if (!create && (!job.reason.trim() || !job.delta)) throw new Error('입출고 수량과 사유를 입력해 주세요.');
      button.disabled = true; try { const result = await root.DGOperations.submit(job, create ? '자재 등록 · ' + job.input.name : '자재 입출고'); if (result.state === 'synced') { api.closeSheet(); await root.DGOperations.load(true); state.inventoryForecastAttempted = false; state.inventoryForecast = null; } } finally { button.disabled = false; } return;
    }
    if (action === 'settings-save') return saveSettings();
    if (action === 'privacy-purge') return purgeContacts();
    if (action === 'audit-refresh') return auditLoad();
    if (action === 'audit-more') return auditLoad(true);
    if (action === 'audit-csv') {
      const rows = await api.readAll(api.firebase() ? 'auditEvents' : 'workEvents', { requireServer: !!api.firebase(), orderBy: [['at', 'desc']] });
      return root.DGOperations.download('동구_감사기록', [['ID', '구분', '대상', '행위자', '시각'], ...rows.map(r => [r.id, r.action || r.type, r.path || r.workId, r.actor || r.by, api.fmtDT(typeof r.at === 'number' ? r.at : r.at && r.at.seconds * 1000)])]);
    }
  }
  function attach(context) {
    api = context;
    root.DGOffline.register('registry', job => root.DGRegistryCommands.execute(job, { db: api.database(), fb: api.firebase(), user: api.state().me, admin: api.can('admin'), progress: (n, all) => { state.registryProgress = n + '/' + all + '개 처리'; const el = Q('#dgRegistryProgress'); if (el) el.textContent = state.registryProgress; } }));
    root.DGOffline.register('privacy', job => root.DGPrivacy.execute(job, { database: api.database(), firebase: api.firebase(), actor: api.state().me, admin: api.can('admin') }));
    if (attached) return; attached = true;
    document.addEventListener('click', e => { const b = e.target.closest('[data-mgmt]'); if (b) Promise.resolve().then(() => handle(b)).catch(error => api.toast(error.message || '처리하지 못했어요.')); });
    document.addEventListener('change', e => { if (e.target.id === 'dgDashFrom' || e.target.id === 'dgDashTo') { state[e.target.id === 'dgDashFrom' ? 'from' : 'to'] = e.target.value; notify(); } if (e.target.id === 'dgRegistryFile' && e.target.files[0]) registryFile(e.target.files[0]); });
    document.addEventListener('input', e => {
      const form = e.target.closest('#dgInventoryEdit'); if (!form) return;
      const draft = inventoryDrafts.get(api.state().me + '/' + form.dataset.id); if (!draft || draft.jobId) return;
      captureInventoryDraft(draft); persistInventoryDraft(draft).catch(error => api.toast(error.message || '수정 초안을 기기에 보관하지 못했어요.'));
    });
  }
  root.DGManagement = { privateLeft, privatePatch, attach, dashboard, registryView, inventoryView, settingsView, auditView, healthView, resumeInventoryDraft, discardInventoryDraft, state };
})(globalThis);
