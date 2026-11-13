(function (root) {
  'use strict';
  /* in-app confirmation when app/dialog.js is present; the plain confirm() keeps bare test sandboxes working */
  const ask = (message, opts) => root.DGDialog ? root.DGDialog.confirm(message, opts) : Promise.resolve(confirm(message));
  const C = root.DGOperationsCore;
  let api, loading = null, reloadRequested = false, attached = false, detailToken = 0, editorRequest = 0;
  let draftWrites = Promise.resolve();
  const draftVersions = new WeakMap(), editorTokens = new WeakMap(), draftOwners = new WeakMap(), processSettlements = new Map();
  let subscriptions = null, watchedWorkKey = '', watchedReportId = '';
  let editConflict = null;
  let drivingSession = null, drivingToken = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const state = { orders: [], inventory: [], reports: [], settings: { inspectionDays: 90, privacyDays: 90 }, loaded: false, error: '', at: 0, filter: 'open', mine: false, deadline: 'all', urgent: false, workDong: '전체', show: 40, cursor: null, hasMore: false, workQueryKey: '', queryAt: Date.now(), workMeta: null, draft: null, completion: null, edit: null, currentOrder: null, reportVersions: {}, lightVersion: null, plan: null, dueFilter: 'needed', dueDong: '전체', dueShow: 60, dueSort: 'priority', pos: null, planPick: new Set(), workPick: new Map(), bulk: null, jobs: [], drafts: [] };
  const uuid = prefix => prefix + '-' + (root.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const E = value => api.esc(value), Q = selector => document.querySelector(selector);
  const time = value => value ? api.fmtDT(value) : '미지정';
  const admin = () => api.can('admin');
  const supported = () => api.state().me === 'local' || !!api.firebase();
  const label = id => api.state().names[id] || (api.state().roles.find(r => r.id === id) || {}).name || (id === 'local' ? '이 기기 관리자' : id || '미배정');
  const options = (values, selected) => values.map(v => '<option value="' + E(v) + '"' + (v === selected ? ' selected' : '') + '>' + E(v) + '</option>').join('');
  const heading = (title, subtitle) => '<div class="sheet-head"><div><h3>' + E(title) + '</h3><div class="muted">' + E(subtitle || '') + '</div></div><button type="button" class="x" data-close aria-label="닫기">×</button></div>';
  const staffOptions = selected => {
    const rows = [...new Map([{ id: api.state().me, role: admin() ? 'admin' : 'inspector' }, ...api.state().roles].filter(r => ['admin', 'inspector'].includes(r.role)).map(r => [r.id, r])).values()];
    if (selected && !rows.some(row => row.id === selected)) rows.push({ id: selected });
    return '<option value="">미배정</option>' + rows.map(row => '<option value="' + E(row.id) + '"' + (row.id === selected ? ' selected' : '') + '>' + E(label(row.id)) + '</option>').join('');
  };
  function dateInput(ms) { return ms ? C.kstDateKey(ms) : ''; }
  function dueValue(value) { return value ? Date.parse(value + 'T23:59:59.999+09:00') : 0; }
  function notify() { if (api) api.render(); }
  function captureOwner() { return { api, actor: api.state().me, database: api.database(), firebase: api.firebase(), offline: root.DGOffline, namespace: root.DGOffline.namespace }; }
  function ownsContext(owner) { return !!owner && api === owner.api && api.state().me === owner.actor && api.database() === owner.database && api.firebase() === owner.firebase && root.DGOffline === owner.offline && root.DGOffline.ready && root.DGOffline.namespace === owner.namespace; }
  function requireOwner(owner) { if (!ownsContext(owner)) throw Object.assign(new Error('계정이나 저장소가 바뀌어 이전 작업을 현재 계정에서 처리하지 않았어요.'), { code: 'account-changed' }); }
  function draftOwner(d) { let owner = draftOwners.get(d); if (!owner) { owner = captureOwner(); draftOwners.set(d, owner); } return owner; }
  function workFilters() { return { status: state.filter, mine: state.mine, deadline: state.deadline, urgent: state.urgent, dong: state.workDong }; }
  function filterKey() { return JSON.stringify(workFilters()); }
  function selectedOrders(rows = state.orders) { return C.filterOrders(rows, workFilters(), { user: api.state().me, byId: api.byId, inDong: api.inDong, now: state.queryAt }); }
  function sourceText(metadata) {
    if (!metadata) return '조회 전';
    const name = { server: '서버 조회', cache: '기기 캐시 · 전체 여부 미확인', mixed: '서버·캐시 혼합', local: '이 기기 저장', artifact: '공유 저장소 · 전체 여부 미확인', unknown: '자료 출처 미확인' }[metadata.source] || '자료 출처 미확인';
    return name + ' · ' + time(metadata.fetchedAt);
  }
  async function readOrder(id) {
    let snap;
    try { snap = await api.database().doc('workOrders/' + id).get(api.firebase() && navigator.onLine !== false ? { source: 'server' } : undefined); }
    catch (error) { if (offlineFailure(error) && root.DGFieldKit?.record) { const cached = await root.DGFieldKit.record('workOrders', id); if (cached) return cached; } throw error; }
    return snap?.exists !== false && snap?.data() ? { ...snap.data(), id } : null;
  }
  function offlineFailure(error) { const code=String(error.code||'').replace(/^(?:firestore|functions)\//,''); return !['permission-denied', 'unauthenticated'].includes(code) && (navigator.onLine === false || ['unavailable', 'offline', 'deadline-exceeded'].includes(code)); }
  async function loadReports(lightId) {
    const owner = captureOwner(), gen = api.navGen?.(), request = editorRequest, current = () => ownsContext(owner) && request === editorRequest && (gen == null || api.navAlive(gen));
    let records, metadata;
    try { records = await api.readAll('reports', { where: [['lightId', '==', lightId]], requireServer: !!api.firebase() && navigator.onLine !== false, onMetadata: value => { metadata = value; } }); }
    catch (error) {
      if (!current()) return [];
      if (!offlineFailure(error) || !root.DGFieldKit?.forLight) throw error;
      const prepared = await root.DGFieldKit.forLight('reports', lightId); if (!current()) return [];
      if (!prepared) throw error; records = prepared.rows; metadata = { source: 'prepared', preparedAt: prepared.preparedAt, fetchedAt: prepared.preparedAt, scope: prepared.scope, coverage: prepared.coverage, complete: false };
    }
    if (!current()) return [];
    state.reportMeta ||= {}; state.reportMeta[lightId] = metadata || null;
    state.reports = [...state.reports.filter(r => r.lightId !== lightId), ...records]; if (metadata?.source !== 'prepared') bindReportUpdates(lightId); return records;
  }
  async function load(force, append = false) {
    if (loading) { if (force) reloadRequested = true; return loading; }
    if (state.loaded && !force && !append && state.workQueryKey === filterKey()) return state;
    loading = (async () => {
      do {
        reloadRequested = false;
        const key = filterKey(), reset = !append || key !== state.workQueryKey;
        if (reset) state.queryAt = Date.now();
        const query = C.workQuery(workFilters(), api.state().me, state.queryAt), request = { requireServer: !!api.firebase() && navigator.onLine !== false };
        try {
          const [inventory, settings] = await Promise.all([api.readAll('inventory', request), api.readAll('settings', request)]);
          const rows = reset ? [] : [...state.orders], seen = new Set(rows.map(r => r.id));
          let cursor = reset ? null : state.cursor, hasMore = true, meta = reset ? null : state.workMeta;
          while (hasMore) {
            const page = await (api.readPage ? api.readPage('workOrders', { ...request, ...query, cursor, pageSize: 60 }) : root.DGData.readPage(api.database(), 'workOrders', { ...request, ...query, cursor, pageSize: 60 }));
            if (key !== filterKey()) { reloadRequested = true; break; }
            for (const row of page.rows) { if (seen.has(row.id)) throw new Error('조회 중 작업 순서가 바뀌었어요. 새로고침해 주세요.'); seen.add(row.id); rows.push(row); }
            cursor = page.nextCursor; hasMore = page.hasMore;
            meta = { source: meta && meta.source !== page.source ? 'mixed' : page.source, complete: (!meta || meta.complete) && page.complete, fetchedAt: page.fetchedAt };
            if (selectedOrders(rows).length >= state.show || !hasMore) break;
          }
          if (reloadRequested) { append = false; continue; }
          state.orders = rows; state.cursor = cursor; state.hasMore = hasMore; state.workMeta = meta; state.workQueryKey = key;
          state.inventory = inventory.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
          state.settings = { ...state.settings, ...(settings.find(x => x.id === 'operations') || {}) };
          state.loaded = true; state.error = ''; state.offlineError = false; state.at = meta?.fetchedAt || Date.now();
          if (subscriptions) bindWorkUpdates();
        } catch (error) {
          // Only connection failures wait for the signal; the list still never shows unconfirmed server data.
          state.offlineError = offlineFailure(error);
          state.error = (error.message || '업무 기록을 불러오지 못했어요.') + (state.offlineError ? ' 연결되면 자동으로 다시 불러와요. 미리 준비한 작업은 관리 현황의 출동 자료에서 볼 수 있어요.' : '');
        }
        append = false;
      } while (reloadRequested);
      loading = null; notify(); return state;
    })();
    return loading;
  }
  function ensure() { if ((!state.loaded || state.workQueryKey !== filterKey()) && !loading && !state.error) setTimeout(() => load(), 0); }
  async function fullSelectedOrders() {
    const filters = workFilters(), key = filterKey(), queryAt = state.queryAt; let metadata;
    const rows = await api.readAll('workOrders', { ...C.workQuery(filters, api.state().me, queryAt), requireServer: !!api.firebase(), onMetadata: value => { metadata = value; } });
    if (key !== filterKey()) throw new Error('조회 조건이 바뀌었어요. 선택한 조건에서 다시 실행해 주세요.');
    return { rows: C.filterOrders(rows, filters, { user: api.state().me, byId: api.byId, inDong: api.inDong, now: queryAt }), metadata };
  }
  function workLights(rows) {
    const map = new Map();
    for (const w of rows) { const light = api.byId(w.lightId); if (!light) continue; if (!map.has(light.id)) map.set(light.id, { ...light, workIds: [] }); map.get(light.id).workIds.push(w.id); }
    return [...map.values()];
  }
  function watchCollection(name, query, changed) {
    let signature = null;
    return query.onSnapshot(snapshot => {
      const next = JSON.stringify((snapshot.docs || []).map(doc => { const row = doc.data(); return [doc.id, row.revision || 0, row.updatedAt || row.createdAt || 0, name === 'settings' ? row : null]; }));
      if (signature !== null && signature !== next) changed();
      signature = next;
    }, error => { state.error = '실시간 변경 확인 실패: ' + (error.message || '연결을 확인해 주세요.'); notify(); });
  }
  function bindWorkUpdates() {
    if (!subscriptions) return;
    const query = C.workQuery(workFilters(), api.state().me, state.queryAt), size = Math.min(201, Math.max(61, state.orders.length + 1)), key = JSON.stringify([query, size]);
    if (key === watchedWorkKey) return;
    subscriptions.work?.(); watchedWorkKey = key;
    let base = api.database().collection('workOrders');
    for (const [field, op, value] of query.where) base = base.where(field, op, value);
    for (const [field, direction] of query.orderBy) base = base.orderBy(field, direction);
    subscriptions.work = watchCollection('workOrders', base.limit(size), () => load(true));
  }
  function bindReportUpdates(lightId) {
    if (!subscriptions || watchedReportId === lightId) return;
    subscriptions.reports?.(); watchedReportId = lightId;
    subscriptions.reports = watchCollection('reports', api.database().collection('reports').where('lightId', '==', lightId), () => loadReports(lightId).catch(error => { state.error = error.message; notify(); }));
  }
  function subscribeUpdates() {
    if (subscriptions) Object.values(subscriptions).forEach(stop => stop?.());
    const current = {}; subscriptions = current; watchedWorkKey = ''; watchedReportId = '';
    try {
      bindWorkUpdates();
      for (const name of ['inventory', 'settings']) current[name] = watchCollection(name, api.database().collection(name), () => load(true));
      const lightId = state.currentOrder?.lightId || state.draft?.lightId; if (lightId) bindReportUpdates(lightId);
    } catch (error) { state.error = error.message; }
    return () => { Object.values(current).forEach(stop => stop?.()); if (subscriptions === current) subscriptions = null; };
  }
  function hasActiveDraft() {
    const d = state.draft, c = state.completion;
    if (state.edit && !state.edit.cancelled && ownerForm(state.edit, 'workEdit')) return true;
    if (d && !d.cancelled && ownerForm(d, 'workDraft') && (d.pending || d.photoTasks || Q('#woTitle')?.value || Q('#woDescription')?.value || d.photos?.length)) return true;
    return !!(c && !c.cancelled && ownerForm(c, 'workCompletion') && (c.pending || c.photoTasks || Q('#woCompletionNote')?.value || c.photos?.length || c.holdDraft && JSON.stringify(c.holdDraft) !== c.holdBaseline));
  }
  function view() {
    ensure(); const rows = state.workQueryKey === filterKey() ? selectedOrders() : [], pending = state.jobs.filter(j => j.kind === 'work' && j.state !== 'synced').length;
    return '<div class="panel"><div class="split"><button class="btn sodium" data-dg="new-work"' + (!admin() || !supported() ? ' disabled' : '') + '>작업 지시 등록</button><button class="btn ghost" data-dg="refresh">새로고침</button><button class="btn ghost" data-dg="attention-work">미확인·긴급 알림함</button><button class="btn ghost" data-pm="open">정기점검 계획</button><button class="btn ghost" data-dg="work-csv">CSV</button></div>' +
      (!supported() ? '<p class="notice">작업 배정과 검수는 이 기기 저장 또는 Firebase 공유 저장에서 사용할 수 있어요.</p>' : '') +
      '<label class="f" for="woFilter">처리 상태</label><select class="f-in" id="woFilter"><option value="open"' + (state.filter === 'open' ? ' selected' : '') + '>미완료 전체</option><option value="all"' + (state.filter === 'all' ? ' selected' : '') + '>전체 기록</option>' + Object.entries(C.STATES).map(([v, t]) => '<option value="' + v + '"' + (state.filter === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>' +
      '<div class="grid2"><select class="f-in" id="woDeadline" aria-label="완료 기한">' + Object.entries({ all: '기한 전체', today: '오늘 기한 (KST)', overdue: '기한 초과' }).map(([v,t]) => '<option value="' + v + '"' + (state.deadline === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select><select class="f-in" id="woDong" aria-label="작업 대상 동">' + api.dongOptions(state.workDong) + '</select></div><label class="f"><input type="checkbox" id="woUrgent"' + (state.urgent ? ' checked' : '') + '> 긴급 작업만</label>' +
      '<label class="f"><input type="checkbox" id="woMine"' + (state.mine ? ' checked' : '') + '> 내 담당만</label><p class="muted">' + (state.loaded && state.workQueryKey === filterKey() ? sourceText(state.workMeta) + ' · 조회된 ' + rows.length + '건' + (state.hasMore ? ' · 뒤에 자료가 더 있어요' : ' · 조회 범위 끝까지 확인') : '불러오는 중…') + (pending ? ' · 저장 대기 ' + pending + '건' : '') + '</p><div class="split"><button class="btn ghost" data-dg="work-map">조건 전체 지도</button><button class="btn ghost" data-dg="work-plan">조건 전체 방문 계획</button></div><p class="muted">목록은 페이지로 읽고 지도·CSV·방문 계획은 같은 조건의 전체 작업을 조회해요. 오늘 기한은 한국 시간 기준이에요.</p></div>' +
      (state.error ? '<div class="notice" role="alert">' + E(state.error) + '</div>' : '') +
      bulkControl() + '<div class="list">' + rows.slice(0, state.show).map(workRow).join('') + '</div>' +
      (state.loaded && state.workQueryKey === filterKey() && !rows.length ? '<div class="empty">선택한 조건의 작업이 없어요.</div>' : '') + (rows.length > state.show || state.hasMore ? '<button class="btn ghost block" data-dg="more-work">다음 작업 더 보기</button>' : '');
  }
  function workRow(w) {
    const choice = admin() && supported(), picked = state.workPick.has(w.id);
    return (choice ? '<div class="dg-work-choice' + (picked ? ' picked' : '') + '"><label><input type="checkbox" data-work-pick="' + E(w.id) + '" aria-label="' + E(w.title + ' 선택') + '"' + (picked ? ' checked' : '') + (!editable(w) ? ' disabled' : '') + '></label>' : '') + '<button class="light-row dg-work-row" data-dg="open-work" data-id="' + E(w.id) + '"><span><b>' + E(w.title) + '</b><small>' + E(w.code) + ' · ' + E(label(w.assignedTo)) + '</small><small>기한 ' + time(w.dueAt) + '</small></span><span class="chip">' + E(C.STATES[w.status] || w.status) + '</span><span class="dg-priority' + (w.priority === '긴급' ? ' urgent' : '') + '">' + E(w.priority) + '</span>' + (w.dueAt && w.dueAt < Date.now() && editable(w) ? '<span class="due">기한 초과</span>' : '') + '</button>' + (choice ? '</div>' : '');
  }
  function bulkControl() {
    return admin() && supported() ? '<div class="panel dg-work-select"><span id="woPickCount">직접 선택한 작업 ' + state.workPick.size + '건</span><div class="split"><button class="btn ghost" data-dg="bulk-work"' + (!state.workPick.size ? ' disabled' : '') + '>선택 작업 일괄 수정</button><button class="btn ghost" data-dg="clear-work-pick"' + (!state.workPick.size ? ' disabled' : '') + '>선택 해제</button></div><small class="muted">화면에 보이는 작업을 하나씩 선택해요. 완료·취소 기록은 일괄 수정에서 제외해요.</small></div>' : '';
  }
  function lightMatch(value) { return (api.state().allLights || api.state().lights).find(l => l.id === value || l.code + ' [' + l.id + ']' === value); }
  function lightSuggestions(query) {
    const q = (query || '').toLowerCase();
    return api.state().lights.filter(l => !l.removed && (!q || (l.code + ' ' + l.id + ' ' + (l.address || '')).toLowerCase().includes(q))).slice(0, 50).map(l => '<option value="' + E(l.code + ' [' + l.id + ']') + '">' + E(l.address || l.dong) + '</option>').join('');
  }
  function adoptDraft(d, kind, key, exists = true) {
    d.storageId = key || (kind === 'workDraft' ? d.id : d.workId);
    d.photoTasks = 0;
    draftVersions.set(d, exists ? d.draftRevision || 0 : null);
    editorTokens.set(d, uuid('editor'));
    draftOwners.set(d, captureOwner());
    return d;
  }
  function ownerForm(d, kind) {
    const form = Q(kind === 'workDraft' ? '#woNewForm' : kind === 'workEdit' ? '#woEditForm' : '#woDetail');
    return d && form && form.dataset.editorToken === editorTokens.get(d) ? form : null;
  }
  function writeDraft(d, kind) {
    if (!d || d.cancelled || !root.DGOffline.ready) return draftWrites;
    const value = clone(d), owner = draftOwner(d);
    draftWrites = draftWrites.catch(() => {}).then(async () => {
      if (d.cancelled) return;
      requireOwner(owner);
      let key = d.storageId, expected = draftVersions.get(d);
      if (expected === undefined) expected = d.draftRevision || 0;
      try {
        const saved = await owner.offline.putIfCurrent(kind, key, { ...value, storageId: key, ...(d.recoveryOf ? { recoveryOf: d.recoveryOf } : {}) }, expected);
        requireOwner(owner);
        d.draftRevision = saved.draftRevision; draftVersions.set(d, saved.draftRevision);
      } catch (error) {
        if (error.code !== 'conflict') throw error;
        requireOwner(owner);
        // Each recovery copy still targets the original work's server revision.
        key = uuid('work-recovery');
        const saved = await owner.offline.putIfCurrent(kind, key, { ...value, storageId: key, recoveryOf: d.storageId }, null);
        requireOwner(owner);
        d.recoveryOf = d.storageId; d.storageId = key; d.draftRevision = saved.draftRevision; draftVersions.set(d, saved.draftRevision);
        api.toast('다른 탭의 변경을 유지하고 현재 내용은 별도 복구 초안에 보관했어요.');
        const form = ownerForm(d, kind); if (form) form.dataset.draftId = key;
      }
    });
    return draftWrites;
  }
  function clearWorkDraft(d, kind, options = {}) {
    if (!d) return draftWrites;
    const owner = draftOwner(d);
    d.cancelled = true;
    const key = d.storageId || (kind === 'workDraft' ? d.id : d.workId), pending = d.pending;
    if (kind === 'workDraft' && state.draft === d) state.draft = null;
    if (kind === 'workCompletion' && state.completion === d) state.completion = null;
    if (kind === 'workEdit' && state.edit === d) state.edit = null;
    draftWrites = draftWrites.catch(() => {}).then(async () => {
      if (!ownsContext(owner)) return;
      const stored = await owner.offline.get(kind, key);
      if (!ownsContext(owner)) return;
      const matching = stored && stored.pending === pending;
      if (matching) await owner.offline.removeIfCurrent(kind, key, d.draftRevision ?? stored.draftRevision ?? 0);
      if (matching && kind === 'workEdit' && options.delivered) {
        let source = d.recoverySource || stored?.recoverySource;
        const seen = new Set([key]);
        while (source && !seen.has(source.id) && ownsContext(owner)) {
          seen.add(source.id);
          const previous = await owner.offline.get('workEdit', source.id);
          if (!ownsContext(owner) || !previous || (previous.draftRevision || 0) !== source.revision) break;
          await owner.offline.removeIfCurrent('workEdit', source.id, source.revision);
          source = previous.recoverySource;
        }
      }
    });
    return draftWrites;
  }
  async function persistActive() { await persistNew(); await persistCompletion(); await persistEdit(); }
  async function newWork(lightId, reportId, resumeId) {
    if (!admin() || !supported()) return api.toast('작업 지시는 관리자와 지원되는 저장소에서 등록할 수 있어요.');
    const request = ++editorRequest, owner = captureOwner(), current = () => request === editorRequest && ownsContext(owner);
    await persistActive(); if (!current()) return;
    await load(); if (!current()) return;
    if (lightId) await loadReports(lightId); if (!current()) return;
    if (!resumeId && reportId) {
      const ids = Array.isArray(reportId) ? reportId : [reportId], linked = await linkedReport(ids);
      if (!current()) return;
      if (linked) { api.toast('이미 진행 중인 작업에 연결된 신고예요. 연결된 작업을 열어요.'); return openWork(linked.id); }
    }
    let d = resumeId ? await owner.offline.get('workDraft', resumeId) : null;
    if (!current()) return;
    if (resumeId && !d) return api.toast('이어 쓸 초안을 찾을 수 없어요. 저장 대기함을 새로고침해 주세요.');
    if (d) adoptDraft(d, 'workDraft', resumeId);
    else {
      d = { id: uuid('work'), lightId: lightId || '', title: '', description: '', type: '수리', priority: '보통', assignedTo: '', dueAt: 0, parts: [], beforePhotos: [], reportIds: Array.isArray(reportId) ? [...new Set(reportId)] : reportId ? [reportId] : [], photos: [] };
      adoptDraft(d, 'workDraft', d.id, false);
    }
    state.draft = d; if (!resumeId) await writeDraft(d, 'workDraft');
    if (current() && state.draft === d) renderNew();
  }
  function renderNew() {
    const d = state.draft, light = api.byId(d.lightId);
    const reports = light ? state.reports.filter(r => r.lightId === light.id && r.status !== '완료') : [];
    api.navigate(heading('보수 작업 지시', '시설·신고·담당자·기한을 한 작업으로 연결해요.') + '<div class="panel" id="woNewForm" data-draft-id="' + E(d.storageId) + '" data-editor-token="' + E(editorTokens.get(d)) + '"><fieldset style="border:0;padding:0;margin:0;min-width:0"' + (d.pending ? ' disabled' : '') + '>' +
      '<label class="f" for="woLight">시설 검색</label><input class="f-in" id="woLight" list="woLightChoices" autocomplete="off" placeholder="표찰 번호 또는 설치 위치 검색" value="' + E(light ? light.code + ' [' + light.id + ']' : '') + '"><datalist id="woLightChoices">' + lightSuggestions('') + '</datalist>' +
      '<label class="f" for="woTitle">작업 제목</label><input class="f-in" id="woTitle" maxlength="120" value="' + E(d.title || (light ? light.code + ' 보수' : '')) + '">' +
      '<div class="grid2"><div><label class="f" for="woType">작업 종류</label><select class="f-in" id="woType">' + options(C.TYPES, d.type) + '</select></div><div><label class="f" for="woPriority">우선순위</label><select class="f-in" id="woPriority">' + options(C.PRIORITIES, d.priority) + '</select></div></div>' +
      '<div class="grid2"><div><label class="f" for="woAssignee">담당자</label><select class="f-in" id="woAssignee">' + staffOptions(d.assignedTo) + '</select></div><div><label class="f" for="woDue">완료 기한</label><input class="f-in" type="date" id="woDue" value="' + dateInput(d.dueAt) + '"></div></div>' +
      '<label class="f" for="woDescription">작업 내용</label><textarea class="f-in" id="woDescription" maxlength="2000">' + E(d.description) + '</textarea>' +
      '<label class="f">연결할 미완료 신고</label><div id="woReportLinks">' + (reports.length ? reports.map(r => '<label class="dg-option"><input type="checkbox" data-work-report="' + E(r.id) + '"' + (d.reportIds.includes(r.id) ? ' checked' : '') + '> ' + E(r.issue + ' · ' + (r.desc || r.location || '')) + '</label>').join('') : '<p class="muted">이 시설에 연결된 미완료 신고가 없어요.</p>') + '</div>' +
      plannedEditor(d.parts || []) + '<label class="f" for="woBefore">조치 전 사진 (최대 6장)</label><input type="file" id="woBefore" accept="image/*" multiple><div id="woBeforePreview" class="pstrip">' + photoPreviews(d.photos) + '</div>' +
      '<p class="muted" id="woPhotoNotice" role="status"></p><button class="btn sodium block" data-dg="create-work">작업 지시 저장</button></fieldset><p id="woSaveState" class="muted" role="status">' + (d.pending ? '저장 대기함에서 전송 결과를 확인 중이에요. 입력은 전송 완료까지 잠겨요.' : d.recoveryOf ? '다른 탭과 내용이 달라 별도로 보관한 복구 초안이에요.' : '작업별로 초안을 자동 보관해요.') + '</p></div>', { key: 'work:new', reopen: () => renderNew() });
  }
  function readNew() {
    const d = state.draft; if (!d || d.pending || !ownerForm(d, 'workDraft')) return d;
    Object.assign(d, { title: Q('#woTitle').value, description: Q('#woDescription').value, type: Q('#woType').value, priority: Q('#woPriority').value, assignedTo: Q('#woAssignee').value, dueAt: dueValue(Q('#woDue').value), reportIds: [...document.querySelectorAll('[data-work-report]:checked')].map(x => x.dataset.workReport) });
    return d;
  }
  async function persistNew() { const d = state.draft; if (d && !d.pending && ownerForm(d, 'workDraft')) await writeDraft(readNew(), 'workDraft'); }
  function photoPreviews(photos) { return (photos || []).map(p => '<figure><img src="' + E(p.data.data) + '" alt="' + E(p.data.label) + '"><figcaption>' + E(p.data.label) + '</figcaption><button class="btn ghost sm" data-dg="remove-work-photo" data-id="' + E(p.id) + '">빼기</button></figure>').join(''); }
  async function addPhotos(files, before) {
    const source = before ? state.draft : state.completion;
    if (!source || source.pending || source.cancelled || !ownerForm(source, before ? 'workDraft' : 'workCompletion')) return;
    const workId = before ? source.id : source.workId, lightId = source.lightId, light = api.byId(lightId);
    if (!light) return api.toast('사진을 연결할 시설을 먼저 선택해 주세요.');
    const values = source.photos || (source.photos = []), existing = before ? 0 : (source.existingPhotos || []).length;
    source.photoTasks = (source.photoTasks || 0) + 1;
    try { for (const file of [...files]) {
      if (values.length + existing >= 6) { api.toast('사진은 전후 각각 최대 6장까지예요.'); break; }
      if (!file.type.startsWith('image/') || file.size > 25 * 1024 * 1024) { api.toast('25MB 이하의 이미지 파일을 선택해 주세요.'); continue; }
      const image = await api.processPhoto(file);
      if (source.cancelled || source.pending || source.lightId !== lightId) { api.toast('사진 작업이 취소되거나 시설이 바뀌었어요. 확인한 뒤 다시 첨부해 주세요.'); break; }
      if (values.length + existing >= 6) { api.toast('사진은 전후 각각 최대 6장까지예요.'); break; }
      values.push({ id: uuid('work-photo'), data: { lightId, code: light.code, dong: light.dong || '', workId, kind: 'work', data: image.data, label: before ? '조치 전' : '조치 후', note: '', w: image.w, h: image.h, at: Date.now(), by: api.state().me } });
      if (image.warning && ownerForm(source, before ? 'workDraft' : 'workCompletion') && Q('#woPhotoNotice')) Q('#woPhotoNotice').textContent = image.warning;
      await writeDraft(source, before ? 'workDraft' : 'workCompletion');
      if ((before ? state.draft : state.completion) === source) { const box = Q(before ? '#woBeforePreview' : '#woAfterPreview'); if (box) box.innerHTML = photoPreviews(values); }
    } } finally { source.photoTasks = Math.max(0, (source.photoTasks || 1) - 1); await writeDraft(source, before ? 'workDraft' : 'workCompletion'); }
  }
  function lockForm(form, locked) { const fieldset = form && form.querySelector('fieldset'); if (fieldset) fieldset.disabled = locked; }
  async function createWork(button) {
    const d = readNew(), form = ownerForm(d, 'workDraft'); if (!form || d.cancelled) return;
    const owner = draftOwner(d); requireOwner(owner);
    const light = lightMatch(Q('#woLight').value); if (!light || light.id !== d.lightId) return api.toast('목록에서 시설을 선택해 주세요.');
    if (d.pending) return api.toast('이 작업은 저장 대기함에서 처리 중이에요.');
    if (d.photoTasks) return api.toast('첨부 사진을 처리한 뒤 저장해 주세요.');
    const input = Object.fromEntries(['title', 'description', 'type', 'priority', 'assignedTo', 'dueAt', 'reportIds'].map(key => [key, clone(d[key])]));
    input.parts = clone(d.parts || []); input.workflowVersion = 2;
    input.beforePhotos = d.photos.map(p => p.id);
    C.createOrder(input, light, api.state().me, Date.now());
    const job = { id: uuid('command'), kind: 'create', workId: d.id, actor: api.state().me, at: Date.now(), light: { id: light.id, code: light.code, dong: light.dong || '' }, input, photos: clone(d.photos), draftKey: d.storageId };
    job.reportVersions = Object.fromEntries(state.reports.filter(r => input.reportIds?.includes(r.id)).map(r => [r.id, r.updatedAt || r.createdAt || null]));
    d.pending = job.id; lockForm(form, true); button.disabled = true;
    try {
      await writeDraft(d, 'workDraft'); job.draftKey = d.storageId;
      requireOwner(owner);
      const result = await submit(job, '작업 등록 · ' + input.title);
      if (!ownsContext(owner)) return;
      if (result.state === 'synced') await clearWorkDraft(d, 'workDraft');
      if (form.isConnected && Q('#woNewForm') === form) api.closeSheet();
      await load(true);
    } catch (error) {
      if (!ownsContext(owner)) throw error;
      await recoverRejected(job, d, 'workDraft', form);
      if (ownerForm(d, 'workDraft') === form && Q('#woSaveState')) Q('#woSaveState').textContent = error.message + ' 입력을 유지했어요. 연결할 신고를 다시 선택하거나 기존 작업을 확인해 주세요.';
      throw error;
    } finally { if (ownsContext(owner) && form.isConnected) { lockForm(form, !!d.pending); button.disabled = !!d.pending; } }
  }
  async function submit(job, summary) {
    if (!root.DGOffline.ready) throw new Error('저장 대기함을 준비하는 중이에요.');
    const result = await root.DGOffline.submit('work', job, { id: job.id, summary });
    if (result.state === 'synced') api.toast('저장했어요.');
    else if (result.state === 'failed' || result.state === 'conflict') throw new Error(result.error);
    else api.toast(root.DGOffline.durable ? '기기에 보관했어요. 연결되면 전송해요.' : '전송을 기다리고 있어요. 완료 전에는 이 창을 닫지 마세요.');
    await refreshQueue(); return result;
  }
  const editable = order => !!order && ['draft', 'assigned', 'in_progress', 'completed'].includes(order.status);
  async function linkedReport(ids) {
    for (const id of ids) {
      const snap = await api.database().doc('reports/' + id).get(), report = snap?.exists !== false && snap?.data();
      if (!report?.workId) continue;
      const work = await readOrder(report.workId);
      if (work && editable(work)) return work;
    }
    return null;
  }
  function plannedRows(values) {
    return values.map((part, index) => '<tr><td>' + E(part.name) + (part.inventoryId ? '<small>재고 연동</small>' : '') + '</td><td>' + part.qty + '</td><td>' + Number(part.unitCost).toLocaleString() + '</td><td><button type="button" class="btn ghost sm" data-dg="remove-planned-part" data-index="' + index + '">빼기</button></td></tr>').join('');
  }
  function plannedEditor(values) {
    return '<h3>예정 자재</h3><p class="muted">준비할 자재와 수량을 기록해요. 실제 사용량은 완료 요청에서 확인하며, 재고는 검수 승인 때만 차감돼요.</p><label class="f" for="woPlanStockPart">등록 자재</label><select class="f-in" id="woPlanStockPart"><option value="">직접 입력</option>' + state.inventory.map(item => '<option value="' + E(item.id) + '">' + E(item.name) + ' · 재고 ' + item.quantity + E(item.unit) + '</option>').join('') + '</select><label class="f" for="woPlanPartName">자재명</label><input class="f-in" id="woPlanPartName" maxlength="100"><div class="grid2"><div><label class="f" for="woPlanPartQty">예정 수량</label><input class="f-in" id="woPlanPartQty" type="number" min="0.001" step="0.001" value="1"></div><div><label class="f" for="woPlanPartCost">단가 (원)</label><input class="f-in" id="woPlanPartCost" type="number" min="0" value="0"></div></div><button type="button" class="btn ghost sm" data-dg="add-planned-part">예정 자재 추가</button><div class="dg-table"><table><thead><tr><th>자재</th><th>예정 수량</th><th>단가</th><th>관리</th></tr></thead><tbody id="woPlannedParts">' + plannedRows(values) + '</tbody></table></div>';
  }
  function readEdit() {
    const d = state.edit; if (!d || d.pending || !ownerForm(d, 'workEdit')) return d;
    Object.assign(d, { title: Q('#woEditTitle').value, description: Q('#woEditDescription').value, type: Q('#woEditType').value, priority: Q('#woEditPriority').value, assignedTo: Q('#woEditAssignee').value, dueAt: dueValue(Q('#woEditDue').value) });
    return d;
  }
  async function persistEdit() { const d = state.edit; if (d && !d.pending && ownerForm(d, 'workEdit')) await writeDraft(readEdit(), 'workEdit'); }
  async function openEdit(id, resumeId) {
    if (!admin() || !supported()) return api.toast('작업 정보는 관리자만 수정할 수 있어요.');
    const request = ++editorRequest, owner = captureOwner(), current = () => request === editorRequest && ownsContext(owner);
    await persistActive(); if (!current()) return;
    await load(); if (!current()) return;
    const order = await readOrder(id); if (!current()) return;
    const saved = await owner.offline.get('workEdit', resumeId || id); if (!current()) return;
    if (!editable(order)) return saved && order ? showEditConflict(saved, order, resumeId || id, owner) : api.toast('미완료 작업의 정보만 수정할 수 있어요.');
    if (saved && saved.expectedRevision !== order.revision) return showEditConflict(saved, order, resumeId || id, owner);
    const d = saved || editFromOrder(order);
    adoptDraft(d, 'workEdit', saved ? resumeId || id : id, !!saved);
    state.edit = d; state.editOrder = order; editConflict = null;
    if (!saved) await writeDraft(d, 'workEdit');
    if (!current()) return;
    renderEdit(d, order);
  }
  function editFromOrder(order) {
    return { workId: order.id, lightId: order.lightId, expectedRevision: order.revision, title: order.title, description: order.description || '', type: order.type, priority: order.priority, assignedTo: order.assignedTo, dueAt: order.dueAt, parts: clone(order.parts || []), orderStatus: order.status };
  }
  function renderEdit(d, order) {
    const id = order.id;
    api.navigate(heading('작업 정보 수정', order.code + ' · ' + C.STATES[order.status] + ' 상태를 유지해요.') + '<div class="panel" id="woEditForm" data-draft-id="' + E(d.storageId) + '" data-editor-token="' + E(editorTokens.get(d)) + '"><fieldset style="border:0;padding:0;margin:0;min-width:0"' + (d.pending ? ' disabled' : '') + '><label class="f" for="woEditTitle">작업 제목</label><input class="f-in" id="woEditTitle" maxlength="120" value="' + E(d.title) + '"><label class="f" for="woEditDescription">작업 내용</label><textarea class="f-in" id="woEditDescription" maxlength="2000">' + E(d.description) + '</textarea><div class="grid2"><div><label class="f" for="woEditType">작업 종류</label><select class="f-in" id="woEditType">' + options(C.TYPES, d.type) + '</select></div><div><label class="f" for="woEditPriority">우선순위</label><select class="f-in" id="woEditPriority">' + options(C.PRIORITIES, d.priority) + '</select></div></div><label class="f" for="woEditAssignee">담당자</label><select class="f-in" id="woEditAssignee"' + (order.status === 'completed' ? ' disabled' : '') + '>' + staffOptions(d.assignedTo) + '</select><label class="f" for="woEditDue">완료 기한 (비우면 기한 해제)</label><input class="f-in" type="date" id="woEditDue" value="' + dateInput(d.dueAt) + '">' + (order.status !== 'completed' ? plannedEditor(d.parts || []) : '<p class="muted">검수 대기 중인 작업의 담당자와 실제 자재 내역은 보완 요청 후 변경할 수 있어요.</p>') + '<button class="btn sodium block" data-dg="save-work-edit">정보 수정 저장</button></fieldset><p class="muted" id="woEditState" role="status">' + (d.pending ? '저장 대기함에서 전송 결과를 확인 중이에요.' : '입력 내용을 자동 보관해요. 시설·신고·사진·처리 상태는 유지돼요.') + '</p><button class="btn ghost block" data-dg="open-work" data-id="' + E(id) + '">작업 상세 확인</button></div>', { key: 'work:edit:' + id, reopen: () => openEdit(id, d.storageId) });
  }
  function showEditConflict(saved, order, key, owner) {
    if (!ownsContext(owner)) return;
    const token = uuid('work-edit-compare');
    editConflict = { token, saved: clone(saved), order: clone(order), key, owner };
    state.edit = null;
    const fields = [['title', '제목'], ['description', '작업 내용'], ['type', '종류'], ['priority', '우선순위'], ['assignedTo', '담당자'], ['dueAt', '완료 기한'], ['parts', '자재 내역']];
    const value = (record, field) => field === 'assignedTo' ? label(record[field]) : field === 'dueAt' ? time(record[field]) : field === 'parts' ? (record.parts || []).map(part => part.name + ' · ' + part.qty + ' × ' + part.unitCost + '원').join('\n') || '없음' : String(record[field] || '없음');
    const rows = fields.map(([field, title]) => { const previous = value(saved, field), latest = value(order, field); return '<tr><th scope="row">' + E(title) + (previous !== latest ? '<small class="dg-conflict">다름</small>' : '') + '</th><td class="dg-pre">' + E(previous) + '</td><td class="dg-pre">' + E(latest) + '</td></tr>'; }).join('');
    api.navigate(heading('이전 입력과 최신 작업 비교', order.code + ' · 현재 ' + C.STATES[order.status]) + '<div class="panel" id="woEditConflict" data-token="' + E(token) + '"><p class="notice">작성한 뒤 작업이 변경됐어요. 보관된 입력과 최신 내용을 비교해 주세요. 이전 입력으로 이어 수정하면 아래의 이전 값들을 새 수정안으로 사용하며, 저장하기 전까지 실제 작업에는 반영되지 않아요.</p><div class="dg-table"><table><thead><tr><th>항목</th><th>보관된 이전 입력</th><th>최신 저장 내용</th></tr></thead><tbody>' + rows + '</tbody></table></div><p class="muted">이전 초안은 새 수정안이 저장될 때까지 유지해요.' + (order.status === 'completed' ? ' 검수 대기 작업의 실제 자재 내역은 최신 내용을 유지해요.' : '') + (!editable(order) ? ' 완료·취소된 작업은 현재 상태에서 수정할 수 없어요.' : '') + '</p><div class="split"><button class="btn sodium" data-dg="resume-stale-work-edit"' + (!editable(order) ? ' disabled' : '') + '>이전 입력으로 이어 수정</button><button class="btn ghost" data-dg="edit-latest-work"' + (!editable(order) ? ' disabled' : '') + '>최신 내용으로 새로 수정</button><button class="btn ghost" data-dg="open-work" data-id="' + E(order.id) + '">작업 상세 확인</button></div></div>', { key: 'work:compare:' + order.id, reopen: () => openEdit(order.id, key) });
  }
  async function resumeStaleEdit(previousValues) {
    const comparison = editConflict, form = Q('#woEditConflict');
    if (!comparison || !form || form.dataset.token !== comparison.token || !ownsContext(comparison.owner)) return;
    const request = ++editorRequest, { owner, key } = comparison;
    const current = () => editConflict === comparison && request === editorRequest && ownsContext(owner) && form.isConnected;
    const order = await readOrder(comparison.order.id); if (!current()) return;
    const saved = await owner.offline.get('workEdit', key); if (!current()) return;
    if (!saved) return api.toast('이전 초안이 정리됐어요. 저장 대기함을 새로고침해 주세요.');
    if (order?.revision !== comparison.order.revision || (saved.draftRevision || 0) !== (comparison.saved.draftRevision || 0)) return openEdit(comparison.order.id, key);
    if (!editable(order)) return openEdit(order.id, key);
    if (saved.pending) {
      const jobs = await owner.offline.jobs(); if (!current()) return;
      if (jobs.some(job => job.id === saved.pending && job.state !== 'synced')) return api.toast('이전 초안의 저장 대기 작업을 먼저 확인하거나 폐기해 주세요.');
    }
    const sourceRevision = saved.draftRevision || 0, recoveryKey = 'work-edit-recovery:' + key + ':d' + sourceRevision + ':r' + order.revision + ':' + (previousValues ? 'previous' : 'latest');
    const existing = await owner.offline.get('workEdit', recoveryKey); if (!current()) return;
    const d = existing || editFromOrder(order);
    if (!existing && previousValues) for (const field of ['title', 'description', 'type', 'priority', 'assignedTo', 'dueAt', ...(order.status === 'completed' ? [] : ['parts'])]) if (saved[field] !== undefined) d[field] = clone(saved[field]);
    d.recoverySource = { id: key, revision: sourceRevision };
    adoptDraft(d, 'workEdit', recoveryKey, !!existing);
    state.edit = d; state.editOrder = order;
    if (!existing) await writeDraft(d, 'workEdit');
    if (!current()) return;
    editConflict = null;
    renderEdit(d, order);
  }
  async function recoverRejected(job, d, kind, form) {
    const owner = draftOwner(d); if (!ownsContext(owner)) return;
    const queued = (await owner.offline.jobs().catch(() => [])).find(row => row.id === job.id);
    if (!ownsContext(owner)) return;
    if (queued?.state === 'conflict') { await owner.offline.discard(job.id); if (!ownsContext(owner)) return; }
    if (!queued || queued.state === 'conflict') { d.pending = null; delete d.process; await writeDraft(d, kind).catch(() => {}); if (form.isConnected) lockForm(form, false); }
  }
  async function saveEdit(button) {
    const d = readEdit(), form = ownerForm(d, 'workEdit'), order = state.editOrder;
    if (!form || d.pending || !order || order.id !== d.workId) return;
    const owner = draftOwner(d); requireOwner(owner);
    const request = editorRequest;
    const input = Object.fromEntries(['title', 'description', 'type', 'priority', 'assignedTo', 'dueAt'].map(key => [key, d[key]]));
    input.expectedRevision = d.expectedRevision;
    if (order.status !== 'completed') input.parts = clone(d.parts || []);
    C.updateOrder(order, input, api.state().me, admin(), Date.now());
    const job = { id: uuid('work-update'), kind: 'update', workId: d.workId, actor: api.state().me, at: Date.now(), input, draftKey: d.storageId };
    d.pending = job.id; lockForm(form, true);
    try {
      await writeDraft(d, 'workEdit'); job.draftKey = d.storageId;
      requireOwner(owner);
      const result = await submit(job, '작업 정보 수정 · ' + d.title);
      if (!ownsContext(owner)) return;
      if (result.state === 'synced') { await clearWorkDraft(d, 'workEdit', { delivered: true }); await load(true); if (request === editorRequest && form.isConnected && Q('#woEditForm') === form) await openWork(d.workId); }
      else if (form.isConnected && Q('#woEditState')) Q('#woEditState').textContent = '저장 대기함에서 전송 결과를 확인해 주세요.';
    } catch (error) {
      if (!ownsContext(owner)) throw error;
      await recoverRejected(job, d, 'workEdit', form);
      if (ownerForm(d, 'workEdit') === form && Q('#woEditState')) Q('#woEditState').textContent = error.message + ' 입력은 유지했어요. 작업 상세에서 최신 내용을 확인해 주세요.';
      throw error;
    } finally { if (ownsContext(owner) && form.isConnected) { lockForm(form, !!d.pending); button.disabled = !!d.pending; } }
  }
  function bulkResults(batch) {
    return batch.results.map(row => '<div class="hist"><b>' + E(row.title) + '</b><p>' + E(row.result) + '</p><button class="btn ghost sm" data-dg="open-work" data-id="' + E(row.id) + '">작업 상세 확인</button></div>').join('');
  }
  async function openBulk() {
    if (!admin() || !supported() || !state.workPick.size) return api.toast('수정할 작업을 목록에서 선택해 주세요.');
    await persistActive();
    const batch = state.bulk = { actor: api.state().me, namespace: root.DGOffline.namespace, orders: [...state.workPick.values()].map(clone), results: [], pending: false };
    api.navigate(heading('선택 작업 일괄 수정', batch.orders.length + '건 · 담당자 지정 시 배정 대기는 배정 처리해요.') + '<div class="panel" id="woBulkForm"><fieldset style="border:0;padding:0;margin:0;min-width:0"><p>' + batch.orders.map(order => E(order.title)).join('<br>') + '</p><label class="f" for="woBulkAssignee">담당자</label><select class="f-in" id="woBulkAssignee"><option value="__keep__">변경하지 않음</option>' + staffOptions('') + '</select><label class="f" for="woBulkPriority">우선순위</label><select class="f-in" id="woBulkPriority"><option value="">변경하지 않음</option>' + options(C.PRIORITIES, '') + '</select><label class="f" for="woBulkDueMode">완료 기한</label><select class="f-in" id="woBulkDueMode"><option value="keep">변경하지 않음</option><option value="set">날짜 지정</option><option value="clear">기한 해제</option></select><label class="f" for="woBulkDue">지정할 날짜</label><input class="f-in" type="date" id="woBulkDue"><p class="muted">선택한 버전으로 작업별 저장해요. 충돌한 작업은 상세를 확인하고 목록에서 다시 선택해 주세요.</p><button class="btn sodium block" data-dg="save-bulk-work">선택 작업에 적용</button></fieldset><div id="woBulkResults" role="status"></div></div>', { key: 'work:bulk', reopen: () => openBulk() });
  }
  async function saveBulk(button) {
    const batch = state.bulk, form = Q('#woBulkForm'); if (!batch || batch.pending || !form || !admin()) return;
    const input = {}, assignee = Q('#woBulkAssignee').value, priority = Q('#woBulkPriority').value, dueMode = Q('#woBulkDueMode').value;
    if (assignee !== '__keep__') input.assignedTo = assignee;
    if (priority) input.priority = priority;
    if (dueMode === 'clear') input.dueAt = 0;
    if (dueMode === 'set') { if (!Q('#woBulkDue').value) throw new Error('완료 기한 날짜를 선택해 주세요.'); input.dueAt = dueValue(Q('#woBulkDue').value); }
    if (!Object.keys(input).length) throw new Error('변경할 담당자·기한·우선순위 중 하나를 선택해 주세요.');
    batch.pending = true; batch.results = []; lockForm(form, true);
    try {
      for (const order of batch.orders) {
        if (batch.actor !== api.state().me || batch.namespace !== root.DGOffline.namespace) throw new Error('계정이 바뀌어 나머지 작업을 중단했어요.');
        const job = { id: uuid('work-bulk'), kind: order.status === 'draft' && input.assignedTo ? 'assign' : 'update', workId: order.id, actor: batch.actor, at: Date.now(), input: { ...input, expectedRevision: order.revision } };
        let result;
        try {
          C.updateOrder(order, job.input, batch.actor, admin(), job.at);
          result = await submit(job, '일괄 정보 수정 · ' + order.title);
          batch.results.push({ id: order.id, title: order.title, result: result.state === 'synced' ? '저장 완료' : '저장 대기함에 보관 · 전송 결과 확인 필요' });
          state.workPick.delete(order.id);
        } catch (error) { batch.results.push({ id: order.id, title: order.title, result: '미반영 · 충돌 또는 입력 확인: ' + error.message }); }
        if (state.bulk === batch && form.isConnected && Q('#woBulkResults')) Q('#woBulkResults').innerHTML = bulkResults(batch);
      }
      await load(true);
    } finally { batch.pending = false; if (form.isConnected) { lockForm(form, true); button.disabled = true; } }
  }
  function partRows(values) {
    return (values || []).map((p, i) => '<tr><td>' + E(p.name) + (p.inventoryId ? '<small>재고 연동</small>' : '') + '</td><td>' + p.qty + '</td><td>' + p.unitCost.toLocaleString() + '</td><td><button class="btn ghost sm" data-dg="remove-part" data-index="' + i + '">삭제</button></td></tr>').join('');
  }
  function codeOptions(values, selected) { return '<option value="">선택해 주세요</option>' + Object.entries(values).map(([key, value]) => '<option value="' + E(key) + '"' + (key === selected ? ' selected' : '') + '>' + E(value) + '</option>').join(''); }
  function causeActionControls(draft) { return '<div class="grid2"><div><label class="f" for="woDiagnosis">고장 원인 (필수)</label><select class="f-in" id="woDiagnosis">' + codeOptions(C.DIAGNOSES, draft.diagnosis) + '</select></div><div><label class="f" for="woRepairAction">조치 유형 (필수)</label><select class="f-in" id="woRepairAction">' + codeOptions(C.REPAIR_ACTIONS, draft.repairAction) + '</select></div></div>'; }
  function defaultHold(order) { return { reason: order.hold?.reason || 'material', note: order.hold?.note || '', nextAt: dueValue(dateInput(order.hold?.nextAt || Date.now() + 86400000)), nextAction: order.hold?.nextAction || '' }; }
  function processControls(order) {
    const active = ['assigned', 'in_progress'].includes(order.status), allowed = active && (admin() || order.assignedTo === api.state().me), draft = state.completion;
    if (!active && !order.acknowledgedAt && !order.hold) return '';
    const held = draft?.holdDraft || defaultHold(order); if (draft) draft.holdBaseline = JSON.stringify(defaultHold(order));
    return '<div class="panel dg-process"><h3>담당 확인과 보류</h3><p>배정 확인 ' + (order.acknowledgedAt && order.acknowledgedBy === order.assignedTo ? time(order.acknowledgedAt) : '미확인') + '</p>' + (active && order.assignedTo === api.state().me && (!order.acknowledgedAt || order.acknowledgedBy !== order.assignedTo) ? '<button class="btn sodium sm" data-dg="acknowledge-work">배정 확인했어요</button>' : '') + (order.hold ? '<p class="notice"><b>보류 · ' + E(C.HOLD_REASONS[order.hold.reason]) + '</b><br>' + E(order.hold.note) + '<br>다음 확인 ' + time(order.hold.nextAt) + '<br>다음 할 일: ' + E(order.hold.nextAction) + '</p>' + (allowed ? '<button class="btn sodium sm" data-dg="resume-work">보류 해제</button>' : '') : '') + (allowed ? '<details><summary>' + (order.hold ? '보류 내용 수정' : '작업 보류 기록') + '</summary><label class="f" for="woHoldReason">보류 사유</label><select class="f-in" id="woHoldReason">' + Object.entries(C.HOLD_REASONS).map(([key, label]) => '<option value="' + key + '"' + (key === held.reason ? ' selected' : '') + '>' + E(label) + '</option>').join('') + '</select><label class="f" for="woHoldNote">상세 사유</label><input class="f-in" id="woHoldNote" maxlength="500" value="' + E(held.note) + '"><label class="f" for="woHoldNext">다음 확인일</label><input class="f-in" id="woHoldNext" type="date" value="' + dateInput(held.nextAt) + '"><label class="f" for="woHoldAction">다음 할 일</label><input class="f-in" id="woHoldAction" maxlength="500" value="' + E(held.nextAction) + '"><p class="muted">보류해도 원래 완료 기한과 기한 초과 기록은 유지돼요.</p><button class="btn ghost" data-dg="hold-work">보류 저장</button></details>' : '') + '</div>';
  }
  async function processWork(action, button) {
    const order = state.currentOrder, d = state.completion, form = ownerForm(d, 'workCompletion'); if (!order || !form || d.pending) return;
    const owner = draftOwner(d), request = editorRequest; requireOwner(owner);
    const input = { expectedRevision: order.revision };
    if (action === 'hold') Object.assign(input, { reason: Q('#woHoldReason').value, note: Q('#woHoldNote').value, nextAt: dueValue(Q('#woHoldNext').value), nextAction: Q('#woHoldAction').value });
    C.workProcess(order, action, input, owner.actor, admin(), Date.now());
    await persistCompletion(); if (!ownsContext(owner) || ownerForm(d, 'workCompletion') !== form || state.currentOrder !== order) return;
    const job = { id: uuid('work-process'), kind: action, workId: order.id, actor: owner.actor, at: Date.now(), input, draftKey: d.storageId, note: action === 'hold' ? '보류 · ' + C.HOLD_REASONS[input.reason] + ' · ' + input.nextAction : action === 'resume' ? '보류 해제' : '배정 수신 확인' };
    d.pending = job.id; d.process = { kind: action, expectedRevision: order.revision }; lockForm(form, true); button.disabled = true;
    try { await writeDraft(d, 'workCompletion'); job.draftKey = d.storageId; requireOwner(owner); const result = await submit(job, job.note); if (result.state === 'synced') { await finishProcessDraft(job, d); if (!ownsContext(owner)) return; await load(true); if (request === editorRequest && form.isConnected) await openWork(order.id); } }
    catch (error) { if (ownsContext(owner)) await recoverRejected(job, d, 'workCompletion', form); throw error; }
    finally { if (ownsContext(owner) && form.isConnected) { lockForm(form, !!d.pending); button.disabled = !!d.pending; } }
  }
  function finishProcessDraft(job, original) {
    if (processSettlements.has(job.id)) return processSettlements.get(job.id);
    const task = (async () => {
      const owner = captureOwner();
      if (job.actor && job.actor !== owner.actor) return;
      let d = original || (state.completion?.pending === job.id ? state.completion : null);
      if (d && !ownsContext(draftOwner(d))) return;
      if (!d) { const saved = await owner.offline.get('workCompletion', job.draftKey || job.workId); if (!ownsContext(owner) || !saved || saved.pending !== job.id) return; d = adoptDraft(saved, 'workCompletion', job.draftKey || job.workId); }
      if (!ownsContext(owner) || d.pending !== job.id) return;
      const work = await readOrder(job.workId); if (!ownsContext(owner) || d.pending !== job.id || !work) return;
      const preserve = d.note?.trim() || d.diagnosis || d.repairAction || d.photos?.length || JSON.stringify(d.parts || []) !== JSON.stringify(work.parts || []) || JSON.stringify(d.measurements || []) !== JSON.stringify(work.measurements || []) || job.kind === 'acknowledge' && d.holdDraft && JSON.stringify(d.holdDraft) !== d.holdBaseline;
      if (!preserve) return clearWorkDraft(d, 'workCompletion', { delivered: true });
      d.pending = null; delete d.process;
      if (work.revision === job.input.expectedRevision + 1) {
        d.expectedRevision = work.revision;
        if (job.kind !== 'acknowledge') { d.holdDraft = defaultHold(work); d.holdBaseline = JSON.stringify(d.holdDraft); }
      } else api.toast('입력한 조치 내용은 초안으로 유지했어요. 작업이 추가 변경되어 최신 기록을 확인해 주세요.');
      await writeDraft(d, 'workCompletion');
    })();
    processSettlements.set(job.id, task); task.then(() => processSettlements.delete(job.id), () => processSettlements.delete(job.id)); return task;
  }
  async function openAttention() {
    const request = ++editorRequest, owner = captureOwner(), gen = api.navGen?.(), current = () => request === editorRequest && ownsContext(owner) && (gen == null || api.navAlive(gen));
    await persistActive(); if (!current()) return;
    let rows = [], metadata, error = '';
    try { rows = await api.readAll('workOrders', { where: [['status', 'in', ['draft', 'assigned', 'in_progress', 'completed']], ...(!admin() ? [['assignedTo', '==', owner.actor]] : [])], requireServer: !!api.firebase(), onMetadata: value => { metadata = value; } }); } catch (e) { error = e.message; }
    if (!current()) return;
    const items = C.attentionItems(rows, owner.actor, admin(), Date.now());
    api.navigate(heading('미확인·긴급 알림함', admin() ? '조회 권한 내 전체 미완료 작업' : '내 담당 미완료 작업') + '<div id="woAttention"><div class="panel"><p>배정 미확인·긴급·기한 임박/초과·보류 확인일을 모아 보여요. 앱 밖의 알림 발송은 별도 운영 연결이 필요해요.</p><p class="muted">' + E(sourceText(metadata)) + ' · 대상 ' + items.length + '건</p><button class="btn ghost" data-dg="attention-work">다시 조회</button></div>' + (error ? '<p class="notice" role="alert">' + E(error) + ' 전체 자료를 확인하지 못했어요. 다시 조회해 주세요.</p>' : items.map(item => '<button class="light-row" data-dg="open-work" data-id="' + E(item.id) + '"><b>' + E(item.title) + '</b><small>' + E(item.reasons.join(' · ')) + '</small><small>' + E(label(item.assignedTo)) + ' · 기한 ' + time(item.dueAt) + '</small></button>').join('') || '<p class="empty">현재 확인할 알림이 없어요.</p>') + '</div>', { key: 'work:attention', reopen: openAttention });
  }
  // Parts and measurements are also edited by administrators. A completion draft records the values it
  // started from, so carrying it to a newer revision can tell who changed what: values the worker did not
  // touch follow the latest work, and values the worker entered are kept (they record what was actually
  // used) but flagged for review when the administrator changed them too or the draft predates baselines.
  const fieldBaselines = order => ({ partsBaseline: JSON.stringify(order.parts || []), measurementsBaseline: JSON.stringify(order.measurements || []) });
  function carryFieldValues(d, order) {
    let review = false;
    for (const [key, baseKey] of [['parts', 'partsBaseline'], ['measurements', 'measurementsBaseline']]) {
      const mine = JSON.stringify(d[key] || []), latest = JSON.stringify(order[key] || []), base = d[baseKey];
      if (mine === latest) continue;
      if (typeof base === 'string' && mine === base) d[key] = clone(order[key] || []);
      else if (typeof base !== 'string' || latest !== base) review = true;
    }
    Object.assign(d, fieldBaselines(order)); return review;
  }
  async function openWork(id, resumeId, navigation = {}) {
    const owned = () => !navigation.isCurrent || navigation.isCurrent();
    if (!owned()) return;
    const gen = api.navGen ? api.navGen() : null, alive = () => gen === null || api.navAlive(gen);
    const request = ++editorRequest, owner = captureOwner(), current = () => request === editorRequest && owned() && alive() && ownsContext(owner);
    await persistActive(); if (!current()) return;
    await load(); if (!current()) return;
    const order = await readOrder(id); if (!current()) return;
    if (!order) return api.toast('작업을 찾을 수 없어요. 새로고침해 주세요.');
    await loadReports(order.lightId); if (!current()) return;
    const oldCompletion = root.DGOffline.ready && await root.DGOffline.get('workCompletion', resumeId || id);
    if (!current()) return;
    state.currentOrder = JSON.parse(JSON.stringify(order));
    state.lightVersion = (api.byId(order.lightId) || {}).updatedAt || null;
    state.reportVersions = Object.fromEntries((order.reportIds || []).map(reportId => { const r = state.reports.find(x => x.id === reportId); return [reportId, r && (r.updatedAt || r.createdAt || null)]; }));
    const token = ++detailToken;
    // An administrator edit (due date, priority, …) raises the revision while field input is unsent. Carry
    // that input onto the latest revision in place, unless a submitted command still owns the draft or the
    // work has left the field stages; the completion is still validated against the latest work on submit.
    const rebased = oldCompletion && oldCompletion.expectedRevision !== order.revision && !oldCompletion.pending && ['assigned', 'in_progress'].includes(order.status) && order.assignedTo === owner.actor;
    let reviewParts = false;
    if (rebased) { delete oldCompletion.process; reviewParts = carryFieldValues(oldCompletion, order); Object.assign(oldCompletion, { lightId: order.lightId, expectedRevision: order.revision, existingPhotos: order.afterPhotos || [] }); }
    state.completion = oldCompletion && oldCompletion.expectedRevision === order.revision ? oldCompletion : { workId: id, lightId: order.lightId, expectedRevision: order.revision, photos: [], existingPhotos: order.afterPhotos || [], parts: order.parts || [], measurements: order.measurements || [], ...fieldBaselines(order), note: order.completionNote || '', diagnosis: order.diagnosis || '', repairAction: order.repairAction || '' };
    const completion = adoptDraft(state.completion, 'workCompletion', oldCompletion && oldCompletion.expectedRevision === order.revision ? resumeId || id : id, !!(oldCompletion && oldCompletion.expectedRevision === order.revision));
    if (oldCompletion && oldCompletion.expectedRevision !== order.revision) {
      completion.storageId = uuid('completion'); draftVersions.set(completion, null);
      api.toast('작업 버전이 바뀌었어요. 이전 초안은 대기함에 남기고 최신 작업을 열었어요.');
    }
    if (rebased) {
      // The carried draft is already in memory; a storage failure must not keep the work from opening.
      try { await writeDraft(completion, 'workCompletion'); } catch (error) { if (current()) api.toast('기기에 초안을 저장하지 못했어요. 화면의 입력은 유지돼요. ' + error.message); }
      if (!current()) return;
      api.toast(reviewParts ? '작업 정보가 바뀌었어요. 조치 내용과 사진은 최신 작업에 옮겼어요. 관리자가 바꾼 예정 자재·측정값이 있어 입력한 값을 유지했으니, 사용 자재를 확인한 뒤 요청해 주세요.' : '작업 정보(담당·기한·자재 등)가 바뀌었어요. 입력한 조치 내용과 사진은 최신 작업에 옮겼으니 확인 후 요청해 주세요.');
    }
    const allowed = C.actions(order, api.state().me, admin());
    api.navigate(heading(order.title, order.code + ' · ' + C.STATES[order.status]) + '<div class="panel dg-work-detail" id="woDetail" data-draft-id="' + E(completion.storageId) + '" data-editor-token="' + E(editorTokens.get(completion)) + '"><fieldset style="border:0;padding:0;margin:0;min-width:0"' + (completion.pending ? ' disabled' : '') + '>' +
      '<p>' + E(order.description || '추가 작업 내용 없음') + '</p><p><b>담당</b> ' + E(label(order.assignedTo)) + ' · <b>기한</b> ' + time(order.dueAt) + ' · <b>우선순위</b> ' + E(order.priority) + '</p>' +
      (admin() && editable(order) ? '<button class="btn ghost sm" data-dg="edit-work" data-id="' + E(id) + '">작업 정보 수정</button>' : '') + '<button class="btn ghost sm" data-light="' + E(order.lightId) + '">시설 점검 열기</button><h3>조치 전·후 증빙</h3><div id="woEvidence" class="pstrip" aria-live="polite">사진 불러오는 중…</div>' +
      (state.reportMeta?.[order.lightId]?.source === 'prepared' ? '<p class="notice" id="woPreparedReports">출동 준비자료 · 준비 ' + time(state.reportMeta[order.lightId].preparedAt) + '<br>신고 범위: 이 시설의 미완료·작업 연결 신고. 준비 이후의 변경과 서버 전체 자료는 온라인에서 다시 확인해 주세요.</p>' : '') +
      processControls(order) +
      (order.completionNote ? '<h3>조치 내용</h3><p class="dg-pre">' + E(order.completionNote) + '</p><p>원인 ' + E(C.DIAGNOSES[order.diagnosis] || '이전 기록 · 미분류') + ' · 조치 ' + E(C.REPAIR_ACTIONS[order.repairAction] || '미분류') + '</p>' : '') +
      ((order.parts || []).length ? '<h3>' + (['draft', 'assigned', 'in_progress'].includes(order.status) ? '예정 자재' : '기록한 사용 자재') + '</h3><div class="dg-table"><table><thead><tr><th>자재</th><th>수량</th><th>단가 (원)</th></tr></thead><tbody>' + order.parts.map(part => '<tr><td>' + E(part.name) + (part.inventoryId ? '<small>재고 연동</small>' : '') + '</td><td>' + E(part.qty) + '</td><td>' + Number(part.unitCost).toLocaleString() + '</td></tr>').join('') + '</tbody></table></div>' : '') + '<p>' + (['draft', 'assigned', 'in_progress'].includes(order.status) ? '예정 자재 비용 ' : '자재 비용 ') + Number(order.costTotal || 0).toLocaleString() + '원</p>' + (order.measurements || []).map(m => '<p>실측 조도 ' + E(m.lux) + ' lux · ' + time(m.at) + ' · ' + E(m.note) + '</p>').join('') +
      (order.verificationNote ? '<p class="notice">검수 의견: ' + E(order.verificationNote) + '</p>' : '') +
      (admin() && allowed.includes('assigned') ? '<label class="f" for="woReassign">담당자</label><select class="f-in" id="woReassign">' + staffOptions(order.assignedTo) + '</select><label class="f" for="woNewDue">완료 기한</label><input class="f-in" type="date" id="woNewDue" value="' + dateInput(order.dueAt) + '">' : '') +
      (allowed.includes('completed') ? '<h3>작업 완료 요청</h3>' + causeActionControls(completion) + '<label class="f" for="woCompletionNote">조치 내용</label><textarea class="f-in" id="woCompletionNote" maxlength="2000">' + E(completion.note) + '</textarea><label class="f" for="woAfter">조치 후 사진 (필수, 최대 6장)</label><input type="file" id="woAfter" accept="image/*" multiple><div id="woAfterPreview" class="pstrip">' + photoPreviews(completion.photos) + '</div><p id="woPhotoNotice" class="muted" role="status"></p>' +
      '<h3>사용 자재</h3><div class="grid2"><select class="f-in" id="woStockPart" aria-label="등록 자재"><option value="">직접 입력</option>' + state.inventory.map(p => '<option value="' + E(p.id) + '">' + E(p.name) + ' · 재고 ' + p.quantity + E(p.unit) + '</option>').join('') + '</select><input class="f-in" id="woPartName" placeholder="자재명" aria-label="자재명"></div><div class="grid2"><input class="f-in" id="woPartQty" type="number" min="0.001" step="0.001" value="1" aria-label="사용 수량"><input class="f-in" id="woPartCost" type="number" min="0" value="0" aria-label="단가(원)"></div><button class="btn ghost sm" data-dg="add-part">자재 추가</button><div class="dg-table"><table><thead><tr><th>자재</th><th>수량</th><th>단가</th><th>관리</th></tr></thead><tbody id="woParts">' + partRows(completion.parts) + '</tbody></table></div><p class="muted">재고 연동 자재는 관리자의 완료 검수 시 출고돼요.</p>' +
      '<h3>조도계 실측 (선택)</h3><div class="grid2"><input class="f-in" id="woLux" type="number" min="0" max="200000" step="0.1" placeholder="lux" aria-label="실측 조도"><input class="f-in" id="woLuxNote" maxlength="300" placeholder="측정 위치·기기·조건" aria-label="실측 조건"></div><button class="btn ghost sm" data-dg="add-lux">실측 추가</button><div id="woMeasurements">' + measureRows(completion.measurements) + '</div><p class="muted">조도계로 측정한 값을 입력해요. 지도 밝기 예측과 별도로 보관돼요.</p>' : '') +
      (admin() && order.status === 'completed' ? '<h3>완료 검수</h3><label class="f" for="woVerification">검수 의견 / 보완 사유</label><textarea class="f-in" id="woVerification" maxlength="2000"></textarea><label class="f" for="woFacilityStatus">검수 후 시설 상태</label><select class="f-in" id="woFacilityStatus"><option value="">현재 시설 상태 유지</option>' + options(['정상', '점검필요', '고장', '수리중'], '') + '</select><label class="f"><input type="checkbox" id="woCloseReports"> 연결된 신고도 완료 처리하고 연락처 삭제</label>' : '') +
      '<div class="split">' + allowed.map(target => '<button class="btn' + (target === 'cancelled' ? ' ghost' : ' sodium') + '" data-dg="transition-work" data-id="' + E(id) + '" data-status="' + target + '">' + E({ assigned: '담당 배정', in_progress: order.status === 'completed' ? '보완 요청' : '작업 시작', completed: '완료 검수 요청', verified: '검수 승인', cancelled: '작업 취소', draft: '배정 대기로 복원' }[target]) + '</button>').join('') + '</div></fieldset></div><h3>처리 이력</h3><div id="woEvents" class="panel" aria-live="polite">불러오는 중…</div>', { key: 'work:' + id, reopen: () => openWork(id, resumeId) });
    const detail = Q('#woDetail'), detailCurrent = () => request === editorRequest && token === detailToken && detail?.isConnected && Q('#woDetail') === detail;
    const evidence = [...(order.beforePhotos || []), ...(order.afterPhotos || [])];
    const results = await Promise.allSettled(evidence.map(async photoId => { const photo = await api.getPhoto(photoId), src = photo && root.DGSecurity.safeImageSrc(photo.data); return src ? '<figure><img src="' + E(src) + '" alt="' + E(photo.label || '작업 사진') + '"><figcaption>' + E(photo.label) + '</figcaption></figure>' : '<p class="notice">원본 사진을 확인할 수 없어요.</p>'; }));
    if (!detailCurrent() || !Q('#woEvidence')) return;
    Q('#woEvidence').innerHTML = results.length ? results.map(r => r.status === 'fulfilled' ? r.value : '<p class="notice">사진 조회 실패</p>').join('') : '<span class="muted">첨부 사진 없음</span>';
    try { const events = await api.readAll('workEvents', { where: [['workId', '==', id]], orderBy: [['at', 'desc']] }); if (detailCurrent() && Q('#woEvents')) Q('#woEvents').innerHTML = events.map(e => '<p><b>' + E(C.STATES[e.toStatus] || e.type) + '</b> · ' + time(e.at) + ' · ' + E(label(e.by)) + (e.note ? '<br>' + E(e.note) : '') + '</p>').join('') || '처리 이력이 없어요.'; }
    catch (error) { if (detailCurrent() && Q('#woEvents')) Q('#woEvents').textContent = '처리 이력을 불러오지 못했어요.'; }
  }
  function measureRows(values) { return values.map((m, i) => '<p>' + m.lux + ' lux · ' + E(m.note) + ' <button class="btn ghost sm" data-dg="remove-lux" data-index="' + i + '">삭제</button></p>').join(''); }
  async function persistCompletion() {
    const d = state.completion; if (!d || d.pending || !ownerForm(d, 'workCompletion')) return;
    if (Q('#woHoldReason')) d.holdDraft = { reason: Q('#woHoldReason').value, note: Q('#woHoldNote').value, nextAt: dueValue(Q('#woHoldNext').value), nextAction: Q('#woHoldAction').value };
    if (Q('#woCompletionNote')) { d.note = Q('#woCompletionNote').value; d.diagnosis = Q('#woDiagnosis')?.value || ''; d.repairAction = Q('#woRepairAction')?.value || ''; }
    else if (!d.holdDraft || JSON.stringify(d.holdDraft) === d.holdBaseline) return;
    await writeDraft(d, 'workCompletion');
  }
  async function transitionWork(button) {
    const order = state.currentOrder, d = state.completion, form = ownerForm(d, 'workCompletion');
    if (!order || order.id !== button.dataset.id || !form || d.pending) return;
    const owner = draftOwner(d); requireOwner(owner);
    if (d.photoTasks) return api.toast('첨부 사진을 처리한 뒤 저장해 주세요.');
    const target = button.dataset.status;
    if (Q('#woCompletionNote')) await persistCompletion();
    if (!ownsContext(owner) || ownerForm(d, 'workCompletion') !== form || state.currentOrder !== order) return;
    const input = { expectedRevision: order.revision, ...(Q('#woReassign') ? { assignedTo: Q('#woReassign').value, dueAt: dueValue(Q('#woNewDue').value) } : {}),
      completionNote: d.note, afterPhotos: [...(d.existingPhotos || []), ...d.photos.map(p => p.id)],
      parts: clone(d.parts), measurements: clone(d.measurements), verificationNote: Q('#woVerification') ? Q('#woVerification').value : '', ...(target === 'completed' && Q('#woDiagnosis') ? { diagnosis: d.diagnosis, repairAction: d.repairAction } : {}) };
    C.transition(order, target, input, api.state().me, admin(), Date.now());
    if (['cancelled', 'verified'].includes(target) && !await ask(target === 'verified' ? '조치 후 원본 사진과 조치 내용을 확인했나요? 검수 승인 시 연결된 자재 재고도 반영돼요.' : '이 작업을 취소해요. 처리 이력은 유지돼요.', target === 'verified' ? { title: '검수 승인', ok: '확인했어요, 승인' } : { title: '작업을 취소할까요?', ok: '작업 취소', cancel: '돌아가기', danger: true })) return;
    requireOwner(owner);
    const job = { id: uuid('command'), kind: 'transition', workId: order.id, target, actor: owner.actor, at: Date.now(), input, photos: target === 'completed' ? clone(d.photos) : [], facilityStatus: Q('#woFacilityStatus') ? Q('#woFacilityStatus').value : '', lightUpdatedAt: state.lightVersion, closeReports: !!(Q('#woCloseReports') && Q('#woCloseReports').checked), draftKey: d.storageId };
    if (job.closeReports) job.reportVersions = { ...state.reportVersions };
    d.pending = job.id; delete d.process; lockForm(form, true); button.disabled = true;
    try {
      await writeDraft(d, 'workCompletion'); job.draftKey = d.storageId;
      requireOwner(owner);
      const result = await submit(job, C.STATES[target] + ' · ' + order.title);
      if (!ownsContext(owner)) return;
      if (result.state === 'synced') {
        await clearWorkDraft(d, 'workCompletion'); await load(true);
        if (form.isConnected && Q('#woDetail') === form) await openWork(order.id, undefined, { isCurrent: () => form.isConnected && Q('#woDetail') === form && Q('#sheet')?.classList.contains('open') && state.currentOrder === order });
      } else if (form.isConnected && Q('#woDetail') === form) api.closeSheet();
    } catch (error) {
      if (!ownsContext(owner)) throw error;
      const queued = (await root.DGOffline.jobs().catch(() => [])).some(j => j.id === job.id);
      if (!ownsContext(owner)) throw error;
      if (!queued) { d.pending = null; await writeDraft(d, 'workCompletion').catch(() => {}); }
      throw error;
    } finally { if (ownsContext(owner) && form.isConnected) { lockForm(form, !!d.pending); button.disabled = !!d.pending; } }
  }
  function dueLights() {
    const now = Date.now(), days = Number(state.settings.inspectionDays) || 90;
    const rows = api.state().lights.filter(l => !l.removed && api.inDong(l, state.dueDong)).map(l => ({ light: l, inspection: C.inspectionState(l, days, now) })).filter(x => state.dueFilter === 'all' || state.dueFilter === 'needed' ? state.dueFilter === 'all' || x.inspection.key !== 'current' : x.inspection.key === state.dueFilter);
    if (state.dueSort === 'near' && state.pos) return rows.map(x => ({ ...x, d: Number.isFinite(x.light.lat) ? C.distance(state.pos, x.light) : Infinity })).sort((a, b) => a.d - b.d);
    return rows.sort((a, b) => a.inspection.priority - b.inspection.priority || (b.inspection.overdueDays || 0) - (a.inspection.overdueDays || 0));
  }
  const fmtM = m => !Number.isFinite(m) ? '' : m < 1000 ? Math.round(m) + 'm' : (m / 1000).toFixed(1) + 'km';
  /* One position fix for sorting and "가까운 N곳"; the list is not re-sorted while the person is picking. */
  function locate() {
    return new Promise(resolve => {
      if (!root.navigator?.geolocation) { api.toast('이 기기에서는 위치를 쓸 수 없어요.'); return resolve(null); }
      root.navigator.geolocation.getCurrentPosition(p => { state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; resolve(state.pos); },
        () => { api.toast('내 위치를 가져오지 못했어요. 위치 권한을 확인해 주세요.'); resolve(null); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    });
  }
  // a stop counts as done when it was ticked, or when the light was inspected after the plan was made
  const stopDone = (plan, s) => !!s.visited || (Number(api.byId(s.id)?.lastInspected) || 0) >= (plan.createdAt || 0);
  function relegs(plan) { C.planLegs(plan); if (plan.origin && plan.stops[0]) plan.startDistance = Math.round(C.distance(plan.origin, plan.stops[0])); return plan; }
  const ROUTE_STOPS = 6; // stops handed to a map app at once (네이버 지도 and 카카오맵 each take 5 waypoints + the destination)
  /* the open stops still ahead, in plan order, and their straight-line length (from my position when known) */
  function remaining(plan, done) {
    const open = plan.stops.filter((s, i) => !done[i]);
    let m = 0; open.forEach((s, i) => { if (i) m += C.distance(open[i - 1], s); });
    const fromMe = open.length && state.pos ? C.distance(state.pos, open[0]) : 0;
    return { open, meters: m + fromMe, fromMe: !!(open.length && state.pos) };
  }
  /* 다음 N곳 경로: several stops as waypoints in one map app route, starting from the device's current position */
  async function routeAhead(plan) {
    const field = !root.DEV || root.DEV.field;
    if (field && !state.pos) await locate();
    Object.assign(plan, C.reconcilePlan(plan, api.byId));
    const done = plan.stops.map(s => stopDone(plan, s)), ahead = plan.stops.filter((s, i) => !done[i]).slice(0, ROUTE_STOPS);
    if (!ahead.length) return api.toast('남은 방문지가 없어요.');
    const dest = ahead[ahead.length - 1], via = ahead.slice(0, -1), name = s => encodeURIComponent(s.code || '방문지'), ll = s => s.lat + ',' + s.lng;
    const naver = mode => 'nmap://route/' + mode + '?dlat=' + dest.lat + '&dlng=' + dest.lng + '&dname=' + name(dest) + via.map((s, i) => '&v' + (i + 1) + 'lat=' + s.lat + '&v' + (i + 1) + 'lng=' + s.lng + '&v' + (i + 1) + 'name=' + name(s)).join('') + '&appname=lanian.github.io';
    const google = mode => 'https://www.google.com/maps/dir/?api=1&destination=' + ll(dest) + (via.length ? '&waypoints=' + encodeURIComponent(via.map(ll).join('|')) : '') + '&travelmode=' + mode;
    // 카카오맵 app route: sp (start) is required and takes coordinates only, waypoints vp, vp2 … vp5 (none for public transit).
    // The start is my position when known; otherwise the first stop becomes the start and the rest stay waypoints.
    const start = state.pos || null, kVia = start ? via : via.slice(1), kStart = start || ahead[0];
    const kakao = mode => 'kakaomap://route?sp=' + ll(kStart) + kVia.map((s, i) => '&vp' + (i ? i + 1 : '') + '=' + ll(s)).join('') + '&ep=' + ll(dest) + '&by=' + mode;
    const kakaoHint = (start ? '내 위치에서 출발' : ahead.length > 1 ? '위치를 몰라 ' + (ahead[0].code || '첫 방문지') + '에서 출발' : '') + ' · 경유지 ' + kVia.length + '곳';
    // phone/tablet: navigation apps (app links only work where the app is installed); PC: web maps only
    const options = field ? [{ value: naver('car'), label: '네이버 지도 · 차량', hint: '앱이 설치된 경우 · 경유지 ' + via.length + '곳' }, ...(ahead.length > 1 ? [{ value: kakao('car'), label: '카카오맵 · 차량', hint: '앱이 설치된 경우 · ' + kakaoHint }, { value: kakao('foot'), label: '카카오맵 · 도보', hint: '앱이 설치된 경우 · ' + kakaoHint }] : []), { value: google('driving'), label: '구글 지도 · 차량' }, { value: google('walking'), label: '구글 지도 · 도보' }]
      : [{ value: google('driving'), label: '구글 지도 (웹) · 차량', hint: '경유지 ' + via.length + '곳 · 네이버·카카오 경유지 경로는 휴대폰 앱에서 열려요' }, { value: google('walking'), label: '구글 지도 (웹) · 도보' }];
    const url = root.DGDialog ? await root.DGDialog.choose(ahead.map(s => s.code).join(' → '), { title: '다음 ' + ahead.length + '곳을 한 경로로 열까요?', options }) : options.find(o => o.value.startsWith('https:')).value;
    if (url && ahead.some(stop => { const current = api.byId(stop.id); return !current || current.removed || current.posApprox || current.lat !== stop.lat || current.lng !== stop.lng; })) {
      Object.assign(plan, C.reconcilePlan(plan, api.byId)); await root.DGOffline.put('plan', 'current', plan); notify(); return api.toast('시설 위치가 바뀌었어요. 좌표 확인 후 경로를 다시 열어 주세요.');
    }
    if (url) root.open(url, '_blank', 'noopener');
  }
  // Vehicle routes are a view of the plan: opening a map never saves or completes visits.
  function drivingVisible(s) {
    return s && drivingSession === s && state.plan === s.plan && ownsContext(s.owner) &&
      api.state().tab === 'admin' && api.state().asec === 'due' && !!Q('#dgDrivingPlan') && !!Q('#sheet.open');
  }
  function drivingOrigin(s) {
    const p = s.origin;
    return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 &&
      Number.isFinite(p.acc) && p.acc >= 0 && p.acc <= 100 && Date.now() >= p.at && Date.now() - p.at <= 300000 ? p : null;
  }
  function drivingSnapshot(s) {
    const plan = C.reconcilePlan(s.plan, api.byId), origin = drivingOrigin(s);
    const stops = plan.stops.flatMap((stop, i) => stopDone(plan, stop) ? [] : [{ id: stop.id, code: stop.code, lat: stop.lat, lng: stop.lng, ordinal: i + 1 }]);
    return { routes: root.DGVisitDriving.makeBatches(stops, origin), planKey: JSON.stringify({ plan, stops }), key: JSON.stringify({ plan, origin, stops }) };
  }
  const drivingCurrent = (s, model) => drivingVisible(s) && drivingSnapshot(s).key === model.key;
  function drivingView(plan) {
    const s = drivingSession;
    if (!root.DGVisitDriving || !s || s.plan !== plan || !ownsContext(s.owner)) return '';
    const snapshot = drivingSnapshot(s), origin = drivingOrigin(s);
    s.model = { ...snapshot, token: String(++drivingToken) };
    const count = snapshot.routes.reduce((n, route) => n + route.stops.length, 0);
    const status = s.origin && !origin && !s.locating ? '출발 위치를 확인한 지 5분이 지났어요. 카카오맵을 쓰려면 내 위치를 다시 확인해 주세요.' : s.status || (origin ? '확인한 내 위치에서 출발해요. 위치는 5분 동안 사용하며 다시 확인할 수 있어요.' : '첫 구간은 네이버 지도앱의 현재 위치에서 출발해요. 카카오맵을 쓰려면 내 위치를 확인해 주세요.');
    return '<section class="dg-driving" id="dgDrivingPlan" aria-labelledby="dgDrivingTitle"><div class="dg-driving-head"><div><small>차량 방문</small><h3 id="dgDrivingTitle">차량 이동 노선</h3><p>남은 ' + count + '곳 · ' + snapshot.routes.length + '개 구간</p></div><button type="button" class="btn ghost sm" data-dg="driving-close">노선 접기</button></div>' +
      '<p class="muted">방문 순서대로 최대 6곳씩 나눴어요. 실제 도로 경로와 운전 시간은 선택한 지도에서 확인해요. 경로를 열어도 방문 완료로 처리하지 않아요.</p>' +
      '<div class="dg-driving-location"><button type="button" class="btn ghost sm" data-dg="driving-locate"' + (s.locating ? ' disabled' : '') + '>' + (s.locating ? '내 위치 확인 중…' : origin ? '출발 위치 다시 확인' : '내 위치 확인') + '</button><p id="dgDrivingStatus" role="status" aria-live="polite">' + E(status) + '</p></div>' +
      (count ? '<div class="dg-driving-legs">' + snapshot.routes.map(route => '<details class="dg-driving-leg"' + (!route.index ? ' open' : '') + '><summary><b>구간 ' + (route.index + 1) + '</b><span>' + E(route.stops[0].code) + (route.stops.length > 1 ? ' → ' + E(route.stops[route.stops.length - 1].code) : '') + '</span><small>' + route.stops.length + '곳</small></summary><div class="dg-driving-body"><p class="muted">출발: ' + E(route.index ? '이전 구간 도착지 · ' + route.start.code : origin ? '확인한 내 위치 (±' + Math.round(origin.acc) + 'm)' : '네이버 지도앱의 현재 위치') + '</p><ol>' + route.stops.map(stop => '<li value="' + stop.ordinal + '">' + E(stop.code) + '</li>').join('') + '</ol><button type="button" class="btn sodium" data-dg="driving-open" data-index="' + route.index + '" data-token="' + s.model.token + '">구간 ' + (route.index + 1) + ' 차량 경로 열기</button></div></details>').join('') + '</div>' : '<p class="notice">남은 방문지가 없어요. 방문 대상과 완료 상태를 확인해 주세요.</p>') + '</section>';
  }
  function showDriving() {
    if (!state.plan || !root.DGVisitDriving) return api.toast('방문 계획을 먼저 만들어 주세요.');
    drivingSession = { plan: state.plan, owner: captureOwner(), origin: null, status: '', request: 0, locating: false, choosing: false, model: null };
    notify(); Q('#dgDrivingPlan')?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  function locateDriving() {
    const s = drivingSession;
    if (!drivingVisible(s) || s.locating) return;
    if (!root.navigator?.geolocation) { s.status = '이 기기에서는 위치를 확인할 수 없어요. 네이버 지도앱의 현재 위치로 경로를 열 수 있어요.'; return notify(); }
    const model = drivingSnapshot(s), request = ++s.request;
    s.locating = true; s.status = '차량 출발 위치를 확인하고 있어요.'; notify();
    const finish = (position, message) => {
      if (s.request !== request) return;
      s.locating = false;
      if (!drivingVisible(s) || drivingSnapshot(s).planKey !== model.planKey) { if (drivingVisible(s)) { s.status = '방문 계획이 바뀌어 출발 위치를 적용하지 않았어요. 내 위치를 다시 확인해 주세요.'; notify(); } return; }
      const p = position?.coords;
      s.origin = p ? { lat: p.latitude, lng: p.longitude, acc: p.accuracy, at: Date.now(), code: '내 위치' } : null;
      s.status = drivingOrigin(s) ? '확인한 내 위치에서 출발해요 (±' + Math.round(s.origin.acc) + 'm). 카카오·네이버 차량 경로를 열 수 있어요.' : message || '위치가 정확하지 않아요. 다시 확인하거나 네이버 지도앱의 현재 위치를 사용해 주세요.';
      if (!drivingOrigin(s)) s.origin = null;
      notify();
    };
    try { root.navigator.geolocation.getCurrentPosition(p => finish(p), () => finish(null, '내 위치를 확인하지 못했어요. 위치 권한을 확인하거나 네이버 지도앱의 현재 위치로 경로를 열어 주세요.'), { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }); }
    catch (_) { finish(null, '내 위치를 확인하지 못했어요. 네이버 지도앱의 현재 위치로 경로를 열 수 있어요.'); }
  }
  async function openDriving(button) {
    const s = drivingSession, model = s?.model;
    if (!model || !drivingVisible(s) || s.choosing || button.dataset.token !== model.token) return;
    if (!drivingCurrent(s, model)) { notify(); return api.toast('방문 계획이나 시설 위치가 바뀌었어요. 최신 노선을 확인하고 다시 열어 주세요.'); }
    const index = Number(button.dataset.index), route = model.routes[index];
    if (!Number.isSafeInteger(index) || index < 0 || !route) return;
    const choices = [
      ...(route.start ? [{ value: 'kakao-web', label: '카카오맵 · 차량 (웹)', hint: 'PC·휴대폰 브라우저에서 확인' }, { value: 'kakao-app', label: '카카오맵 · 차량 (앱)', hint: '카카오맵 앱이 설치된 기기에서 사용' }] : []),
      { value: 'naver', label: '네이버 지도 · 차량 (앱)', hint: '네이버 지도 앱 설치 필요' + (route.start ? '' : ' · 지도앱의 현재 위치에서 출발') }
    ];
    s.choosing = true;
    try {
      const provider = root.DGDialog ? await root.DGDialog.choose(route.stops.map(stop => stop.code).join(' → ') + (route.start ? '' : '\n카카오맵은 내 위치 확인 후 사용할 수 있어요.'), { title: '구간 ' + (index + 1) + ' 차량 경로', options: choices }) : null;
      if (!provider || !choices.some(choice => choice.value === provider)) return;
      if (!drivingCurrent(s, model)) { if (drivingVisible(s)) { notify(); api.toast('방문 계획이나 시설 위치가 바뀌었어요. 최신 노선을 확인하고 다시 열어 주세요.'); } return; }
      root.open(root.DGVisitDriving.makeUrl(route, provider), '_blank', 'noopener,noreferrer');
    } finally { s.choosing = false; }
  }
  function dueView() {
    if (state.plan) Object.assign(state.plan, C.reconcilePlan(state.plan, api.byId));
    ensure(); const rows = dueLights(), plan = state.plan, shown = rows.slice(0, state.dueShow);
    state.planPick = new Set([...state.planPick].filter(id => api.byId(id) && !api.byId(id).removed));
    const picked = state.planPick.size, near = state.dueSort === 'near' && !!state.pos;
    return (plan ? planView(plan) : '') +
      '<h2 id="dgDueTargets">점검 대상 고르기</h2><div class="panel"><p>점검 주기 ' + (Number(state.settings.inspectionDays) || 90) + '일 · 단순 순찰 통과는 항목별 점검과 구분해요.</p><div class="grid2"><select class="f-in" id="dgDueDong" aria-label="대상 행정동">' + api.dongOptions(state.dueDong) + '</select><select class="f-in" id="dgDueFilter" aria-label="점검 상태">' + Object.entries({ needed: '확인이 필요한 전체', never: '점검 기록 없음', overdue: '기한 초과', redo: '재점검 요청', all: '철거 제외 전체' }).map(([v, t]) => '<option value="' + v + '"' + (state.dueFilter === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div>' +
      '<div class="split dg-quick"><button class="btn ghost sm" data-dg="due-sort" aria-pressed="' + near + '">' + (near ? '가까운 순 ✓' : '가까운 순으로') + '</button><button class="btn ghost sm" data-dg="pick-near">' + (near ? '가까운 10곳 선택' : '위 10곳 선택') + '</button><button class="btn ghost sm" data-dg="pick-all">보이는 ' + Math.min(shown.length, 200) + '곳 선택</button>' + (picked ? '<button class="btn ghost sm" data-dg="pick-none">선택 해제</button>' : '') + '</div>' +
      '<div class="split"><button class="btn ghost" data-dg="due-map">대상 지도</button><button class="btn sodium" data-dg="make-plan"' + (picked ? '' : ' disabled') + '>' + (picked ? '선택한 ' + picked + '곳 방문 계획' : '시설을 골라 방문 계획') + '</button></div><p class="muted">대상 ' + rows.length + '개 · 지도와 목록은 같은 조건을 사용해요.' + (near ? ' 내 위치(±' + Math.round(state.pos.acc || 0) + 'm) 기준 가까운 순이에요.' : '') + (picked > 200 ? ' 한 계획은 200곳까지라 앞의 200곳만 들어가요.' : '') + '</p></div>' +
      '<div class="list">' + shown.map(({ light: l, inspection: ins, d }) => '<div class="dg-due-row' + (state.planPick.has(l.id) ? ' picked' : '') + '"><input type="checkbox" data-plan-light="' + E(l.id) + '"' + (state.planPick.has(l.id) ? ' checked' : '') + ' aria-label="' + E(l.code + ' 방문 계획에 선택') + '"><button class="light-row" data-light="' + E(l.id) + '"><b>' + E(l.code) + '</b><span class="chip st-' + E(l.status) + '">' + E(l.status) + '</span><small>' + E(ins.label) + ' · ' + E(l.dong) + (l.posApprox ? ' · 좌표 확인 필요' : '') + '</small>' + (near && Number.isFinite(d) ? '<span class="dg-dist">' + fmtM(d) + '</span>' : '') + '</button></div>').join('') + '</div>' + (rows.length > state.dueShow ? '<button class="btn ghost block" data-dg="more-due">더 보기</button>' : '');
  }
  function planView(plan) {
    const done = plan.stops.map(s => stopDone(plan, s)), doneCount = done.filter(Boolean).length, nextIndex = done.indexOf(false), next = nextIndex >= 0 ? plan.stops[nextIndex] : null;
    const nextLight = next && api.byId(next.id), fromMe = next && state.pos ? C.distance(state.pos, next) : null;
    const pct = plan.stops.length ? Math.round(doneCount / plan.stops.length * 100) : 0, left = remaining(plan, done);
    const excluded = plan.excludedApproximate || [];
    const positionNotice = excluded.length ? '<div class="notice"><b>좌표 확인 필요 ' + excluded.length + '곳</b><p>분전함 기준 추정 위치는 방문 순서에서 제외했어요. 시설 상세에서 실제 좌표를 확인한 뒤 다시 계획을 만들어 주세요.</p>' + excluded.slice(0, 10).map(l => '<button type="button" class="btn ghost sm" data-light="' + E(l.id) + '">' + E(l.code) + '</button>').join('') + (excluded.length > 10 ? '<p>제외 시설 전체 ' + excluded.length + '곳은 원래 대상 목록에서 확인할 수 있어요.</p>' : '') + '</div>' : '';
    return positionNotice + ((plan.excludedUnavailable || []).length ? '<p class="notice">현재 대장 또는 좌표를 확인할 수 없는 시설 ' + plan.excludedUnavailable.length + '곳도 경로에서 제외했어요.</p>' : '') + '<h2>내 방문 계획 <span class="muted">' + doneCount + '/' + plan.stops.length + '곳</span></h2><div class="panel dg-plan">' +
      '<div class="dg-progress" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100" aria-label="방문 진행"><i style="width:' + pct + '%"></i></div>' +
      '<p>방문지 사이 직선 약 ' + fmtM(plan.distance) + (left.open.length && left.open.length < plan.stops.length || left.fromMe ? ' · 남은 ' + left.open.length + '곳 약 ' + fmtM(left.meters) + (left.fromMe ? '(내 위치부터)' : '') : '') + ' · ' + (plan.createdAt ? time(plan.createdAt) + ' 작성' : '') + (plan.filters ? ' · 보수 작업 조건에서 만든 계획' : '') + '</p>' +
      (next ? '<div class="dg-plan-next"><small>다음 방문지 ' + (nextIndex + 1) + '/' + plan.stops.length + (fromMe != null ? ' · 내 위치에서 ' + fmtM(fromMe) : '') + '</small><b>' + E(next.code) + '</b> <span class="muted">' + E(next.dong) + (nextLight ? ' · ' + E(C.inspectionState(nextLight, Number(state.settings.inspectionDays) || 90, Date.now()).label) : '') + '</span><div class="split"><button class="btn sodium sm" data-light="' + E(next.id) + '">점검하기</button><button class="btn ghost sm" data-dg="plan-route" data-id="' + E(next.id) + '">길찾기</button><button class="btn ghost sm" data-dg="plan-visit" data-index="' + nextIndex + '">방문 완료</button></div></div>' : (plan.stops.length ? '<div class="dg-plan-next done"><b>모든 방문지를 마쳤어요.</b> <span class="muted">계획을 지우거나 새 계획을 만들 수 있어요.</span></div>' : '<div class="dg-plan-next"><b>방문 순서를 만들 시설이 없어요.</b> <span class="muted">제외된 시설의 좌표를 확인하거나 대상을 다시 골라 주세요.</span></div>')) +
      '<p class="muted">직선 거리로 교차하는 구간을 줄여 제안한 방문 순서예요. 차량 통행·일방통행·도로 진입 경로는 현장에서 확인해 주세요. 방문 표시로 점검 결과가 바뀌지는 않아요. 계획을 만든 뒤 점검을 저장한 시설은 자동으로 완료로 표시돼요.</p>' +
      (left.open.length ? '<button type="button" class="btn sodium block dg-driving-create" data-dg="plan-driving">차량 이동 노선 만들기</button>' : '') +
      '<div class="split">' + (left.open.length > 1 ? '<button class="btn ghost sm" data-dg="plan-route-ahead">다음 ' + Math.min(ROUTE_STOPS, left.open.length) + '곳 경로</button>' : '') + '<button class="btn ghost" data-ptplan>이 계획으로 야간 순찰</button><button class="btn ghost sm" data-dg="plan-map">계획 지도</button><button class="btn ghost sm" data-dg="plan-reorder">내 위치에서 다시 정렬</button><button class="btn ghost sm" data-dg="plan-csv">계획 CSV</button><button class="btn ghost sm" data-dg="clear-plan">계획 지우기</button></div>' +
      drivingView(plan) +
      plan.stops.map((s, i) => '<div class="dg-plan-stop' + (done[i] ? ' done' : '') + (i === nextIndex ? ' next' : '') + '"><label><input type="checkbox" data-plan-visited="' + i + '"' + (s.visited ? ' checked' : '') + (done[i] && !s.visited ? ' disabled title="점검을 저장해 완료됐어요"' : '') + '> <span class="n">' + (i + 1) + '</span> <b>' + E(s.code) + '</b><small>' + E(s.dong) + (i ? (s.distanceFromPrevious < 15 ? ' · 앞 시설과 같은 자리' : ' · +' + fmtM(s.distanceFromPrevious)) : ' · 출발') + (done[i] && !s.visited ? ' · <span class="dg-auto">점검 완료</span>' : '') + '</small></label><span class="dg-plan-acts"><button class="btn ghost sm" data-light="' + E(s.id) + '">점검</button>' + (s.workIds || []).map((id, n) => '<button class="btn ghost sm" data-dg="open-work" data-id="' + E(id) + '">보수 ' + (n + 1) + '</button>').join('') + '<button class="btn ghost sm" data-dg="plan-up" data-index="' + i + '"' + (!i ? ' disabled' : '') + ' aria-label="' + E(s.code) + ' 위로">위로</button><button class="btn ghost sm" data-dg="plan-down" data-index="' + i + '"' + (i === plan.stops.length - 1 ? ' disabled' : '') + ' aria-label="' + E(s.code) + ' 아래로">아래로</button></span></div>').join('') + '</div>';
  }
  function planMapView(plan) { const done = plan.stops.filter(s => stopDone(plan, s)).map(s => s.id), next = plan.stops.find(s => !done.includes(s.id)); return { order: plan.stops.map(s => s.id), done, next: next?.id || null }; }
  // Called by the plan map. Only the plan the map was opened for is changed; a replaced or cleared plan is left alone.
  async function reorderFromMap(plan, id, where) {
    if (state.plan !== plan) return null;
    const stops = C.moveOpenStop(plan.stops, id, where, stop => stopDone(plan, stop)); if (!stops) return null;
    plan.stops = stops; relegs(plan); plan.reorderedAt = Date.now();
    await root.DGOffline.put('plan', 'current', plan); notify(); return planMapView(plan);
  }
  async function refreshQueue() {
    if (!root.DGOffline.ready) return;
    const owner = captureOwner(), jobs = await owner.offline.jobs(); if (!ownsContext(owner)) return;
    const kinds = await Promise.all(['draft', 'patrol', 'patrolTargets', 'inventoryDraft', 'assetDraft', 'preventiveDraft', 'workDraft', 'workCompletion', 'workEdit', 'lightingDraft', 'lightingTaskDraft', 'lightingAreaDraft'].map(kind => owner.offline.list(kind)));
    if (!ownsContext(owner)) return;
    state.jobs = jobs; state.drafts = kinds.flat(); notify();
  }
  function queueView() {
    const statuses = { queued: '전송 대기', sending: '서버 확인 중', failed: '실패 · 재시도 가능', conflict: '변경 충돌 · 확인 필요', synced: '서버/저장소 반영 완료' };
    return '<div class="panel"><p>' + (root.DGOffline.durable ? '이 기기에 초안과 미전송 작업을 보관해요.' : '공유 기기 모드: 현재 창에서만 대기해요. 전송 완료를 확인한 뒤 닫아 주세요.') + '</p><div class="split"><button class="btn sodium" data-dg="retry-all">대기 작업 전송</button><button class="btn ghost" data-dg="queue-refresh">새로고침</button></div></div><h3>저장 작업 ' + state.jobs.filter(j => j.state !== 'synced').length + '건 대기</h3>' + (state.jobs.length ? state.jobs.map(j => '<div class="panel"><b>' + E(j.summary) + '</b><p>' + statuses[j.state] + ' · ' + time(j.updatedAt) + '</p>' + (j.error ? '<p class="notice">' + E(j.error) + '</p>' : '') + '<div class="split">' + (['queued', 'failed', 'conflict'].includes(j.state) ? '<button class="btn ghost sm" data-dg="retry-job" data-id="' + E(j.id) + '">재시도</button>' : '') + (j.state !== 'sending' ? '<button class="btn ghost sm" data-dg="discard-job" data-id="' + E(j.id) + '">' + (j.state === 'synced' ? '완료 목록에서 지우기' : '대기 작업 폐기') + '</button>' : '') + '</div></div>').join('') : '<div class="empty">대기 중인 저장 작업이 없어요.</div>') +
      '<h3>작성 중인 초안</h3>' + state.drafts.map(d => '<div class="panel"><b>' + E(d.kind === 'draft' ? (api.byId(d.id) || {}).code || d.id : d.kind === 'patrol' ? '이전 순찰' : d.kind === 'patrolTargets' ? '다음 순찰 대상' : d.kind === 'inventoryDraft' ? '자재 정보 수정 · ' + (d.value?.name || d.id) : d.kind === 'assetDraft' ? '시설 관계·교체 초안' : d.kind === 'preventiveDraft' ? '정기점검 계획 · ' + (d.value?.title || '작성 중') : d.kind === 'lightingDraft' ? '외부 광원·현장 밝기 초안' : d.kind === 'lightingAreaDraft' ? '밝기 검토 구역 초안' : d.kind === 'lightingTaskDraft' ? '밝기 재확인 업무 초안' : (d.value?.title || (api.byId(d.value?.lightId) || {}).code || '보수 작업 초안')) + '</b><p class="muted">' + time(d.updatedAt) + '</p><div class="split"><button class="btn ghost sm" ' + (d.kind === 'patrolTargets' ? 'data-ptnext' : 'data-dg="recover-draft" data-kind="' + E(d.kind) + '" data-id="' + E(d.id) + '"') + '>이어 쓰기</button><button class="btn ghost sm" data-dg="discard-draft" data-kind="' + E(d.kind) + '" data-id="' + E(d.id) + '">초안 폐기</button></div></div>').join('');
  }
  async function download(name, rows) {
    const cell = root.DGSecurity ? root.DGSecurity.csvCell : v => '"' + (/^[=+@\-\t\r\n]/.test(String(v || '')) ? "'" : '') + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    await api.download({ filename: name + '.csv', data: '\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n') });
  }
  async function handle(button) {
    const action = button.dataset.dg;
    if (action === 'plan-driving') return showDriving();
    if (action === 'driving-locate') return locateDriving();
    if (action === 'driving-open') return openDriving(button);
    if (action === 'driving-close') { drivingSession = null; return notify(); }
    if (action === 'attention-work') return openAttention();
    if (['acknowledge-work', 'hold-work', 'resume-work'].includes(action)) return processWork(action.split('-')[0], button);
    if (action === 'new-work') return newWork(button.dataset.lightId, button.dataset.reportId);
    if (action === 'resume-stale-work-edit') return resumeStaleEdit(true);
    if (action === 'edit-latest-work') return resumeStaleEdit(false);
    if (action === 'edit-work') return openEdit(button.dataset.id);
    if (action === 'save-work-edit') return saveEdit(button);
    if (action === 'bulk-work') return openBulk();
    if (action === 'save-bulk-work') return saveBulk(button);
    if (action === 'clear-work-pick') { state.workPick.clear(); return notify(); }
    if (action === 'open-work') return openWork(button.dataset.id);
    if (action === 'refresh') return load(true);
    if (action === 'more-work') { state.show += 60; if (state.hasMore) await load(false, true); return notify(); }
    if (action === 'create-work') return createWork(button);
    if (action === 'transition-work') return transitionWork(button);
    if (action === 'remove-work-photo') { const source = Q('#woNewForm') ? state.draft : state.completion; if (!source || source.pending) return; source.photos = source.photos.filter(p => p.id !== button.dataset.id); const box = Q(Q('#woNewForm') ? '#woBeforePreview' : '#woAfterPreview'); if (box) box.innerHTML = photoPreviews(source.photos); return Q('#woNewForm') ? persistNew() : persistCompletion(); }
    if (action === 'add-planned-part' || action === 'remove-planned-part') {
      const edit = !!Q('#woEditForm'), kind = edit ? 'workEdit' : 'workDraft', d = edit ? readEdit() : readNew();
      if (!d || d.pending || !ownerForm(d, kind)) return;
      if (edit && state.editOrder?.status === 'completed') return;
      d.parts ||= [];
      if (action === 'remove-planned-part') d.parts.splice(+button.dataset.index, 1);
      else { const item = state.inventory.find(row => row.id === Q('#woPlanStockPart').value), name = item ? item.name : Q('#woPlanPartName').value; if (!name.trim()) throw new Error('자재명을 입력해 주세요.'); d.parts = C.parts([...d.parts, { name, qty: Number(Q('#woPlanPartQty').value), unitCost: Number(Q('#woPlanPartCost').value), ...(item ? { inventoryId: item.id } : {}) }]); }
      Q('#woPlannedParts').innerHTML = plannedRows(d.parts); return writeDraft(d, kind);
    }
    if (action === 'add-part') { const d = state.completion, item = state.inventory.find(x => x.id === Q('#woStockPart').value), value = { name: item ? item.name : Q('#woPartName').value, qty: Number(Q('#woPartQty').value), unitCost: Number(Q('#woPartCost').value), ...(item ? { inventoryId: item.id } : {}) }; if (!value.name.trim()) throw new Error('자재명을 입력해 주세요.'); d.parts = C.parts([...d.parts, value]); Q('#woParts').innerHTML = partRows(d.parts); return persistCompletion(); }
    if (action === 'remove-part') { state.completion.parts.splice(+button.dataset.index, 1); Q('#woParts').innerHTML = partRows(state.completion.parts); return persistCompletion(); }
    if (action === 'add-lux') { if (Q('#woLux').value === '') throw new Error('측정한 조도를 입력해 주세요.'); state.completion.measurements = C.measurements([...state.completion.measurements, { lux: Number(Q('#woLux').value), at: Date.now(), by: api.state().me, note: Q('#woLuxNote').value }]); Q('#woMeasurements').innerHTML = measureRows(state.completion.measurements); Q('#woLux').value = ''; return persistCompletion(); }
    if (action === 'remove-lux') { state.completion.measurements.splice(+button.dataset.index, 1); Q('#woMeasurements').innerHTML = measureRows(state.completion.measurements); return persistCompletion(); }
    if (action === 'due-map') return api.openMap('custom', { title: '미점검·기한 초과', pts: dueLights().map(x => x.light) });
    if (action === 'more-due') { state.dueShow += 100; return notify(); }
    if (action === 'due-sort') { if (state.dueSort === 'near' && state.pos) { state.dueSort = 'priority'; return notify(); } if (!await locate()) return notify(); state.dueSort = 'near'; return notify(); }
    if (action === 'pick-near' || action === 'pick-all') {
      // "가까운 10곳" uses the position only when 가까운 순 is on; otherwise the first ten of the current order are taken
      const rows = dueLights(), take = (action === 'pick-near' ? rows.slice(0, 10) : rows.slice(0, Math.min(state.dueShow, 200))).map(x => x.light.id);
      take.forEach(id => state.planPick.add(id)); return notify();
    }
    if (action === 'pick-none') { state.planPick.clear(); return notify(); }
    if (action === 'make-plan') { const chosen = [...state.planPick].map(id => api.byId(id)).filter(Boolean).slice(0, 200); if (!chosen.length) throw new Error('방문할 시설을 선택해 주세요.'); state.plan = C.planVisits(chosen, state.pos || api.state().pos); state.planPick.clear(); await root.DGOffline.put('plan', 'current', state.plan); api.toast(state.plan.stops.length + '곳 방문 계획을 만들었어요.'); return notify(); }
    if (action === 'plan-map') { const plan = state.plan, view = planMapView(plan); return api.openMap('custom', { title: '방문 계획 · 직선 순서', pts: plan.stops.map(s => api.byId(s.id)).filter(Boolean), ordered: true, ...view, reorder: (id, where) => reorderFromMap(plan, id, where) }); }
    if (action === 'plan-route-ahead') return routeAhead(state.plan);
    if (action === 'plan-route') return api.route ? api.route(button.dataset.id) : api.toast('길찾기를 쓸 수 없어요.');
    if (action === 'plan-visit') { const s = state.plan.stops[+button.dataset.index]; if (!s) return; s.visited = true; await root.DGOffline.put('plan', 'current', state.plan); return notify(); }
    if (action === 'plan-reorder') {
      if (!state.pos && !await locate()) return;
      const done = state.plan.stops.filter(s => stopDone(state.plan, s)), left = state.plan.stops.filter(s => !stopDone(state.plan, s));
      if (left.length < 2) { api.toast('다시 정렬할 남은 방문지가 없어요.'); return; }
      const before = remaining(state.plan, state.plan.stops.map(s => stopDone(state.plan, s))).meters;
      const re = C.planVisits(left, state.pos); state.plan.stops = [...done, ...re.stops.map(s => ({ ...s, visited: false }))]; relegs(state.plan); state.plan.reorderedAt = Date.now();
      const after = remaining(state.plan, state.plan.stops.map(s => stopDone(state.plan, s))).meters, saved = before - after;
      await root.DGOffline.put('plan', 'current', state.plan); api.toast('내 위치부터 남은 ' + left.length + '곳을 다시 정렬했어요' + (saved >= 50 ? ' · 직선 약 ' + fmtM(saved) + ' 단축' : '') + '.'); return notify();
    }
    if (action === 'plan-up' || action === 'plan-down') { const i = +button.dataset.index, j = action === 'plan-up' ? i - 1 : i + 1; if (j < 0 || j >= state.plan.stops.length) return; [state.plan.stops[i], state.plan.stops[j]] = [state.plan.stops[j], state.plan.stops[i]]; relegs(state.plan); await root.DGOffline.put('plan', 'current', state.plan); return notify(); }
    if (action === 'clear-plan') { if (!await ask('현재 방문 계획을 지워요. 점검 기록은 유지돼요.', { title: '방문 계획을 지울까요?', ok: '지우기', danger: true })) return; state.plan = null; await root.DGOffline.remove('plan', 'current'); return notify(); }
    if (action === 'plan-csv') return download('동구_방문계획', [['순서', '시설', '시설ID', '법정동', '위도', '경도', '앞 방문지에서 직선m', '방문', '연결 작업ID'], ...state.plan.stops.map((p, i) => [i + 1, p.code, p.id, p.dong, p.lat, p.lng, i ? p.distanceFromPrevious : '', stopDone(state.plan, p) ? (p.visited ? '방문' : '점검 완료') : '미방문', (p.workIds || []).join(' · ')])]);
    if (['work-csv', 'work-map', 'work-plan'].includes(action)) {
      const { rows, metadata } = await fullSelectedOrders();
      if (action === 'work-csv') return download('동구_보수작업', [['조회 조건', [(C.STATES[state.filter] || (state.filter === 'open' ? '미완료 전체' : '전체 기록')), state.workDong, state.mine ? '내 담당' : '담당 전체', state.urgent ? '긴급' : '우선순위 전체', { all: '기한 전체', today: '오늘 기한 KST', overdue: '기한 초과' }[state.deadline]].join(' · ')], ['자료 출처', sourceText(metadata)], ['작업', '작업ID', '시설', '시설ID', '담당', '상태', '기한', '비용', '완료'], ...rows.map(w => [w.title, w.id, w.code, w.lightId, label(w.assignedTo), C.STATES[w.status], time(w.dueAt), w.costTotal, time(w.verifiedAt)])]);
      const points = workLights(rows);
      if (action === 'work-map') return api.openMap('custom', { title: '보수 작업 · 선택 조건 전체', pts: points });
      if (!points.length) throw new Error('조건에 맞는 방문 시설이 없어요.');
      state.plan = C.planVisits(points, api.state().pos); state.plan.filters = workFilters(); state.plan.sourceAt = metadata?.fetchedAt || Date.now();
      await root.DGOffline.put('plan', 'current', state.plan); api.openSection?.('due'); return notify();
    }
    if (action === 'queue-refresh') return refreshQueue();
    if (action === 'retry-all') { await root.DGOffline.flush({ retry: true }); return refreshQueue(); }
    if (action === 'retry-job') { const result = await root.DGOffline.retry(button.dataset.id); api.toast(result.state === 'synced' ? '저장했어요.' : result.error || '전송을 기다리고 있어요.'); return refreshQueue(); }
    if (action === 'discard-job') {
      const owner = captureOwner();
      if (!await ask('이 대기 항목을 지워요. 이미 서버에 반영된 기록은 삭제하지 않아요.', { title: '대기 항목을 지울까요?', ok: '지우기', danger: true })) return;
      if (!ownsContext(owner)) return;
      const job = state.jobs.find(j => j.id === button.dataset.id);
      await root.DGOffline.discard(button.dataset.id);
      if (job && job.kind === 'work' && job.payload) await releasePending(job);
      return refreshQueue();
    }
    if (action === 'recover-draft') { if (button.dataset.kind === 'assetDraft') return root.DGAssetMaintenance.resumeDraft(button.dataset.id); if (button.dataset.kind === 'preventiveDraft') return root.DGPreventive.resumeDraft(button.dataset.id); if (button.dataset.kind === 'inventoryDraft') return root.DGManagement.resumeInventoryDraft(button.dataset.id); if (button.dataset.kind === 'lightingAreaDraft') return root.DGLightingAreas.openEditor(null, button.dataset.id, true); if (button.dataset.kind === 'lightingTaskDraft') return root.DGLightingWorkflows.openTask(null, button.dataset.id, true); if (button.dataset.kind === 'lightingDraft') return root.DGLighting.openEditor(null, null, button.dataset.id, true); if (button.dataset.kind === 'draft') return api.openLight(button.dataset.id); if (button.dataset.kind === 'patrol') return api.restorePatrol(); if (button.dataset.kind === 'workEdit') { const saved = await root.DGOffline.get('workEdit', button.dataset.id); return saved ? openEdit(saved.workId, button.dataset.id) : refreshQueue(); } if (button.dataset.kind === 'workCompletion') { const saved = await root.DGOffline.get('workCompletion', button.dataset.id); return saved ? openWork(saved.workId, button.dataset.id) : refreshQueue(); } return newWork(null, null, button.dataset.id); }
    if (action === 'discard-draft') {
      const owner = captureOwner();
      if (!await ask('작성 중인 이 초안을 폐기할까요?', { ok: '폐기', danger: true })) return;
      if (!ownsContext(owner)) return;
      const kind = button.dataset.kind, id = button.dataset.id, saved = await owner.offline.get(kind, id);
      if (!ownsContext(owner)) return;
      if (kind === 'inventoryDraft') { await root.DGManagement.discardInventoryDraft(id, { confirmed: true }); return refreshQueue(); }
      if (kind === 'assetDraft') { await root.DGAssetMaintenance.discardDraft(id, { confirmed: true }); return refreshQueue(); }
      if (kind === 'preventiveDraft') { await root.DGPreventive.discardDraft(id, { confirmed: true }); return refreshQueue(); }
      if (kind === 'lightingAreaDraft') { await root.DGLightingAreas.discardDraft(id); return refreshQueue(); }
      if (kind === 'lightingTaskDraft') { await root.DGLightingWorkflows.discardDraft(id); return refreshQueue(); }
      if (kind === 'lightingDraft') { const active = root.DGLighting.state.draft; await root.DGLighting.clearDraft(active?.recordId === id ? active : saved); return refreshQueue(); }
      if (kind === 'patrol' && saved) api.removePatrolDraft(saved.sessionId);
      if (['workDraft', 'workCompletion', 'workEdit'].includes(kind)) { const active = kind === 'workDraft' ? state.draft : kind === 'workEdit' ? state.edit : state.completion; const owner = active?.storageId === id ? active : saved; if (owner) { owner.storageId = id; await clearWorkDraft(owner, kind); } return refreshQueue(); }
      await root.DGOffline.remove(kind, id); if (kind === 'draft') await api.removeDraft(id); return refreshQueue();
    }
  }
  function attach(context) {
    api = context;
    root.DGOffline.register('work', job => root.DGWorkCommands.execute(job, { db: api.database(), fb: api.firebase(), user: api.state().me, admin: admin() }));
    if (attached) return; attached = true;
    if (root.addEventListener) root.addEventListener('online', () => { if (state.error && state.offlineError && !loading) { state.error = ''; state.offlineError = false; notify(); load(true); } });
    document.addEventListener('click', e => { const button = e.target.closest('[data-dg]'); if (!button) return; Promise.resolve().then(() => handle(button)).catch(error => api.toast(error.message || '처리하지 못했어요.')); });
    document.addEventListener('input', e => {
      if (e.target.id === 'woLight') { const dl = Q('#woLightChoices'); if (dl) dl.innerHTML = lightSuggestions(e.target.value); }
      if (e.target.closest('#woNewForm') === ownerForm(state.draft, 'workDraft')) persistNew().catch(error => api.toast(error.message));
      if (e.target.closest('#woEditForm') === ownerForm(state.edit, 'workEdit')) persistEdit().catch(error => api.toast(error.message));
      if (['woCompletionNote', 'woDiagnosis', 'woRepairAction', 'woHoldReason', 'woHoldNote', 'woHoldNext', 'woHoldAction'].includes(e.target.id)) persistCompletion().catch(error => api.toast(error.message));
    });
    document.addEventListener('change', e => {
      (async () => {
        if (e.target.id === 'woBefore') { if (e.target.closest('#woNewForm') === ownerForm(state.draft, 'workDraft')) return addPhotos(e.target.files, true); return; }
        if (e.target.id === 'woAfter') { if (e.target.closest('#woDetail') === ownerForm(state.completion, 'workCompletion')) return addPhotos(e.target.files, false); return; }
        if (['woFilter', 'woMine', 'woDeadline', 'woUrgent', 'woDong'].includes(e.target.id)) {
          const names = { woFilter: 'filter', woMine: 'mine', woDeadline: 'deadline', woUrgent: 'urgent', woDong: 'workDong' };
          state[names[e.target.id]] = ['woMine', 'woUrgent'].includes(e.target.id) ? e.target.checked : e.target.value;
          state.show = 40; state.error = ''; notify(); await load(true); return;
        }
        if (e.target.dataset.workPick) { const id = e.target.dataset.workPick, order = state.orders.find(row => row.id === id); if (e.target.checked && editable(order)) state.workPick.set(id, clone(order)); else state.workPick.delete(id); const count = Q('#woPickCount'); if (count) count.textContent = '직접 선택한 작업 ' + state.workPick.size + '건'; for (const button of document.querySelectorAll('[data-dg="bulk-work"], [data-dg="clear-work-pick"]')) button.disabled = !state.workPick.size; e.target.closest('.dg-work-choice')?.classList.toggle('picked', e.target.checked); return; }
        if (e.target.id === 'woLight') {
          const d = readNew(), selected = lightMatch(e.target.value);
          if (!d || d.pending || !ownerForm(d, 'workDraft')) return;
          if (selected && selected.id !== d.lightId) {
            if (d.photos.length) { e.target.value = (api.byId(d.lightId) || {}).code + ' [' + d.lightId + ']'; api.toast('첨부 사진을 뺀 뒤 시설을 변경해 주세요.'); return; }
            d.lightId = selected.id; d.title = selected.code + ' 보수'; d.reportIds = []; await loadReports(selected.id); await writeDraft(d, 'workDraft'); if (state.draft === d && ownerForm(d, 'workDraft')) renderNew();
          }
        }
        if (e.target.closest('#woNewForm') === ownerForm(state.draft, 'workDraft')) await persistNew();
        if (e.target.closest('#woEditForm') === ownerForm(state.edit, 'workEdit')) await persistEdit();
        if (['woDiagnosis', 'woRepairAction', 'woHoldReason', 'woHoldNext'].includes(e.target.id)) await persistCompletion();
        if (e.target.id === 'woPlanStockPart') { const item = state.inventory.find(row => row.id === e.target.value); if (item) { Q('#woPlanPartName').value = item.name; Q('#woPlanPartCost').value = item.unitCost; } }
        if (e.target.id === 'woStockPart') { const item = state.inventory.find(x => x.id === e.target.value); if (item) { Q('#woPartName').value = item.name; Q('#woPartCost').value = item.unitCost; } }
        if (e.target.id === 'dgDueDong') { state.dueDong = e.target.value; state.dueShow = 60; notify(); }
        if (e.target.id === 'dgDueFilter') { state.dueFilter = e.target.value; state.dueShow = 60; notify(); }
        if (e.target.dataset.planLight) { if (e.target.checked) state.planPick.add(e.target.dataset.planLight); else state.planPick.delete(e.target.dataset.planLight); const btn = Q('[data-dg="make-plan"]'); if (btn) { btn.disabled = !state.planPick.size; btn.textContent = state.planPick.size ? '선택한 ' + state.planPick.size + '곳 방문 계획' : '시설을 골라 방문 계획'; } e.target.closest('.dg-due-row')?.classList.toggle('picked', e.target.checked); }
        if (e.target.dataset.planVisited !== undefined && state.plan) { state.plan.stops[+e.target.dataset.planVisited].visited = e.target.checked; await root.DGOffline.put('plan', 'current', state.plan); notify(); }
      })().catch(error => api.toast(error.message));
    });
    root.DGOffline.subscribe(event => {
      if (event.type === 'synced' && event.job.kind === 'work') {
        const payload = event.job.payload;
        if (payload && ['acknowledge', 'hold', 'resume'].includes(payload.kind)) finishProcessDraft(payload).catch(error => api.toast(error.message));
        else if (payload && (['create', 'transition', 'update'].includes(payload.kind))) {
          const kind = payload.kind === 'create' ? 'workDraft' : payload.kind === 'update' ? 'workEdit' : 'workCompletion', active = kind === 'workDraft' ? state.draft : kind === 'workEdit' ? state.edit : state.completion;
          const owner = active?.pending === event.job.id ? active : { id: payload.workId, workId: payload.workId, storageId: payload.draftKey || (kind === 'workDraft' ? 'new' : payload.workId), pending: event.job.id };
          clearWorkDraft(owner, kind, { delivered: true }).catch(error => api.toast(error.message));
        }
        load(true);
      }
      if (event.type === 'discarded' && event.job?.kind === 'work') releasePending(event.job).catch(error => api.toast(error.message));
      if (['job', 'synced', 'discarded', 'removed', 'ready'].includes(event.type)) refreshQueue().catch(() => {});
    });
  }
  async function releasePending(job) {
    const owner = captureOwner();
    for (const kind of ['workDraft', 'workCompletion', 'workEdit']) for (const entry of await owner.offline.list(kind)) {
      if (!ownsContext(owner)) return;
      if (entry.value?.pending !== job.id) continue;
      const active = kind === 'workDraft' ? state.draft : kind === 'workEdit' ? state.edit : state.completion;
      const d = active?.storageId === entry.id ? active : adoptDraft(entry.value, kind, entry.id);
      d.pending = null; delete d.process; await writeDraft(d, kind);
      const form = ownerForm(d, kind); if (form) lockForm(form, false);
    }
  }
  async function ready() {
    if (!root.DGOffline.ready) return;
    const owner = captureOwner(), savedPlan = await owner.offline.get('plan', 'current'); if (!ownsContext(owner)) return;
    state.plan = savedPlan ? C.reconcilePlan(savedPlan, api.byId) : null;
    if (savedPlan && JSON.stringify(savedPlan) !== JSON.stringify(state.plan)) await owner.offline.put('plan', 'current', state.plan);
    if (!ownsContext(owner)) return;
    const jobs = new Map((await owner.offline.jobs()).map(job => [job.id, job])); if (!ownsContext(owner)) return;
    for (const kind of ['workDraft', 'workCompletion', 'workEdit']) for (const entry of await owner.offline.list(kind)) {
      if (!ownsContext(owner)) return;
      const d = adoptDraft(entry.value, kind, entry.id); d.photoTasks = 0;
      if (!d.pending) continue;
      const job = jobs.get(d.pending);
      if (job?.kind === 'work' && job.state === 'synced') {
        if (d.process && kind === 'workCompletion') await finishProcessDraft({ id: job.id, workId: d.workId, kind: d.process.kind, input: { expectedRevision: d.process.expectedRevision }, draftKey: d.storageId }, d);
        else await clearWorkDraft(d, kind, { delivered: true });
      }
      else if (!job) { d.pending = null; delete d.process; await writeDraft(d, kind); }
    }
    if (ownsContext(owner)) await refreshQueue();
  }
  root.DGOperations = { attach, ready, load, view, dueView, queueView, openWork, openEdit, openAttention, newWork, submit, download, refreshQueue, state, uuid, workFilters, selectedOrders, fullSelectedOrders, workLights, loadReports, readOrder, sourceText, subscribeUpdates, hasActiveDraft, persistActive, persistNew, persistCompletion, persistEdit, writeDraft, clearWorkDraft,
    inspectionState: light => C.inspectionState(light, Number(state.settings.inspectionDays) || 90, Date.now()) };
})(globalThis);
