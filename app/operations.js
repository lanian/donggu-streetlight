(function (root) {
  'use strict';
  const C = root.DGOperationsCore;
  let api, loading = null, reloadRequested = false, attached = false, detailToken = 0, editorRequest = 0;
  let draftWrites = Promise.resolve();
  const draftVersions = new WeakMap(), editorTokens = new WeakMap();
  let subscriptions = null, watchedWorkKey = '', watchedReportId = '';
  const clone = value => JSON.parse(JSON.stringify(value));
  const state = { orders: [], inventory: [], reports: [], settings: { inspectionDays: 90, privacyDays: 90 }, loaded: false, error: '', at: 0, filter: 'open', mine: false, deadline: 'all', urgent: false, workDong: '전체', show: 40, cursor: null, hasMore: false, workQueryKey: '', queryAt: Date.now(), workMeta: null, draft: null, completion: null, currentOrder: null, reportVersions: {}, lightVersion: null, plan: null, dueFilter: 'needed', dueDong: '전체', dueShow: 60, jobs: [], drafts: [] };
  const uuid = prefix => prefix + '-' + (root.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const E = value => api.esc(value), Q = selector => document.querySelector(selector);
  const time = value => value ? api.fmtDT(value) : '미지정';
  const admin = () => api.can('admin');
  const supported = () => api.state().me === 'local' || !!api.firebase();
  const label = id => api.state().names[id] || (api.state().roles.find(r => r.id === id) || {}).name || (id === 'local' ? '이 기기 관리자' : id || '미배정');
  const options = (values, selected) => values.map(v => '<option value="' + E(v) + '"' + (v === selected ? ' selected' : '') + '>' + E(v) + '</option>').join('');
  const heading = (title, subtitle) => '<div class="sheet-head"><div><h3>' + E(title) + '</h3><div class="muted">' + E(subtitle || '') + '</div></div><button type="button" class="x" data-close aria-label="닫기">×</button></div>';
  const staffOptions = selected => '<option value="">미배정</option>' + [...new Map([{ id: api.state().me, role: admin() ? 'admin' : 'inspector' }, ...api.state().roles].filter(r => ['admin', 'inspector'].includes(r.role)).map(r => [r.id, r])).values()].map(r => '<option value="' + E(r.id) + '"' + (r.id === selected ? ' selected' : '') + '>' + E(label(r.id)) + '</option>').join('');
  function dateInput(ms) { return ms ? C.kstDateKey(ms) : ''; }
  function dueValue(value) { return value ? Date.parse(value + 'T23:59:59.999+09:00') : 0; }
  function notify() { if (api) api.render(); }
  function workFilters() { return { status: state.filter, mine: state.mine, deadline: state.deadline, urgent: state.urgent, dong: state.workDong }; }
  function filterKey() { return JSON.stringify(workFilters()); }
  function selectedOrders(rows = state.orders) { return C.filterOrders(rows, workFilters(), { user: api.state().me, byId: api.byId, inDong: api.inDong, now: state.queryAt }); }
  function sourceText(metadata) {
    if (!metadata) return '조회 전';
    const name = { server: '서버 조회', cache: '기기 캐시 · 전체 여부 미확인', mixed: '서버·캐시 혼합', local: '이 기기 저장', artifact: '공유 저장소 · 전체 여부 미확인', unknown: '자료 출처 미확인' }[metadata.source] || '자료 출처 미확인';
    return name + ' · ' + time(metadata.fetchedAt);
  }
  async function readOrder(id) {
    const snap = await api.database().doc('workOrders/' + id).get(api.firebase() && navigator.onLine !== false ? { source: 'server' } : undefined);
    return snap?.exists !== false && snap?.data() ? { ...snap.data(), id } : null;
  }
  async function loadReports(lightId) {
    const records = await api.readAll('reports', { where: [['lightId', '==', lightId]], requireServer: !!api.firebase() && navigator.onLine !== false });
    state.reports = [...state.reports.filter(r => r.lightId !== lightId), ...records]; bindReportUpdates(lightId); return records;
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
          state.loaded = true; state.error = ''; state.at = meta?.fetchedAt || Date.now();
          if (subscriptions) bindWorkUpdates();
        } catch (error) { state.error = error.message || '업무 기록을 불러오지 못했어요.'; }
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
    if (d && !d.cancelled && ownerForm(d, 'workDraft') && (d.pending || d.photoTasks || Q('#woTitle')?.value || Q('#woDescription')?.value || d.photos?.length)) return true;
    return !!(c && !c.cancelled && ownerForm(c, 'workCompletion') && (c.pending || c.photoTasks || Q('#woCompletionNote')?.value || c.photos?.length));
  }
  function view() {
    ensure(); const rows = state.workQueryKey === filterKey() ? selectedOrders() : [], pending = state.jobs.filter(j => j.kind === 'work' && j.state !== 'synced').length;
    return '<div class="panel"><div class="split"><button class="btn sodium" data-dg="new-work"' + (!admin() || !supported() ? ' disabled' : '') + '>작업 지시 등록</button><button class="btn ghost" data-dg="refresh">새로고침</button><button class="btn ghost" data-dg="work-csv">CSV</button></div>' +
      (!supported() ? '<p class="notice">작업 배정과 검수는 이 기기 저장 또는 Firebase 공유 저장에서 사용할 수 있어요.</p>' : '') +
      '<label class="f" for="woFilter">처리 상태</label><select class="f-in" id="woFilter"><option value="open"' + (state.filter === 'open' ? ' selected' : '') + '>미완료 전체</option><option value="all"' + (state.filter === 'all' ? ' selected' : '') + '>전체 기록</option>' + Object.entries(C.STATES).map(([v, t]) => '<option value="' + v + '"' + (state.filter === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>' +
      '<div class="grid2"><select class="f-in" id="woDeadline" aria-label="완료 기한">' + Object.entries({ all: '기한 전체', today: '오늘 기한 (KST)', overdue: '기한 초과' }).map(([v,t]) => '<option value="' + v + '"' + (state.deadline === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select><select class="f-in" id="woDong" aria-label="작업 대상 동">' + api.dongOptions(state.workDong) + '</select></div><label class="f"><input type="checkbox" id="woUrgent"' + (state.urgent ? ' checked' : '') + '> 긴급 작업만</label>' +
      '<label class="f"><input type="checkbox" id="woMine"' + (state.mine ? ' checked' : '') + '> 내 담당만</label><p class="muted">' + (state.loaded && state.workQueryKey === filterKey() ? sourceText(state.workMeta) + ' · 조회된 ' + rows.length + '건' + (state.hasMore ? ' · 뒤에 자료가 더 있어요' : ' · 조회 범위 끝까지 확인') : '불러오는 중…') + (pending ? ' · 저장 대기 ' + pending + '건' : '') + '</p><div class="split"><button class="btn ghost" data-dg="work-map">조건 전체 지도</button><button class="btn ghost" data-dg="work-plan">조건 전체 방문 계획</button></div><p class="muted">목록은 페이지로 읽고 지도·CSV·방문 계획은 같은 조건의 전체 작업을 조회해요. 오늘 기한은 한국 시간 기준이에요.</p></div>' +
      (state.error ? '<div class="notice" role="alert">' + E(state.error) + '</div>' : '') +
      '<div class="list">' + rows.slice(0, state.show).map(w => '<button class="light-row dg-work-row" data-dg="open-work" data-id="' + E(w.id) + '"><span><b>' + E(w.title) + '</b><small>' + E(w.code) + ' · ' + E(label(w.assignedTo)) + '</small><small>기한 ' + time(w.dueAt) + '</small></span><span class="chip">' + E(C.STATES[w.status] || w.status) + '</span><span class="dg-priority' + (w.priority === '긴급' ? ' urgent' : '') + '">' + E(w.priority) + '</span>' + (w.dueAt && w.dueAt < Date.now() && !['verified', 'cancelled'].includes(w.status) ? '<span class="due">기한 초과</span>' : '') + '</button>').join('') + '</div>' +
      (state.loaded && state.workQueryKey === filterKey() && !rows.length ? '<div class="empty">선택한 조건의 작업이 없어요.</div>' : '') + (rows.length > state.show || state.hasMore ? '<button class="btn ghost block" data-dg="more-work">다음 작업 더 보기</button>' : '');
  }
  function lightMatch(value) { return api.state().lights.find(l => l.id === value || l.code + ' [' + l.id + ']' === value); }
  function lightSuggestions(query) {
    const q = (query || '').toLowerCase();
    return api.state().lights.filter(l => !l.removed && (!q || (l.code + ' ' + l.id + ' ' + (l.address || '')).toLowerCase().includes(q))).slice(0, 50).map(l => '<option value="' + E(l.code + ' [' + l.id + ']') + '">' + E(l.address || l.dong) + '</option>').join('');
  }
  function adoptDraft(d, kind, key, exists = true) {
    d.storageId = key || (kind === 'workDraft' ? d.id : d.workId);
    d.photoTasks = 0;
    draftVersions.set(d, exists ? d.draftRevision || 0 : null);
    editorTokens.set(d, uuid('editor'));
    return d;
  }
  function ownerForm(d, kind) {
    const form = Q(kind === 'workDraft' ? '#woNewForm' : '#woDetail');
    return d && form && form.dataset.editorToken === editorTokens.get(d) ? form : null;
  }
  function writeDraft(d, kind) {
    if (!d || d.cancelled || !root.DGOffline.ready) return draftWrites;
    const value = clone(d), namespace = root.DGOffline.namespace;
    draftWrites = draftWrites.catch(() => {}).then(async () => {
      if (d.cancelled) return;
      if (namespace !== root.DGOffline.namespace) throw new Error('계정이 바뀌어 이전 초안을 현재 계정에 저장하지 않았어요.');
      let key = d.storageId, expected = draftVersions.get(d);
      if (expected === undefined) expected = d.draftRevision || 0;
      try {
        const saved = await root.DGOffline.putIfCurrent(kind, key, { ...value, storageId: key, ...(d.recoveryOf ? { recoveryOf: d.recoveryOf } : {}) }, expected);
        d.draftRevision = saved.draftRevision; draftVersions.set(d, saved.draftRevision);
      } catch (error) {
        if (error.code !== 'conflict') throw error;
        // Each recovery copy still targets the original work's server revision.
        key = uuid('work-recovery');
        const saved = await root.DGOffline.putIfCurrent(kind, key, { ...value, storageId: key, recoveryOf: d.storageId }, null);
        d.recoveryOf = d.storageId; d.storageId = key; d.draftRevision = saved.draftRevision; draftVersions.set(d, saved.draftRevision);
        api.toast('다른 탭의 변경을 유지하고 현재 내용은 별도 복구 초안에 보관했어요.');
        const form = ownerForm(d, kind); if (form) form.dataset.draftId = key;
      }
    });
    return draftWrites;
  }
  function clearWorkDraft(d, kind) {
    if (!d) return draftWrites;
    d.cancelled = true;
    const key = d.storageId || (kind === 'workDraft' ? d.id : d.workId), pending = d.pending;
    if (kind === 'workDraft' && state.draft === d) state.draft = null;
    if (kind === 'workCompletion' && state.completion === d) state.completion = null;
    draftWrites = draftWrites.catch(() => {}).then(async () => {
      const stored = await root.DGOffline.get(kind, key);
      if (stored && stored.pending === pending) await root.DGOffline.removeIfCurrent(kind, key, d.draftRevision ?? stored.draftRevision ?? 0);
    });
    return draftWrites;
  }
  async function persistActive() { await persistNew(); await persistCompletion(); }
  async function newWork(lightId, reportId, resumeId) {
    if (!admin() || !supported()) return api.toast('작업 지시는 관리자와 지원되는 저장소에서 등록할 수 있어요.');
    const request = ++editorRequest;
    await persistActive(); await load(); if (lightId) await loadReports(lightId);
    let d = resumeId ? await root.DGOffline.get('workDraft', resumeId) : null;
    if (request !== editorRequest) return;
    if (resumeId && !d) return api.toast('이어 쓸 초안을 찾을 수 없어요. 저장 대기함을 새로고침해 주세요.');
    if (d) adoptDraft(d, 'workDraft', resumeId);
    else {
      d = { id: uuid('work'), lightId: lightId || '', title: '', description: '', type: '수리', priority: '보통', assignedTo: '', dueAt: 0, beforePhotos: [], reportIds: Array.isArray(reportId) ? [...new Set(reportId)] : reportId ? [reportId] : [], photos: [] };
      adoptDraft(d, 'workDraft', d.id, false);
    }
    state.draft = d; if (!resumeId) await writeDraft(d, 'workDraft');
    if (request === editorRequest && state.draft === d) renderNew();
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
      '<label class="f" for="woBefore">조치 전 사진 (최대 6장)</label><input type="file" id="woBefore" accept="image/*" multiple><div id="woBeforePreview" class="pstrip">' + photoPreviews(d.photos) + '</div>' +
      '<p class="muted" id="woPhotoNotice" role="status"></p><button class="btn sodium block" data-dg="create-work">작업 지시 저장</button></fieldset><p id="woSaveState" class="muted" role="status">' + (d.pending ? '저장 대기함에서 전송 결과를 확인 중이에요. 입력은 전송 완료까지 잠겨요.' : d.recoveryOf ? '다른 탭과 내용이 달라 별도로 보관한 복구 초안이에요.' : '작업별로 초안을 자동 보관해요.') + '</p></div>');
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
    const light = lightMatch(Q('#woLight').value); if (!light || light.id !== d.lightId) return api.toast('목록에서 시설을 선택해 주세요.');
    if (d.pending) return api.toast('이 작업은 저장 대기함에서 처리 중이에요.');
    if (d.photoTasks) return api.toast('첨부 사진을 처리한 뒤 저장해 주세요.');
    const input = Object.fromEntries(['title', 'description', 'type', 'priority', 'assignedTo', 'dueAt', 'reportIds'].map(key => [key, clone(d[key])]));
    input.beforePhotos = d.photos.map(p => p.id);
    C.createOrder(input, light, api.state().me, Date.now());
    const job = { id: uuid('command'), kind: 'create', workId: d.id, actor: api.state().me, at: Date.now(), light: { id: light.id, code: light.code, dong: light.dong || '' }, input, photos: clone(d.photos), draftKey: d.storageId };
    job.reportVersions = Object.fromEntries(state.reports.filter(r => input.reportIds?.includes(r.id)).map(r => [r.id, r.updatedAt || r.createdAt || null]));
    d.pending = job.id; lockForm(form, true); button.disabled = true;
    try {
      await writeDraft(d, 'workDraft'); job.draftKey = d.storageId;
      const result = await submit(job, '작업 등록 · ' + input.title);
      if (result.state === 'synced') await clearWorkDraft(d, 'workDraft');
      if (form.isConnected && Q('#woNewForm') === form) api.closeSheet();
      await load(true);
    } catch (error) {
      const queued = (await root.DGOffline.jobs().catch(() => [])).some(j => j.id === job.id);
      if (!queued) { d.pending = null; await writeDraft(d, 'workDraft').catch(() => {}); }
      throw error;
    } finally { if (form.isConnected) { lockForm(form, !!d.pending); button.disabled = !!d.pending; } }
  }
  async function submit(job, summary) {
    if (!root.DGOffline.ready) throw new Error('저장 대기함을 준비하는 중이에요.');
    const result = await root.DGOffline.submit('work', job, { id: job.id, summary });
    if (result.state === 'synced') api.toast('저장했어요.');
    else if (result.state === 'failed' || result.state === 'conflict') throw new Error(result.error);
    else api.toast(root.DGOffline.durable ? '기기에 보관했어요. 연결되면 전송해요.' : '전송을 기다리고 있어요. 완료 전에는 이 창을 닫지 마세요.');
    await refreshQueue(); return result;
  }
  function partRows(values) {
    return (values || []).map((p, i) => '<tr><td>' + E(p.name) + (p.inventoryId ? '<small>재고 연동</small>' : '') + '</td><td>' + p.qty + '</td><td>' + p.unitCost.toLocaleString() + '</td><td><button class="btn ghost sm" data-dg="remove-part" data-index="' + i + '">삭제</button></td></tr>').join('');
  }
  async function openWork(id, resumeId, navigation = {}) {
    const owned = () => !navigation.isCurrent || navigation.isCurrent();
    if (!owned()) return;
    const request = ++editorRequest, current = () => request === editorRequest && owned();
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
    state.completion = oldCompletion && oldCompletion.expectedRevision === order.revision ? oldCompletion : { workId: id, lightId: order.lightId, expectedRevision: order.revision, photos: [], existingPhotos: order.afterPhotos || [], parts: order.parts || [], measurements: order.measurements || [], note: order.completionNote || '' };
    const completion = adoptDraft(state.completion, 'workCompletion', oldCompletion && oldCompletion.expectedRevision === order.revision ? resumeId || id : id, !!(oldCompletion && oldCompletion.expectedRevision === order.revision));
    if (oldCompletion && oldCompletion.expectedRevision !== order.revision) {
      completion.storageId = uuid('completion'); draftVersions.set(completion, null);
      api.toast('작업 버전이 바뀌었어요. 이전 초안은 대기함에 남기고 최신 작업을 열었어요.');
    }
    const allowed = C.actions(order, api.state().me, admin());
    api.navigate(heading(order.title, order.code + ' · ' + C.STATES[order.status]) + '<div class="panel dg-work-detail" id="woDetail" data-draft-id="' + E(completion.storageId) + '" data-editor-token="' + E(editorTokens.get(completion)) + '"><fieldset style="border:0;padding:0;margin:0;min-width:0"' + (completion.pending ? ' disabled' : '') + '>' +
      '<p>' + E(order.description || '추가 작업 내용 없음') + '</p><p><b>담당</b> ' + E(label(order.assignedTo)) + ' · <b>기한</b> ' + time(order.dueAt) + ' · <b>우선순위</b> ' + E(order.priority) + '</p>' +
      '<button class="btn ghost sm" data-light="' + E(order.lightId) + '">시설 점검 열기</button><h3>조치 전·후 증빙</h3><div id="woEvidence" class="pstrip" aria-live="polite">사진 불러오는 중…</div>' +
      (order.completionNote ? '<h3>조치 내용</h3><p class="dg-pre">' + E(order.completionNote) + '</p>' : '') +
      '<p>자재 비용 ' + Number(order.costTotal || 0).toLocaleString() + '원</p>' + (order.measurements || []).map(m => '<p>실측 조도 ' + E(m.lux) + ' lux · ' + time(m.at) + ' · ' + E(m.note) + '</p>').join('') +
      (order.verificationNote ? '<p class="notice">검수 의견: ' + E(order.verificationNote) + '</p>' : '') +
      (admin() && allowed.includes('assigned') ? '<label class="f" for="woReassign">담당자</label><select class="f-in" id="woReassign">' + staffOptions(order.assignedTo) + '</select><label class="f" for="woNewDue">완료 기한</label><input class="f-in" type="date" id="woNewDue" value="' + dateInput(order.dueAt) + '">' : '') +
      (allowed.includes('completed') ? '<h3>작업 완료 요청</h3><label class="f" for="woCompletionNote">조치 내용</label><textarea class="f-in" id="woCompletionNote" maxlength="2000">' + E(completion.note) + '</textarea><label class="f" for="woAfter">조치 후 사진 (필수, 최대 6장)</label><input type="file" id="woAfter" accept="image/*" multiple><div id="woAfterPreview" class="pstrip">' + photoPreviews(completion.photos) + '</div><p id="woPhotoNotice" class="muted" role="status"></p>' +
      '<h3>사용 자재</h3><div class="grid2"><select class="f-in" id="woStockPart" aria-label="등록 자재"><option value="">직접 입력</option>' + state.inventory.map(p => '<option value="' + E(p.id) + '">' + E(p.name) + ' · 재고 ' + p.quantity + E(p.unit) + '</option>').join('') + '</select><input class="f-in" id="woPartName" placeholder="자재명" aria-label="자재명"></div><div class="grid2"><input class="f-in" id="woPartQty" type="number" min="0.001" step="0.001" value="1" aria-label="사용 수량"><input class="f-in" id="woPartCost" type="number" min="0" value="0" aria-label="단가(원)"></div><button class="btn ghost sm" data-dg="add-part">자재 추가</button><div class="dg-table"><table><thead><tr><th>자재</th><th>수량</th><th>단가</th><th>관리</th></tr></thead><tbody id="woParts">' + partRows(completion.parts) + '</tbody></table></div><p class="muted">재고 연동 자재는 관리자의 완료 검수 시 출고돼요.</p>' +
      '<h3>조도계 실측 (선택)</h3><div class="grid2"><input class="f-in" id="woLux" type="number" min="0" max="200000" step="0.1" placeholder="lux" aria-label="실측 조도"><input class="f-in" id="woLuxNote" maxlength="300" placeholder="측정 위치·기기·조건" aria-label="실측 조건"></div><button class="btn ghost sm" data-dg="add-lux">실측 추가</button><div id="woMeasurements">' + measureRows(completion.measurements) + '</div><p class="muted">조도계로 측정한 값을 입력해요. 지도 밝기 예측과 별도로 보관돼요.</p>' : '') +
      (admin() && order.status === 'completed' ? '<h3>완료 검수</h3><label class="f" for="woVerification">검수 의견 / 보완 사유</label><textarea class="f-in" id="woVerification" maxlength="2000"></textarea><label class="f" for="woFacilityStatus">검수 후 시설 상태</label><select class="f-in" id="woFacilityStatus"><option value="">현재 시설 상태 유지</option>' + options(['정상', '점검필요', '고장', '수리중'], '') + '</select><label class="f"><input type="checkbox" id="woCloseReports"> 연결된 신고도 완료 처리하고 연락처 삭제</label>' : '') +
      '<div class="split">' + allowed.map(target => '<button class="btn' + (target === 'cancelled' ? ' ghost' : ' sodium') + '" data-dg="transition-work" data-id="' + E(id) + '" data-status="' + target + '">' + E({ assigned: '담당 배정', in_progress: order.status === 'completed' ? '보완 요청' : '작업 시작', completed: '완료 검수 요청', verified: '검수 승인', cancelled: '작업 취소', draft: '배정 대기로 복원' }[target]) + '</button>').join('') + '</div></fieldset></div><h3>처리 이력</h3><div id="woEvents" class="panel" aria-live="polite">불러오는 중…</div>');
    const detail = Q('#woDetail'), detailCurrent = () => request === editorRequest && token === detailToken && detail?.isConnected && Q('#woDetail') === detail;
    const evidence = [...(order.beforePhotos || []), ...(order.afterPhotos || [])];
    const results = await Promise.allSettled(evidence.map(async photoId => { const photo = await api.getPhoto(photoId), src = photo && root.DGSecurity.safeImageSrc(photo.data); return src ? '<figure><img src="' + E(src) + '" alt="' + E(photo.label || '작업 사진') + '"><figcaption>' + E(photo.label) + '</figcaption></figure>' : '<p class="notice">원본 사진을 확인할 수 없어요.</p>'; }));
    if (!detailCurrent() || !Q('#woEvidence')) return;
    Q('#woEvidence').innerHTML = results.length ? results.map(r => r.status === 'fulfilled' ? r.value : '<p class="notice">사진 조회 실패</p>').join('') : '<span class="muted">첨부 사진 없음</span>';
    try { const events = await api.readAll('workEvents', { where: [['workId', '==', id]], orderBy: [['at', 'desc']] }); if (detailCurrent() && Q('#woEvents')) Q('#woEvents').innerHTML = events.map(e => '<p><b>' + E(C.STATES[e.toStatus] || e.type) + '</b> · ' + time(e.at) + ' · ' + E(label(e.by)) + (e.note ? '<br>' + E(e.note) : '') + '</p>').join('') || '처리 이력이 없어요.'; }
    catch (error) { if (detailCurrent() && Q('#woEvents')) Q('#woEvents').textContent = '처리 이력을 불러오지 못했어요.'; }
  }
  function measureRows(values) { return values.map((m, i) => '<p>' + m.lux + ' lux · ' + E(m.note) + ' <button class="btn ghost sm" data-dg="remove-lux" data-index="' + i + '">삭제</button></p>').join(''); }
  async function persistCompletion() { const d = state.completion; if (!d || d.pending || !ownerForm(d, 'workCompletion') || !Q('#woCompletionNote')) return; d.note = Q('#woCompletionNote').value; await writeDraft(d, 'workCompletion'); }
  async function transitionWork(button) {
    const order = state.currentOrder, d = state.completion, form = ownerForm(d, 'workCompletion');
    if (!order || order.id !== button.dataset.id || !form || d.pending) return;
    if (d.photoTasks) return api.toast('첨부 사진을 처리한 뒤 저장해 주세요.');
    const target = button.dataset.status;
    if (Q('#woCompletionNote')) await persistCompletion();
    if (ownerForm(d, 'workCompletion') !== form || state.currentOrder !== order) return;
    const input = { expectedRevision: order.revision, ...(Q('#woReassign') ? { assignedTo: Q('#woReassign').value, dueAt: dueValue(Q('#woNewDue').value) } : {}),
      completionNote: d.note, afterPhotos: [...(d.existingPhotos || []), ...d.photos.map(p => p.id)],
      parts: clone(d.parts), measurements: clone(d.measurements), verificationNote: Q('#woVerification') ? Q('#woVerification').value : '' };
    C.transition(order, target, input, api.state().me, admin(), Date.now());
    if (['cancelled', 'verified'].includes(target) && !confirm(target === 'verified' ? '조치 후 원본 사진과 조치 내용을 확인했나요? 검수 승인 시 연결된 자재 재고도 반영돼요.' : '이 작업을 취소할까요? 처리 이력은 유지돼요.')) return;
    const job = { id: uuid('command'), kind: 'transition', workId: order.id, target, actor: api.state().me, at: Date.now(), input, photos: target === 'completed' ? clone(d.photos) : [], facilityStatus: Q('#woFacilityStatus') ? Q('#woFacilityStatus').value : '', lightUpdatedAt: state.lightVersion, closeReports: !!(Q('#woCloseReports') && Q('#woCloseReports').checked), draftKey: d.storageId };
    if (job.closeReports) job.reportVersions = { ...state.reportVersions };
    d.pending = job.id; lockForm(form, true); button.disabled = true;
    try {
      await writeDraft(d, 'workCompletion'); job.draftKey = d.storageId;
      const result = await submit(job, C.STATES[target] + ' · ' + order.title);
      if (result.state === 'synced') {
        await clearWorkDraft(d, 'workCompletion'); await load(true);
        if (form.isConnected && Q('#woDetail') === form) await openWork(order.id, undefined, { isCurrent: () => form.isConnected && Q('#woDetail') === form && Q('#sheet')?.classList.contains('open') && state.currentOrder === order });
      } else if (form.isConnected && Q('#woDetail') === form) api.closeSheet();
    } catch (error) {
      const queued = (await root.DGOffline.jobs().catch(() => [])).some(j => j.id === job.id);
      if (!queued) { d.pending = null; await writeDraft(d, 'workCompletion').catch(() => {}); }
      throw error;
    } finally { if (form.isConnected) { lockForm(form, !!d.pending); button.disabled = !!d.pending; } }
  }
  function dueLights() {
    const now = Date.now(), days = Number(state.settings.inspectionDays) || 90;
    return api.state().lights.filter(l => !l.removed && api.inDong(l, state.dueDong)).map(l => ({ light: l, inspection: C.inspectionState(l, days, now) })).filter(x => state.dueFilter === 'all' || state.dueFilter === 'needed' ? state.dueFilter === 'all' || x.inspection.key !== 'current' : x.inspection.key === state.dueFilter).sort((a, b) => a.inspection.priority - b.inspection.priority || (b.inspection.overdueDays || 0) - (a.inspection.overdueDays || 0));
  }
  function dueView() {
    ensure(); const rows = dueLights(), plan = state.plan;
    return '<div class="panel"><p>점검 주기 ' + (Number(state.settings.inspectionDays) || 90) + '일 · 단순 순찰 통과는 항목별 점검과 구분해요.</p><div class="grid2"><select class="f-in" id="dgDueDong" aria-label="대상 행정동">' + api.dongOptions(state.dueDong) + '</select><select class="f-in" id="dgDueFilter" aria-label="점검 상태">' + Object.entries({ needed: '확인이 필요한 전체', never: '점검 기록 없음', overdue: '기한 초과', redo: '재점검 요청', all: '철거 제외 전체' }).map(([v, t]) => '<option value="' + v + '"' + (state.dueFilter === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div><div class="split"><button class="btn ghost" data-dg="due-map">대상 지도</button><button class="btn sodium" data-dg="make-plan">선택한 시설 방문 계획</button></div><p class="muted">대상 ' + rows.length + '개 · 지도와 목록은 같은 조건을 사용해요.</p></div><div class="list">' + rows.slice(0, state.dueShow).map(({ light: l, inspection: ins }) => '<div class="dg-due-row"><input type="checkbox" data-plan-light="' + E(l.id) + '" aria-label="' + E(l.code + ' 방문 계획에 선택') + '"><button class="light-row" data-light="' + E(l.id) + '"><b>' + E(l.code) + '</b><span class="chip">' + E(l.status) + '</span><small>' + E(ins.label) + ' · ' + E(l.dong) + '</small></button></div>').join('') + '</div>' + (rows.length > state.dueShow ? '<button class="btn ghost block" data-dg="more-due">더 보기</button>' : '') + (plan ? planView(plan) : '');
  }
  function planView(plan) {
    return '<h2>내 방문 계획</h2><div class="panel"><p>직선 연결 약 ' + (plan.distance / 1000).toFixed(1) + 'km · ' + plan.stops.filter(s => s.visited).length + '/' + plan.stops.length + '곳 방문</p><p class="muted">직선 거리로 제안한 방문 순서예요. 차량 통행·일방통행·도로 진입 경로는 현장에서 확인해 주세요. 방문 표시로 점검 결과가 바뀌지는 않아요.</p><div class="split"><button class="btn ghost sm" data-dg="plan-map">계획 지도</button><button class="btn ghost sm" data-dg="plan-csv">계획 CSV</button><button class="btn ghost sm" data-dg="clear-plan">계획 지우기</button></div>' + plan.stops.map((s, i) => '<div class="dg-plan-stop"><label><input type="checkbox" data-plan-visited="' + i + '"' + (s.visited ? ' checked' : '') + '> ' + (i + 1) + '. ' + E(s.code) + '</label><button class="btn ghost sm" data-light="' + E(s.id) + '">점검</button>' + (s.workIds || []).map((id, n) => '<button class="btn ghost sm" data-dg="open-work" data-id="' + E(id) + '">보수 작업 ' + (n + 1) + '</button>').join('') + '<button class="btn ghost sm" data-dg="plan-up" data-index="' + i + '"' + (!i ? ' disabled' : '') + '>위로</button></div>').join('') + '</div>';
  }
  async function refreshQueue() {
    if (!root.DGOffline.ready) return;
    state.jobs = await root.DGOffline.jobs();
    const kinds = await Promise.all(['draft', 'patrol', 'workDraft', 'workCompletion', 'lightingDraft', 'lightingTaskDraft'].map(kind => root.DGOffline.list(kind)));
    state.drafts = kinds.flat(); notify();
  }
  function queueView() {
    const statuses = { queued: '전송 대기', sending: '서버 확인 중', failed: '실패 · 재시도 가능', conflict: '변경 충돌 · 확인 필요', synced: '서버/저장소 반영 완료' };
    return '<div class="panel"><p>' + (root.DGOffline.durable ? '이 기기에 초안과 미전송 작업을 보관해요.' : '공유 기기 모드: 현재 창에서만 대기해요. 전송 완료를 확인한 뒤 닫아 주세요.') + '</p><div class="split"><button class="btn sodium" data-dg="retry-all">대기 작업 전송</button><button class="btn ghost" data-dg="queue-refresh">새로고침</button></div></div><h3>저장 작업 ' + state.jobs.filter(j => j.state !== 'synced').length + '건 대기</h3>' + (state.jobs.length ? state.jobs.map(j => '<div class="panel"><b>' + E(j.summary) + '</b><p>' + statuses[j.state] + ' · ' + time(j.updatedAt) + '</p>' + (j.error ? '<p class="notice">' + E(j.error) + '</p>' : '') + '<div class="split">' + (['queued', 'failed', 'conflict'].includes(j.state) ? '<button class="btn ghost sm" data-dg="retry-job" data-id="' + E(j.id) + '">재시도</button>' : '') + (j.state !== 'sending' ? '<button class="btn ghost sm" data-dg="discard-job" data-id="' + E(j.id) + '">' + (j.state === 'synced' ? '완료 목록에서 지우기' : '대기 작업 폐기') + '</button>' : '') + '</div></div>').join('') : '<div class="empty">대기 중인 저장 작업이 없어요.</div>') +
      '<h3>작성 중인 초안</h3>' + state.drafts.map(d => '<div class="panel"><b>' + E(d.kind === 'draft' ? (api.byId(d.id) || {}).code || d.id : d.kind === 'patrol' ? '이전 순찰' : d.kind === 'lightingDraft' ? '외부 광원·현장 밝기 초안' : d.kind === 'lightingTaskDraft' ? '밝기 재확인 업무 초안' : (d.value?.title || (api.byId(d.value?.lightId) || {}).code || '보수 작업 초안')) + '</b><p class="muted">' + time(d.updatedAt) + '</p><div class="split"><button class="btn ghost sm" data-dg="recover-draft" data-kind="' + E(d.kind) + '" data-id="' + E(d.id) + '">이어 쓰기</button><button class="btn ghost sm" data-dg="discard-draft" data-kind="' + E(d.kind) + '" data-id="' + E(d.id) + '">초안 폐기</button></div></div>').join('');
  }
  async function download(name, rows) {
    const cell = root.DGSecurity ? root.DGSecurity.csvCell : v => '"' + (/^[=+@\-\t\r\n]/.test(String(v || '')) ? "'" : '') + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    await api.download({ filename: name + '.csv', data: '\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n') });
  }
  async function handle(button) {
    const action = button.dataset.dg;
    if (action === 'new-work') return newWork(button.dataset.lightId, button.dataset.reportId);
    if (action === 'open-work') return openWork(button.dataset.id);
    if (action === 'refresh') return load(true);
    if (action === 'more-work') { state.show += 60; if (state.hasMore) await load(false, true); return notify(); }
    if (action === 'create-work') return createWork(button);
    if (action === 'transition-work') return transitionWork(button);
    if (action === 'remove-work-photo') { const source = Q('#woNewForm') ? state.draft : state.completion; if (!source || source.pending) return; source.photos = source.photos.filter(p => p.id !== button.dataset.id); const box = Q(Q('#woNewForm') ? '#woBeforePreview' : '#woAfterPreview'); if (box) box.innerHTML = photoPreviews(source.photos); return Q('#woNewForm') ? persistNew() : persistCompletion(); }
    if (action === 'add-part') { const d = state.completion, item = state.inventory.find(x => x.id === Q('#woStockPart').value), value = { name: item ? item.name : Q('#woPartName').value, qty: Number(Q('#woPartQty').value), unitCost: Number(Q('#woPartCost').value), ...(item ? { inventoryId: item.id } : {}) }; if (!value.name.trim()) throw new Error('자재명을 입력해 주세요.'); d.parts = C.parts([...d.parts, value]); Q('#woParts').innerHTML = partRows(d.parts); return persistCompletion(); }
    if (action === 'remove-part') { state.completion.parts.splice(+button.dataset.index, 1); Q('#woParts').innerHTML = partRows(state.completion.parts); return persistCompletion(); }
    if (action === 'add-lux') { if (Q('#woLux').value === '') throw new Error('측정한 조도를 입력해 주세요.'); state.completion.measurements = C.measurements([...state.completion.measurements, { lux: Number(Q('#woLux').value), at: Date.now(), by: api.state().me, note: Q('#woLuxNote').value }]); Q('#woMeasurements').innerHTML = measureRows(state.completion.measurements); Q('#woLux').value = ''; return persistCompletion(); }
    if (action === 'remove-lux') { state.completion.measurements.splice(+button.dataset.index, 1); Q('#woMeasurements').innerHTML = measureRows(state.completion.measurements); return persistCompletion(); }
    if (action === 'due-map') return api.openMap('custom', { title: '미점검·기한 초과', pts: dueLights().map(x => x.light) });
    if (action === 'more-due') { state.dueShow += 100; return notify(); }
    if (action === 'make-plan') { const chosen = [...document.querySelectorAll('[data-plan-light]:checked')].map(x => api.byId(x.dataset.planLight)).filter(Boolean); if (!chosen.length) throw new Error('방문할 시설을 선택해 주세요.'); state.plan = C.planVisits(chosen, api.state().pos); await root.DGOffline.put('plan', 'current', state.plan); return notify(); }
    if (action === 'plan-map') return api.openMap('custom', { title: '방문 계획 · 직선 순서', pts: state.plan.stops.map(s => api.byId(s.id)).filter(Boolean) });
    if (action === 'plan-up') { const i = +button.dataset.index; if (i > 0) [state.plan.stops[i - 1], state.plan.stops[i]] = [state.plan.stops[i], state.plan.stops[i - 1]]; state.plan.distance = Math.round(state.plan.stops.slice(1).reduce((sum, p, n) => sum + C.distance(state.plan.stops[n], p), 0)); await root.DGOffline.put('plan', 'current', state.plan); return notify(); }
    if (action === 'clear-plan') { if (!confirm('현재 방문 계획을 지울까요? 점검 기록은 유지돼요.')) return; state.plan = null; await root.DGOffline.remove('plan', 'current'); return notify(); }
    if (action === 'plan-csv') return download('동구_방문계획', [['순서', '시설', '시설ID', '법정동', '위도', '경도', '방문', '연결 작업ID'], ...state.plan.stops.map((p, i) => [i + 1, p.code, p.id, p.dong, p.lat, p.lng, p.visited ? '방문' : '미방문', (p.workIds || []).join(' · ')])]);
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
      if (!confirm('이 대기 항목을 지울까요? 이미 서버에 반영된 기록은 삭제하지 않아요.')) return;
      const job = state.jobs.find(j => j.id === button.dataset.id);
      await root.DGOffline.discard(button.dataset.id);
      if (job && job.kind === 'work' && job.payload) await releasePending(job);
      return refreshQueue();
    }
    if (action === 'recover-draft') { if (button.dataset.kind === 'lightingTaskDraft') return root.DGLightingWorkflows.openTask(null, button.dataset.id, true); if (button.dataset.kind === 'lightingDraft') return root.DGLighting.openEditor(null, null, button.dataset.id, true); if (button.dataset.kind === 'draft') return api.openLight(button.dataset.id); if (button.dataset.kind === 'patrol') return api.restorePatrol(); if (button.dataset.kind === 'workCompletion') { const saved = await root.DGOffline.get('workCompletion', button.dataset.id); return saved ? openWork(saved.workId, button.dataset.id) : refreshQueue(); } return newWork(null, null, button.dataset.id); }
    if (action === 'discard-draft') {
      if (!confirm('작성 중인 이 초안을 폐기할까요?')) return;
      const kind = button.dataset.kind, id = button.dataset.id, saved = await root.DGOffline.get(kind, id);
      if (kind === 'lightingTaskDraft') { await root.DGLightingWorkflows.discardDraft(id); return refreshQueue(); }
      if (kind === 'lightingDraft') { const active = root.DGLighting.state.draft; await root.DGLighting.clearDraft(active?.recordId === id ? active : saved); return refreshQueue(); }
      if (kind === 'patrol' && saved) api.removePatrolDraft(saved.sessionId);
      if (['workDraft', 'workCompletion'].includes(kind)) { const active = kind === 'workDraft' ? state.draft : state.completion; const owner = active?.storageId === id ? active : saved; if (owner) { owner.storageId = id; await clearWorkDraft(owner, kind); } return refreshQueue(); }
      await root.DGOffline.remove(kind, id); if (kind === 'draft') await api.removeDraft(id); return refreshQueue();
    }
  }
  function attach(context) {
    api = context;
    root.DGOffline.register('work', job => root.DGWorkCommands.execute(job, { db: api.database(), fb: api.firebase(), user: api.state().me, admin: admin() }));
    if (attached) return; attached = true;
    document.addEventListener('click', e => { const button = e.target.closest('[data-dg]'); if (!button) return; Promise.resolve().then(() => handle(button)).catch(error => api.toast(error.message || '처리하지 못했어요.')); });
    document.addEventListener('input', e => {
      if (e.target.id === 'woLight') { const dl = Q('#woLightChoices'); if (dl) dl.innerHTML = lightSuggestions(e.target.value); }
      if (e.target.closest('#woNewForm') === ownerForm(state.draft, 'workDraft')) persistNew().catch(error => api.toast(error.message));
      if (e.target.id === 'woCompletionNote') persistCompletion().catch(error => api.toast(error.message));
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
        if (e.target.id === 'woLight') {
          const d = readNew(), selected = lightMatch(e.target.value);
          if (!d || d.pending || !ownerForm(d, 'workDraft')) return;
          if (selected && selected.id !== d.lightId) {
            if (d.photos.length) { e.target.value = (api.byId(d.lightId) || {}).code + ' [' + d.lightId + ']'; api.toast('첨부 사진을 뺀 뒤 시설을 변경해 주세요.'); return; }
            d.lightId = selected.id; d.title = selected.code + ' 보수'; d.reportIds = []; await loadReports(selected.id); await writeDraft(d, 'workDraft'); if (state.draft === d && ownerForm(d, 'workDraft')) renderNew();
          }
        }
        if (e.target.closest('#woNewForm') === ownerForm(state.draft, 'workDraft')) await persistNew();
        if (e.target.id === 'woStockPart') { const item = state.inventory.find(x => x.id === e.target.value); if (item) { Q('#woPartName').value = item.name; Q('#woPartCost').value = item.unitCost; } }
        if (e.target.id === 'dgDueDong') { state.dueDong = e.target.value; state.dueShow = 60; notify(); }
        if (e.target.id === 'dgDueFilter') { state.dueFilter = e.target.value; state.dueShow = 60; notify(); }
        if (e.target.dataset.planVisited !== undefined && state.plan) { state.plan.stops[+e.target.dataset.planVisited].visited = e.target.checked; await root.DGOffline.put('plan', 'current', state.plan); notify(); }
      })().catch(error => api.toast(error.message));
    });
    root.DGOffline.subscribe(event => {
      if (event.type === 'synced' && event.job.kind === 'work') {
        const payload = event.job.payload;
        if (payload && (payload.kind === 'create' || payload.kind === 'transition')) {
          const kind = payload.kind === 'create' ? 'workDraft' : 'workCompletion', active = kind === 'workDraft' ? state.draft : state.completion;
          const owner = active?.pending === event.job.id ? active : { id: payload.workId, workId: payload.workId, storageId: payload.draftKey || (kind === 'workDraft' ? 'new' : payload.workId), pending: event.job.id };
          clearWorkDraft(owner, kind).catch(error => api.toast(error.message));
        }
        load(true);
      }
      if (event.type === 'discarded' && event.job?.kind === 'work') releasePending(event.job).catch(error => api.toast(error.message));
      if (['job', 'synced', 'discarded', 'removed', 'ready'].includes(event.type)) refreshQueue().catch(() => {});
    });
  }
  async function releasePending(job) {
    for (const kind of ['workDraft', 'workCompletion']) for (const entry of await root.DGOffline.list(kind)) {
      if (entry.value?.pending !== job.id) continue;
      const active = kind === 'workDraft' ? state.draft : state.completion;
      const d = active?.storageId === entry.id ? active : adoptDraft(entry.value, kind, entry.id);
      d.pending = null; await writeDraft(d, kind);
      const form = ownerForm(d, kind); if (form) lockForm(form, false);
    }
  }
  async function ready() {
    if (!root.DGOffline.ready) return;
    state.plan = await root.DGOffline.get('plan', 'current');
    const jobs = new Map((await root.DGOffline.jobs()).map(job => [job.id, job]));
    for (const kind of ['workDraft', 'workCompletion']) for (const entry of await root.DGOffline.list(kind)) {
      const d = adoptDraft(entry.value, kind, entry.id); d.photoTasks = 0;
      if (!d.pending) continue;
      const job = jobs.get(d.pending);
      if (job?.kind === 'work' && job.state === 'synced') await clearWorkDraft(d, kind);
      else if (!job) { d.pending = null; await writeDraft(d, kind); }
    }
    await refreshQueue();
  }
  root.DGOperations = { attach, ready, load, view, dueView, queueView, openWork, newWork, submit, download, refreshQueue, state, uuid, workFilters, selectedOrders, fullSelectedOrders, workLights, loadReports, readOrder, sourceText, subscribeUpdates, hasActiveDraft, persistActive, persistNew, persistCompletion, writeDraft, clearWorkDraft,
    inspectionState: light => C.inspectionState(light, Number(state.settings.inspectionDays) || 90, Date.now()) };
})(globalThis);
