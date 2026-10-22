(function (root) {
  'use strict';
  const C = root.DGOperationsCore;
  let api, loading = null, reloadRequested = false, attached = false, detailToken = 0;
  const state = { orders: [], inventory: [], reports: [], settings: { inspectionDays: 90, privacyDays: 90 }, loaded: false, error: '', at: 0, filter: 'open', mine: false, show: 40, draft: null, completion: null, currentOrder: null, reportVersions: {}, lightVersion: null, plan: null, dueFilter: 'needed', dueDong: '전체', dueShow: 60, jobs: [], drafts: [] };
  const uuid = prefix => prefix + '-' + (root.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const E = value => api.esc(value), Q = selector => document.querySelector(selector);
  const time = value => value ? api.fmtDT(value) : '미지정';
  const admin = () => api.can('admin');
  const supported = () => api.state().me === 'local' || !!api.firebase();
  const label = id => api.state().names[id] || (api.state().roles.find(r => r.id === id) || {}).name || (id === 'local' ? '이 기기 관리자' : id || '미배정');
  const options = (values, selected) => values.map(v => '<option value="' + E(v) + '"' + (v === selected ? ' selected' : '') + '>' + E(v) + '</option>').join('');
  const heading = (title, subtitle) => '<div class="sheet-head"><div><h3>' + E(title) + '</h3><div class="muted">' + E(subtitle || '') + '</div></div><button type="button" class="x" data-close aria-label="닫기">×</button></div>';
  const staffOptions = selected => '<option value="">미배정</option>' + [...new Map([{ id: api.state().me, role: admin() ? 'admin' : 'inspector' }, ...api.state().roles].filter(r => ['admin', 'inspector'].includes(r.role)).map(r => [r.id, r])).values()].map(r => '<option value="' + E(r.id) + '"' + (r.id === selected ? ' selected' : '') + '>' + E(label(r.id)) + '</option>').join('');
  function dateInput(ms) { if (!ms) return ''; const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dueValue(value) { return value ? new Date(value + 'T23:59:59').getTime() : 0; }
  function notify() { if (api) api.render(); }
  async function load(force) {
    if (loading) { if (force) reloadRequested = true; return loading; }
    if (state.loaded && !force) return state;
    loading = (async () => {
      do {
        reloadRequested = false;
        try {
        const request = { requireServer: !!api.firebase() && navigator.onLine !== false };
        const [orders, inventory, settings, reports] = await Promise.all([api.readAll('workOrders', request), api.readAll('inventory', request), api.readAll('settings', request), api.readAll('reports', request)]);
        state.reports = reports;
        state.orders = orders.sort((a, b) => b.updatedAt - a.updatedAt); state.inventory = inventory.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        state.settings = { ...state.settings, ...(settings.find(x => x.id === 'operations') || {}) };
        state.loaded = true; state.error = ''; state.at = Date.now();
        } catch (error) { state.error = error.message || '업무 기록을 불러오지 못했어요.'; }
      } while (reloadRequested);
      loading = null; notify();
      return state;
    })();
    return loading;
  }
  function ensure() { if (!state.loaded && !loading && !state.error) setTimeout(() => load(), 0); }
  function selectedOrders() { return state.orders.filter(w => (!state.mine || w.assignedTo === api.state().me) && (state.filter === 'all' || state.filter === 'open' ? state.filter === 'all' || !['verified', 'cancelled'].includes(w.status) : w.status === state.filter)); }
  function view() {
    ensure(); const rows = selectedOrders(), pending = state.jobs.filter(j => j.kind === 'work' && j.state !== 'synced').length;
    return '<div class="panel"><div class="split"><button class="btn sodium" data-dg="new-work"' + (!admin() || !supported() ? ' disabled' : '') + '>작업 지시 등록</button><button class="btn ghost" data-dg="refresh">새로고침</button><button class="btn ghost" data-dg="work-csv">CSV</button></div>' +
      (!supported() ? '<p class="notice">작업 배정과 검수는 이 기기 저장 또는 Firebase 공유 저장에서 사용할 수 있어요.</p>' : '') +
      '<label class="f" for="woFilter">처리 상태</label><select class="f-in" id="woFilter"><option value="open"' + (state.filter === 'open' ? ' selected' : '') + '>미완료 전체</option><option value="all"' + (state.filter === 'all' ? ' selected' : '') + '>전체 기록</option>' + Object.entries(C.STATES).map(([v, t]) => '<option value="' + v + '"' + (state.filter === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>' +
      '<label class="f"><input type="checkbox" id="woMine"' + (state.mine ? ' checked' : '') + '> 내 담당만</label><p class="muted">' + (state.loaded ? '조회 ' + time(state.at) + ' · ' + rows.length + '건' : '불러오는 중…') + (navigator.onLine === false ? ' · 오프라인에 보관된 자료' : '') + (pending ? ' · 저장 대기 ' + pending + '건' : '') + '</p></div>' +
      (state.error ? '<div class="notice" role="alert">' + E(state.error) + '</div>' : '') +
      '<div class="list">' + rows.slice(0, state.show).map(w => '<button class="light-row dg-work-row" data-dg="open-work" data-id="' + E(w.id) + '"><span><b>' + E(w.title) + '</b><small>' + E(w.code) + ' · ' + E(label(w.assignedTo)) + '</small><small>기한 ' + time(w.dueAt) + '</small></span><span class="chip">' + E(C.STATES[w.status] || w.status) + '</span><span class="dg-priority' + (w.priority === '긴급' ? ' urgent' : '') + '">' + E(w.priority) + '</span>' + (w.dueAt && w.dueAt < Date.now() && !['verified', 'cancelled'].includes(w.status) ? '<span class="due">기한 초과</span>' : '') + '</button>').join('') + '</div>' +
      (state.loaded && !rows.length ? '<div class="empty">선택한 조건의 작업이 없어요.</div>' : '') + (rows.length > state.show ? '<button class="btn ghost block" data-dg="more-work">더 보기 · ' + (rows.length - state.show) + '건</button>' : '');
  }
  function lightMatch(value) { return api.state().lights.find(l => l.id === value || l.code + ' [' + l.id + ']' === value); }
  function lightSuggestions(query) {
    const q = (query || '').toLowerCase();
    return api.state().lights.filter(l => !l.removed && (!q || (l.code + ' ' + l.id + ' ' + (l.address || '')).toLowerCase().includes(q))).slice(0, 50).map(l => '<option value="' + E(l.code + ' [' + l.id + ']') + '">' + E(l.address || l.dong) + '</option>').join('');
  }
  async function newWork(lightId) {
    if (!admin() || !supported()) return api.toast('작업 지시는 관리자와 지원되는 저장소에서 등록할 수 있어요.');
    await load();
    const existing = root.DGOffline.ready && await root.DGOffline.get('workDraft', 'new');
    state.draft = existing && (!lightId || existing.lightId === lightId) ? existing : { id: uuid('work'), lightId: lightId || '', title: '', description: '', type: '수리', priority: '보통', assignedTo: '', dueAt: 0, beforePhotos: [], reportIds: [], photos: [] };
    renderNew();
  }
  function renderNew() {
    const d = state.draft, light = api.byId(d.lightId);
    const reports = light ? state.reports.filter(r => r.lightId === light.id && r.status !== '완료') : [];
    api.navigate(heading('보수 작업 지시', '시설·신고·담당자·기한을 한 작업으로 연결해요.') + '<div class="panel" id="woNewForm">' +
      '<label class="f" for="woLight">시설 검색</label><input class="f-in" id="woLight" list="woLightChoices" autocomplete="off" placeholder="표찰 번호 또는 설치 위치 검색" value="' + E(light ? light.code + ' [' + light.id + ']' : '') + '"><datalist id="woLightChoices">' + lightSuggestions('') + '</datalist>' +
      '<label class="f" for="woTitle">작업 제목</label><input class="f-in" id="woTitle" maxlength="120" value="' + E(d.title || (light ? light.code + ' 보수' : '')) + '">' +
      '<div class="grid2"><div><label class="f" for="woType">작업 종류</label><select class="f-in" id="woType">' + options(C.TYPES, d.type) + '</select></div><div><label class="f" for="woPriority">우선순위</label><select class="f-in" id="woPriority">' + options(C.PRIORITIES, d.priority) + '</select></div></div>' +
      '<div class="grid2"><div><label class="f" for="woAssignee">담당자</label><select class="f-in" id="woAssignee">' + staffOptions(d.assignedTo) + '</select></div><div><label class="f" for="woDue">완료 기한</label><input class="f-in" type="date" id="woDue" value="' + dateInput(d.dueAt) + '"></div></div>' +
      '<label class="f" for="woDescription">작업 내용</label><textarea class="f-in" id="woDescription" maxlength="2000">' + E(d.description) + '</textarea>' +
      '<label class="f">연결할 미완료 신고</label><div id="woReportLinks">' + (reports.length ? reports.map(r => '<label class="dg-option"><input type="checkbox" data-work-report="' + E(r.id) + '"' + (d.reportIds.includes(r.id) ? ' checked' : '') + '> ' + E(r.issue + ' · ' + (r.desc || r.location || '')) + '</label>').join('') : '<p class="muted">이 시설에 연결된 미완료 신고가 없어요.</p>') + '</div>' +
      '<label class="f" for="woBefore">조치 전 사진 (최대 6장)</label><input type="file" id="woBefore" accept="image/*" multiple><div id="woBeforePreview" class="pstrip">' + photoPreviews(d.photos) + '</div>' +
      '<p class="muted" id="woPhotoNotice" role="status"></p><button class="btn sodium block" data-dg="create-work">작업 지시 저장</button></div>');
  }
  function readNew() {
    const d = state.draft; if (!d || !Q('#woNewForm')) return d;
    Object.assign(d, { title: Q('#woTitle').value, description: Q('#woDescription').value, type: Q('#woType').value, priority: Q('#woPriority').value, assignedTo: Q('#woAssignee').value, dueAt: dueValue(Q('#woDue').value), reportIds: [...document.querySelectorAll('[data-work-report]:checked')].map(x => x.dataset.workReport) });
    return d;
  }
  async function persistNew() { if (state.draft && root.DGOffline.ready) await root.DGOffline.put('workDraft', 'new', readNew()); }
  function photoPreviews(photos) { return (photos || []).map(p => '<figure><img src="' + E(p.data.data) + '" alt="' + E(p.data.label) + '"><figcaption>' + E(p.data.label) + '</figcaption><button class="btn ghost sm" data-dg="remove-work-photo" data-id="' + E(p.id) + '">빼기</button></figure>').join(''); }
  async function addPhotos(files, before) {
    const source = before ? state.draft : state.completion;
    if (!source) return;
    const workId = before ? source.id : source.workId, lightId = source.lightId, light = api.byId(lightId);
    if (!light) return api.toast('사진을 연결할 시설을 먼저 선택해 주세요.');
    const values = source.photos || (source.photos = []), existing = before ? 0 : (source.existingPhotos || []).length;
    for (const file of [...files]) {
      if (values.length + existing >= 6) { api.toast('사진은 전후 각각 최대 6장까지예요.'); break; }
      if (!file.type.startsWith('image/') || file.size > 25 * 1024 * 1024) { api.toast('25MB 이하의 이미지 파일을 선택해 주세요.'); continue; }
      const image = await api.processPhoto(file);
      if (source.cancelled || source.lightId !== lightId) { api.toast('사진 작업이 취소되거나 시설이 바뀌었어요. 확인한 뒤 다시 첨부해 주세요.'); break; }
      values.push({ id: uuid('work-photo'), data: { lightId, code: light.code, dong: light.dong || '', workId, kind: 'work', data: image.data, label: before ? '조치 전' : '조치 후', note: '', w: image.w, h: image.h, at: Date.now(), by: api.state().me } });
      if (image.warning && Q('#woPhotoNotice')) Q('#woPhotoNotice').textContent = image.warning;
      if (root.DGOffline.ready) await root.DGOffline.put(before ? 'workDraft' : 'workCompletion', before ? 'new' : workId, source);
      if ((before ? state.draft : state.completion) === source) { const box = Q(before ? '#woBeforePreview' : '#woAfterPreview'); if (box) box.innerHTML = photoPreviews(values); }
    }
  }
  async function createWork(button) {
    const d = readNew(), light = d && lightMatch(Q('#woLight').value); if (!light || light.id !== d.lightId) return api.toast('목록에서 시설을 선택해 주세요.');
    if (d.pending) return api.toast('이 작업은 저장 대기함에서 처리 중이에요.');
    const input = { ...d, beforePhotos: d.photos.map(p => p.id) }; delete input.photos; delete input.id;
    C.createOrder(input, light, api.state().me, Date.now());
    const job = { id: uuid('command'), kind: 'create', workId: d.id, actor: api.state().me, at: Date.now(), light: { id: light.id, code: light.code, dong: light.dong }, input, photos: d.photos };
    d.pending = job.id; await persistNew(); button.disabled = true;
    try { await submit(job, '작업 등록 · ' + input.title); api.closeSheet(); await load(true); }
    catch (error) { d.pending = null; await persistNew(); throw error; }
    finally { button.disabled = false; }
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
  async function openWork(id) {
    await load(); const order = state.orders.find(w => w.id === id); if (!order) return api.toast('작업을 찾을 수 없어요. 새로고침해 주세요.');
    state.currentOrder = JSON.parse(JSON.stringify(order));
    state.lightVersion = (api.byId(order.lightId) || {}).updatedAt || null;
    state.reportVersions = Object.fromEntries((order.reportIds || []).map(reportId => { const r = state.reports.find(x => x.id === reportId); return [reportId, r && (r.updatedAt || r.createdAt || null)]; }));
    const token = ++detailToken;
    const oldCompletion = root.DGOffline.ready && await root.DGOffline.get('workCompletion', id);
    state.completion = oldCompletion && oldCompletion.expectedRevision === order.revision ? oldCompletion : { workId: id, lightId: order.lightId, expectedRevision: order.revision, photos: [], existingPhotos: order.afterPhotos || [], parts: order.parts || [], measurements: order.measurements || [], note: order.completionNote || '' };
    const completion = state.completion, allowed = C.actions(order, api.state().me, admin());
    api.navigate(heading(order.title, order.code + ' · ' + C.STATES[order.status]) + '<div class="panel dg-work-detail">' +
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
      '<div class="split">' + allowed.map(target => '<button class="btn' + (target === 'cancelled' ? ' ghost' : ' sodium') + '" data-dg="transition-work" data-id="' + E(id) + '" data-status="' + target + '">' + E({ assigned: '담당 배정', in_progress: order.status === 'completed' ? '보완 요청' : '작업 시작', completed: '완료 검수 요청', verified: '검수 승인', cancelled: '작업 취소', draft: '배정 대기로 복원' }[target]) + '</button>').join('') + '</div></div><h3>처리 이력</h3><div id="woEvents" class="panel" aria-live="polite">불러오는 중…</div>');
    const evidence = [...(order.beforePhotos || []), ...(order.afterPhotos || [])];
    const results = await Promise.allSettled(evidence.map(async photoId => { const photo = await api.getPhoto(photoId), src = photo && root.DGSecurity.safeImageSrc(photo.data); return src ? '<figure><img src="' + E(src) + '" alt="' + E(photo.label || '작업 사진') + '"><figcaption>' + E(photo.label) + '</figcaption></figure>' : '<p class="notice">원본 사진을 확인할 수 없어요.</p>'; }));
    if (token !== detailToken || !Q('#woEvidence')) return;
    Q('#woEvidence').innerHTML = results.length ? results.map(r => r.status === 'fulfilled' ? r.value : '<p class="notice">사진 조회 실패</p>').join('') : '<span class="muted">첨부 사진 없음</span>';
    try { const events = await api.readAll('workEvents', { where: [['workId', '==', id]], orderBy: [['at', 'desc']] }); if (token === detailToken && Q('#woEvents')) Q('#woEvents').innerHTML = events.map(e => '<p><b>' + E(C.STATES[e.toStatus] || e.type) + '</b> · ' + time(e.at) + ' · ' + E(label(e.by)) + (e.note ? '<br>' + E(e.note) : '') + '</p>').join('') || '처리 이력이 없어요.'; }
    catch (error) { if (token === detailToken && Q('#woEvents')) Q('#woEvents').textContent = '처리 이력을 불러오지 못했어요.'; }
  }
  function measureRows(values) { return values.map((m, i) => '<p>' + m.lux + ' lux · ' + E(m.note) + ' <button class="btn ghost sm" data-dg="remove-lux" data-index="' + i + '">삭제</button></p>').join(''); }
  async function persistCompletion() { const d = state.completion; if (!d) return; if (Q('#woCompletionNote')) d.note = Q('#woCompletionNote').value; if (root.DGOffline.ready) await root.DGOffline.put('workCompletion', d.workId, d); }
  async function transitionWork(button) {
    const order = state.currentOrder; if (!order || order.id !== button.dataset.id) return;
    const target = button.dataset.status, d = state.completion;
    if (Q('#woCompletionNote')) await persistCompletion();
    const input = { expectedRevision: order.revision, ...(Q('#woReassign') ? { assignedTo: Q('#woReassign').value, dueAt: dueValue(Q('#woNewDue').value) } : {}),
      completionNote: d ? d.note : '', afterPhotos: d ? [...(d.existingPhotos || []), ...d.photos.map(p => p.id)] : order.afterPhotos,
      parts: d ? d.parts : order.parts, measurements: d ? d.measurements : order.measurements, verificationNote: Q('#woVerification') ? Q('#woVerification').value : '' };
    C.transition(order, target, input, api.state().me, admin(), Date.now());
    if (['cancelled', 'verified'].includes(target) && !confirm(target === 'verified' ? '조치 후 원본 사진과 조치 내용을 확인했나요? 검수 승인 시 연결된 자재 재고도 반영돼요.' : '이 작업을 취소할까요? 처리 이력은 유지돼요.')) return;
    const job = { id: uuid('command'), kind: 'transition', workId: order.id, target, actor: api.state().me, at: Date.now(), input, photos: target === 'completed' && d ? d.photos : [], facilityStatus: Q('#woFacilityStatus') ? Q('#woFacilityStatus').value : '', lightUpdatedAt: state.lightVersion, closeReports: !!(Q('#woCloseReports') && Q('#woCloseReports').checked) };
    if (job.closeReports) job.reportVersions = { ...state.reportVersions };
    button.disabled = true;
    try { const result = await submit(job, C.STATES[target] + ' · ' + order.title); if (result.state === 'synced') { await load(true); await openWork(order.id); } else api.closeSheet(); }
    finally { button.disabled = false; }
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
    return '<h2>내 방문 계획</h2><div class="panel"><p>직선 연결 약 ' + (plan.distance / 1000).toFixed(1) + 'km · ' + plan.stops.filter(s => s.visited).length + '/' + plan.stops.length + '곳 방문</p><p class="muted">직선 거리로 제안한 방문 순서예요. 차량 통행·일방통행·도로 진입 경로는 현장에서 확인해 주세요. 방문 표시로 점검 결과가 바뀌지는 않아요.</p><div class="split"><button class="btn ghost sm" data-dg="plan-map">계획 지도</button><button class="btn ghost sm" data-dg="plan-csv">계획 CSV</button><button class="btn ghost sm" data-dg="clear-plan">계획 지우기</button></div>' + plan.stops.map((s, i) => '<div class="dg-plan-stop"><label><input type="checkbox" data-plan-visited="' + i + '"' + (s.visited ? ' checked' : '') + '> ' + (i + 1) + '. ' + E(s.code) + '</label><button class="btn ghost sm" data-light="' + E(s.id) + '">점검</button><button class="btn ghost sm" data-dg="plan-up" data-index="' + i + '"' + (!i ? ' disabled' : '') + '>위로</button></div>').join('') + '</div>';
  }
  async function refreshQueue() {
    if (!root.DGOffline.ready) return;
    state.jobs = await root.DGOffline.jobs();
    const kinds = await Promise.all(['draft', 'patrol', 'workDraft', 'workCompletion', 'lightingDraft'].map(kind => root.DGOffline.list(kind)));
    state.drafts = kinds.flat(); notify();
  }
  function queueView() {
    const statuses = { queued: '전송 대기', sending: '서버 확인 중', failed: '실패 · 재시도 가능', conflict: '변경 충돌 · 확인 필요', synced: '서버/저장소 반영 완료' };
    return '<div class="panel"><p>' + (root.DGOffline.durable ? '이 기기에 초안과 미전송 작업을 보관해요.' : '공유 기기 모드: 현재 창에서만 대기해요. 전송 완료를 확인한 뒤 닫아 주세요.') + '</p><div class="split"><button class="btn sodium" data-dg="retry-all">대기 작업 전송</button><button class="btn ghost" data-dg="queue-refresh">새로고침</button></div></div><h3>저장 작업 ' + state.jobs.filter(j => j.state !== 'synced').length + '건 대기</h3>' + (state.jobs.length ? state.jobs.map(j => '<div class="panel"><b>' + E(j.summary) + '</b><p>' + statuses[j.state] + ' · ' + time(j.updatedAt) + '</p>' + (j.error ? '<p class="notice">' + E(j.error) + '</p>' : '') + '<div class="split">' + (['queued', 'failed', 'conflict'].includes(j.state) ? '<button class="btn ghost sm" data-dg="retry-job" data-id="' + E(j.id) + '">재시도</button>' : '') + (j.state !== 'sending' ? '<button class="btn ghost sm" data-dg="discard-job" data-id="' + E(j.id) + '">' + (j.state === 'synced' ? '완료 목록에서 지우기' : '대기 작업 폐기') + '</button>' : '') + '</div></div>').join('') : '<div class="empty">대기 중인 저장 작업이 없어요.</div>') +
      '<h3>작성 중인 초안</h3>' + state.drafts.map(d => '<div class="panel"><b>' + E(d.kind === 'draft' ? (api.byId(d.id) || {}).code || d.id : d.kind === 'patrol' ? '이전 순찰' : d.kind === 'lightingDraft' ? '외부 광원·현장 밝기 초안' : '보수 작업 초안') + '</b><p class="muted">' + time(d.updatedAt) + '</p><div class="split"><button class="btn ghost sm" data-dg="recover-draft" data-kind="' + E(d.kind) + '" data-id="' + E(d.id) + '">이어 쓰기</button><button class="btn ghost sm" data-dg="discard-draft" data-kind="' + E(d.kind) + '" data-id="' + E(d.id) + '">초안 폐기</button></div></div>').join('');
  }
  async function download(name, rows) {
    const cell = root.DGSecurity ? root.DGSecurity.csvCell : v => '"' + (/^[=+@\-\t\r\n]/.test(String(v || '')) ? "'" : '') + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    await api.download({ filename: name + '.csv', data: '\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n') });
  }
  async function handle(button) {
    const action = button.dataset.dg;
    if (action === 'new-work') return newWork(button.dataset.lightId);
    if (action === 'open-work') return openWork(button.dataset.id);
    if (action === 'refresh') return load(true);
    if (action === 'more-work') { state.show += 60; return notify(); }
    if (action === 'create-work') return createWork(button);
    if (action === 'transition-work') return transitionWork(button);
    if (action === 'remove-work-photo') { const source = Q('#woNewForm') ? state.draft : state.completion; source.photos = source.photos.filter(p => p.id !== button.dataset.id); const box = Q(Q('#woNewForm') ? '#woBeforePreview' : '#woAfterPreview'); if (box) box.innerHTML = photoPreviews(source.photos); return Q('#woNewForm') ? persistNew() : persistCompletion(); }
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
    if (action === 'plan-csv') return download('동구_방문계획', [['순서', '시설', '시설ID', '법정동', '위도', '경도', '방문'], ...state.plan.stops.map((p, i) => [i + 1, p.code, p.id, p.dong, p.lat, p.lng, p.visited ? '방문' : '미방문'])]);
    if (action === 'work-csv') return download('동구_보수작업', [['작업', '시설', '담당', '상태', '기한', '비용', '완료'], ...selectedOrders().map(w => [w.title, w.code, label(w.assignedTo), C.STATES[w.status], time(w.dueAt), w.costTotal, time(w.verifiedAt)])]);
    if (action === 'queue-refresh') return refreshQueue();
    if (action === 'retry-all') { await root.DGOffline.flush({ retry: true }); return refreshQueue(); }
    if (action === 'retry-job') { const result = await root.DGOffline.retry(button.dataset.id); api.toast(result.state === 'synced' ? '저장했어요.' : result.error || '전송을 기다리고 있어요.'); return refreshQueue(); }
    if (action === 'discard-job') {
      if (!confirm('이 대기 항목을 지울까요? 이미 서버에 반영된 기록은 삭제하지 않아요.')) return;
      const job = state.jobs.find(j => j.id === button.dataset.id);
      await root.DGOffline.discard(button.dataset.id);
      if (job && job.kind === 'work' && job.payload && job.payload.kind === 'create') {
        const d = await root.DGOffline.get('workDraft', 'new');
        if (d && d.pending === job.id) { delete d.pending; await root.DGOffline.put('workDraft', 'new', d); if (state.draft && state.draft.id === d.id) delete state.draft.pending; }
      }
      return refreshQueue();
    }
    if (action === 'recover-draft') { if (button.dataset.kind === 'lightingDraft') return root.DGLighting.openEditor(null, null, button.dataset.id, true); if (button.dataset.kind === 'draft') return api.openLight(button.dataset.id); if (button.dataset.kind === 'patrol') return api.restorePatrol(); if (button.dataset.kind === 'workCompletion') return openWork(button.dataset.id); return newWork(); }
    if (action === 'discard-draft') {
      if (!confirm('작성 중인 이 초안을 폐기할까요?')) return;
      const kind = button.dataset.kind, id = button.dataset.id, saved = await root.DGOffline.get(kind, id);
      if (kind === 'lightingDraft') { const active = root.DGLighting.state.draft; await root.DGLighting.clearDraft(active?.recordId === id ? active : saved); return refreshQueue(); }
      if (kind === 'patrol' && saved) api.removePatrolDraft(saved.sessionId);
      if (kind === 'workDraft' && state.draft && saved && state.draft.id === saved.id) state.draft.cancelled = true;
      if (kind === 'workCompletion' && state.completion && state.completion.workId === id) state.completion.cancelled = true;
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
      if (e.target.closest('#woNewForm')) persistNew().catch(error => api.toast(error.message));
      if (e.target.id === 'woCompletionNote') persistCompletion().catch(error => api.toast(error.message));
    });
    document.addEventListener('change', e => {
      (async () => {
        if (e.target.id === 'woFilter') { state.filter = e.target.value; state.show = 40; notify(); }
        if (e.target.id === 'woMine') { state.mine = e.target.checked; notify(); }
        if (e.target.id === 'woLight') {
          const d = readNew(), selected = lightMatch(e.target.value);
          if (selected && selected.id !== d.lightId) {
            if (d.photos.length) { e.target.value = (api.byId(d.lightId) || {}).code + ' [' + d.lightId + ']'; api.toast('첨부 사진을 뺀 뒤 시설을 변경해 주세요.'); return; }
            d.lightId = selected.id; d.title = selected.code + ' 보수'; d.reportIds = []; await persistNew(); renderNew();
          }
        }
        if (e.target.closest('#woNewForm')) await persistNew();
        if (e.target.id === 'woBefore') await addPhotos(e.target.files, true);
        if (e.target.id === 'woAfter') await addPhotos(e.target.files, false);
        if (e.target.id === 'woStockPart') { const item = state.inventory.find(x => x.id === e.target.value); if (item) { Q('#woPartName').value = item.name; Q('#woPartCost').value = item.unitCost; } }
        if (e.target.id === 'dgDueDong') { state.dueDong = e.target.value; state.dueShow = 60; notify(); }
        if (e.target.id === 'dgDueFilter') { state.dueFilter = e.target.value; state.dueShow = 60; notify(); }
        if (e.target.dataset.planVisited !== undefined && state.plan) { state.plan.stops[+e.target.dataset.planVisited].visited = e.target.checked; await root.DGOffline.put('plan', 'current', state.plan); notify(); }
      })().catch(error => api.toast(error.message));
    });
    root.DGOffline.subscribe(event => {
      if (event.type === 'synced' && event.job.kind === 'work') {
        const payload = event.job.payload;
        if (payload.kind === 'create') { root.DGOffline.get('workDraft', 'new').then(d => d && d.id === payload.workId ? root.DGOffline.remove('workDraft', 'new') : null).catch(() => {}); }
        if (payload.target === 'completed') root.DGOffline.remove('workCompletion', payload.workId).catch(() => {});
        load(true);
      }
      if (['job', 'synced', 'discarded', 'removed', 'ready'].includes(event.type)) refreshQueue().catch(() => {});
    });
  }
  async function ready() { if (root.DGOffline.ready) { state.plan = await root.DGOffline.get('plan', 'current'); await refreshQueue(); } }
  root.DGOperations = { attach, ready, load, view, dueView, queueView, openWork, newWork, submit, download, refreshQueue, state, uuid,
    inspectionState: light => C.inspectionState(light, Number(state.settings.inspectionDays) || 90, Date.now()) };
})(globalThis);
