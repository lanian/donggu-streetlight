/* Facility histories and explicit report-to-facility/work connections. */
(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./operations-core.js') : root.DGOperationsCore;
  const api = factory(root, core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGWorkflows = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, C) {
  'use strict';
  let api, attached = false, sequence = 0, reportMap = null;
  const state = { report: null, orders: [], candidates: [], reportJob: null, facility: null, loading: false };
  const E = value => api.esc(value), Q = selector => document.querySelector(selector);
  const active = order => !['verified', 'cancelled'].includes(order.status);
  const heading = title => '<div class="sheet-head noprint"><h3>' + E(title) + '</h3><button class="x" data-close aria-label="닫기">×</button></div>';
  const label = id => api.state().names[id] || id || '기록 없음';
  const stamp = value => api.fmtDT(value || 0);
  const supported = () => api.state().me === 'local' || !!api.firebase();
  const options = () => ({ requireServer: !!api.firebase() && navigator.onLine !== false });
  function duplicateCandidates(report, reports) {
    return reports.filter(other => other.id !== report.id && other.status !== '완료' && other.issue === report.issue && Math.abs((other.createdAt || 0) - (report.createdAt || 0)) <= 7 * 86400000 && (report.lightId ? other.lightId === report.lightId : Number.isFinite(report.lat) && Number.isFinite(report.lng) && Number.isFinite(other.lat) && Number.isFinite(other.lng) && C.distance(report, other) <= 30));
  }
  function timelineItems(data) {
    const items = [], add = item => items.push(item);
    for (const row of data.inspections || []) add({ id: 'inspection:' + row.id, kind: row.patrol ? '순찰 직접 관찰' : '점검', at: row.date, by: row.inspector, title: row.result, detail: row.memo || '', photoCount: row.photoN || (row.photo ? 1 : 0), inspectionId: row.id });
    for (const row of data.reports || []) add({ id: 'report:' + row.id, kind: '신고 접수', at: row.createdAt, by: row.reporterId, title: row.issue + ' · ' + row.status, detail: row.desc || row.location || '', reportId: row.id });
    for (const row of data.reportEvents || []) add({ id: 'report-event:' + row.id, kind: '신고 시설 연결', at: row.at, by: row.by, title: (row.fromLightId || '미연결') + ' → ' + row.toLightId, detail: row.reason, reportId: row.reportId });
    const created = new Set((data.events || []).filter(e => e.type === 'created').map(e => e.workId));
    for (const row of data.orders || []) if (!created.has(row.id)) add({ id: 'work:' + row.id, kind: '보수 작업 접수', at: row.createdAt, by: row.createdBy, title: row.title, detail: C.STATES[row.status] || row.status, workId: row.id });
    for (const row of data.events || []) {
      const order = (data.orders || []).find(w => w.id === row.workId);
      add({ id: 'work-event:' + row.id, kind: row.type === 'reports-linked' ? '작업에 신고 연결' : row.toStatus === 'verified' ? '완료 검수' : '작업 처리', at: row.at, by: row.by, title: (order?.title || row.workId) + ' · ' + (C.STATES[row.toStatus] || row.toStatus), detail: row.note || '', workId: row.workId, costDelta: row.costDelta });
    }
    for (const row of data.moves || []) add({ id: 'inventory:' + row.id, kind: '자재 입출고', at: row.at, by: row.by, title: row.itemId + ' · ' + (row.delta > 0 ? '+' : '') + row.delta, detail: row.reason || '', workId: row.workId });
    for (const row of data.light?.edits || []) add({ id: 'edit:' + (row.id || row.at), kind: '시설 정보 변경', at: row.at, by: row.by, title: row.undone ? '변경 되돌림' : '대장 정보 수정', detail: (row.changes || []).map(c => c.f + ': ' + c.from + ' → ' + c.to).join(', ') });
    return items.sort((a, b) => (b.at || 0) - (a.at || 0) || a.id.localeCompare(b.id));
  }
  async function record(collection, id) {
    const snap = await api.database().doc(collection + '/' + id).get(options().requireServer ? { source: 'server' } : undefined);
    return snap?.exists !== false && snap?.data() ? { ...snap.data(), id } : null;
  }
  function lookup(value) { return api.state().lights.find(l => l.id === value || l.code + ' [' + l.id + ']' === value); }
  function choices(query) {
    const q = String(query || '').toLowerCase();
    return api.state().lights.filter(l => !l.removed && (!q || (l.id + ' ' + l.code + ' ' + (l.address || '')).toLowerCase().includes(q))).slice(0, 60).map(l => '<option value="' + E(l.code + ' [' + l.id + ']') + '">' + E(l.address || l.dong) + '</option>').join('');
  }
  function releaseMap() { if (reportMap) { reportMap.remove(); reportMap = null; } }
  async function openReportLink(id) {
    if (!api.can('admin') || !supported()) return api.toast('신고 연결은 관리자와 지원되는 저장소에서 사용할 수 있어요.');
    const token = ++sequence; await root.DGOperations.persistActive();
    const report = await record('reports', id); if (token !== sequence) return;
    if (!report) throw new Error('신고를 찾을 수 없어요.');
    state.report = report; state.reportJob = null; releaseMap();
    const light = report.lightId && api.byId(report.lightId);
    api.navigate(heading('신고 시설 연결·정정') + '<form class="panel" id="dgReportLink" data-report-id="' + E(id) + '"><fieldset style="border:0;padding:0;margin:0;min-width:0"><p><b>' + E(report.issue) + '</b> · ' + E(report.receipt || id) + '</p><p>' + E(report.desc || report.location || '') + '</p><p class="muted">현재 연결: ' + E(light?.code || report.code || '미연결') + '</p><label class="f" for="dgReportFacility">확인한 시설</label><input class="f-in" id="dgReportFacility" list="dgReportChoices" placeholder="표찰 번호·설치 위치 검색" value="' + E(light ? light.code + ' [' + light.id + ']' : '') + '"><datalist id="dgReportChoices">' + choices('') + '</datalist><button type="button" class="btn ghost sm" data-fw="report-map">시설 후보 지도</button><div id="dgReportMap" style="height:260px;display:none;margin-top:10px"></div><label class="f" for="dgReportReason">연결·정정 사유</label><textarea class="f-in" id="dgReportReason" maxlength="500" required placeholder="현장에서 표찰과 위치를 확인한 내용"></textarea><p class="muted">신고 원문과 접수번호는 유지하고 연결 전후 시설·사유·담당자를 이력에 남겨요. 진행 중인 보수 작업에 연결된 신고는 해당 작업을 먼저 확인해 주세요.</p><button class="btn sodium block" type="submit">확인한 시설에 연결</button></fieldset><p class="muted" id="dgReportSaveState" role="status"></p></form>');
  }
  function showReportMap() {
    const form = Q('#dgReportLink'), report = state.report;
    if (!form || form.dataset.reportId !== report?.id || !root.L) return api.toast('지도를 사용할 수 없어요. 번호·위치 검색으로 선택해 주세요.');
    if (reportMap) return reportMap.invalidateSize();
    const origin = Number.isFinite(report.lat) && Number.isFinite(report.lng) ? report : api.state().pos || { lat: 35.145, lng: 126.928 };
    const nearby = api.state().lights.filter(l => !l.removed && Number.isFinite(l.lat) && Number.isFinite(l.lng)).sort((a, b) => C.distance(origin, a) - C.distance(origin, b)).slice(0, 100);
    Q('#dgReportMap').style.display = 'block'; reportMap = root.L.map('dgReportMap').setView([origin.lat, origin.lng], 17); root.DongguPWA.tileLayer(root.L).addTo(reportMap);
    root.L.circleMarker([origin.lat, origin.lng], { color: '#a22' }).addTo(reportMap).bindPopup('신고 위치 또는 현재 위치');
    for (const light of nearby) root.L.circleMarker([light.lat, light.lng], { radius: 7 }).addTo(reportMap).bindPopup('<b>' + E(light.code) + '</b><br>' + E(light.address || light.dong) + '<br><button type="button" class="btn sm" data-fw="choose-facility" data-id="' + E(light.id) + '">이 시설 선택</button>');
  }
  async function saveReportLink(form) {
    if (form !== Q('#dgReportLink') || form.dataset.reportId !== state.report?.id || state.reportJob) return;
    const report = state.report, light = lookup(Q('#dgReportFacility').value), reason = Q('#dgReportReason').value.trim();
    if (!light || light.removed) throw new Error('목록이나 지도에서 실제 시설을 선택해 주세요.');
    if (!reason) throw new Error('시설을 연결하거나 정정한 사유를 입력해 주세요.');
    const job = { id: root.DGOperations.uuid('report-link'), kind: 'report-link', reportId: report.id, actor: api.state().me, at: Date.now(), expectedRevision: report.linkRevision || 0, expectedUpdatedAt: report.updatedAt || report.createdAt || null, light: { id: light.id, code: light.code, dong: light.dong || '' }, reason };
    state.reportJob = job; form.querySelector('fieldset').disabled = true;
    try {
      await root.DGOperations.submit(job, '신고 시설 연결 · ' + light.code);
      if (form.isConnected && Q('#dgReportLink') === form) { releaseMap(); api.closeSheet(); }
    } catch (error) {
      const queued = (await root.DGOffline.jobs()).some(j => j.id === job.id);
      if (!queued && state.reportJob === job) { state.reportJob = null; if (form.isConnected) form.querySelector('fieldset').disabled = false; }
      if (form.isConnected && Q('#dgReportSaveState')) Q('#dgReportSaveState').textContent = queued ? '저장 대기함에서 오류를 확인하고 재시도하거나 대기 작업을 폐기해 주세요.' : error.message;
      throw error;
    }
  }
  async function openReportWork(id) {
    if (!api.can('admin') || !supported()) return api.toast('관리자 권한과 지원되는 저장소가 필요해요.');
    const token = ++sequence; await root.DGOperations.persistActive();
    const report = await record('reports', id);
    if (!report || report.status === '완료') throw new Error('미완료 신고를 선택해 주세요.');
    if (!report.lightId) return openReportLink(id);
    const [orders, reports] = await Promise.all([api.readAll('workOrders', { ...options(), where: [['lightId', '==', report.lightId]] }), api.readAll('reports', { ...options(), where: [['lightId', '==', report.lightId]] })]);
    if (token !== sequence) return;
    state.report = report; state.orders = orders.filter(active); state.candidates = [report, ...duplicateCandidates(report, reports)]; state.reportJob = null; releaseMap();
    api.navigate(heading('신고를 보수 작업에 연결') + '<div class="panel" id="dgReportWork" data-report-id="' + E(id) + '"><fieldset style="border:0;padding:0;margin:0;min-width:0"><p><b>' + E((api.byId(report.lightId) || {}).code || report.code) + '</b> · ' + E(report.issue) + '</p><p class="muted">같은 시설·같은 유형으로 7일 안에 접수된 신고를 중복 후보로 보여요. 실제 같은 고장인지 확인해 필요한 신고만 선택하세요. 원래 신고는 삭제하거나 합치지 않아요.</p>' + state.candidates.map(r => '<label class="dg-option"><input type="checkbox" data-fw-report="' + E(r.id) + '"' + (r.id === id ? ' checked' : '') + '> ' + E(r.receipt || r.id) + ' · ' + stamp(r.createdAt) + '<br>' + E(r.desc || r.location || '') + (r.workId ? '<small>연결 작업 ' + E(r.workId) + '</small>' : '') + '</label>').join('') + '<label class="f" for="dgExistingWork">진행 중인 작업</label><select class="f-in" id="dgExistingWork"><option value="">작업 선택</option>' + state.orders.map(w => '<option value="' + E(w.id) + '"' + (w.id === report.workId ? ' selected' : '') + '>' + E(w.title + ' · ' + C.STATES[w.status]) + '</option>').join('') + '</select><div class="split"><button class="btn sodium" data-fw="link-existing-work"' + (!state.orders.length ? ' disabled' : '') + '>선택한 기존 작업에 연결</button><button class="btn ghost" data-fw="new-from-report">새 작업으로 작성</button></div></fieldset><p class="muted" id="dgWorkLinkState" role="status"></p></div>');
  }
  function selectedReportIds() { return [...document.querySelectorAll('[data-fw-report]:checked')].map(el => el.dataset.fwReport); }
  async function linkExisting() {
    const form = Q('#dgReportWork'), report = state.report;
    if (!form || form.dataset.reportId !== report?.id || state.reportJob) return;
    const work = state.orders.find(w => w.id === Q('#dgExistingWork').value), reportIds = selectedReportIds();
    if (!work || !reportIds.length) throw new Error('작업과 연결할 신고를 선택해 주세요.');
    const versions = Object.fromEntries(state.candidates.filter(r => reportIds.includes(r.id)).map(r => [r.id, r.updatedAt || r.createdAt || null]));
    const job = { id: root.DGOperations.uuid('work-link'), kind: 'link-reports', workId: work.id, actor: api.state().me, at: Date.now(), input: { expectedRevision: work.revision, reportIds }, reportVersions: versions, note: '신고 ' + reportIds.length + '건 연결' };
    state.reportJob = job; form.querySelector('fieldset').disabled = true;
    try { const result = await root.DGOperations.submit(job, '기존 작업에 신고 연결 · ' + work.title); if (form.isConnected && Q('#dgReportWork') === form) { if (result.state === 'synced') await root.DGOperations.openWork(work.id); else api.closeSheet(); } }
    catch (error) { if (!(await root.DGOffline.jobs()).some(j => j.id === job.id)) { state.reportJob = null; if (form.isConnected) form.querySelector('fieldset').disabled = false; } if (form.isConnected && Q('#dgWorkLinkState')) Q('#dgWorkLinkState').textContent = '저장 대기함에서 오류를 확인해 주세요. ' + error.message; throw error; }
  }
  async function readFacility(id) {
    const light = api.byId(id); if (!light) throw new Error('시설을 찾을 수 없어요.');
    const metadata = [], read = (collection, where) => api.readAll(collection, { ...options(), where, onMetadata: m => metadata.push(m) });
    const [inspections, reports, orders, events, incoming, outgoing] = await Promise.all([
      read('inspections', [['lightId', '==', id]]), read('reports', [['lightId', '==', id]]), read('workOrders', [['lightId', '==', id]]), read('workEvents', [['lightId', '==', id]]), read('reportEvents', [['toLightId', '==', id]]), read('reportEvents', [['fromLightId', '==', id]])
    ]);
    const moves = [];
    for (let start = 0; start < orders.length; start += 4) moves.push(...(await Promise.all(orders.slice(start, start + 4).map(w => read('inventoryMoves', [['workId', '==', w.id]])))).flat());
    const sources = [...new Set(metadata.map(m => m.source))];
    const data = { light, inspections, reports, orders, events, moves, reportEvents: [...new Map([...incoming, ...outgoing].map(e => [e.id, e])).values()], metadata: { source: sources.length === 1 ? sources[0] : 'mixed', complete: !!metadata.length && metadata.every(m => m.complete), fetchedAt: Date.now() } };
    data.items = timelineItems(data); return data;
  }
  function facilityHTML(data, controls = true) {
    const open = data.orders.filter(active);
    return '<section class="rep"><h2>' + E(data.light.code) + ' 통합 업무 이력</h2><p class="muted">' + E(root.DGOperations.sourceText(data.metadata)) + ' · 이력 ' + data.items.length + '건</p>' + (controls ? '<div class="split noprint"><button class="btn ghost" data-fw="facility-refresh" data-id="' + E(data.light.id) + '">최신 이력 조회</button><button class="btn ghost" data-fw="facility-print">인쇄 / PDF</button><button class="btn ghost" data-fw="facility-csv">전체 이력 CSV</button><button class="btn ghost" data-light="' + E(data.light.id) + '">시설 점검</button></div>' : '') + '<h3>현재 진행 중 작업 ' + open.length + '건</h3>' + (open.length ? open.map(w => '<div class="panel"><b>' + E(w.title) + '</b><p>' + E(C.STATES[w.status]) + ' · ' + E(w.priority) + ' · 담당 ' + E(label(w.assignedTo)) + ' · 기한 ' + stamp(w.dueAt) + '</p><p class="muted">연결 신고 ' + (w.reportIds || []).length + '건 · 조치 전 ' + (w.beforePhotos || []).length + '장 / 후 ' + (w.afterPhotos || []).length + '장</p>' + (controls ? '<button class="btn ghost sm noprint" data-dg="open-work" data-id="' + E(w.id) + '">작업·증빙 열기</button>' : '') + '</div>').join('') : '<p>진행 중인 보수 작업이 없어요.</p>') + '<h3>시간순 기록</h3>' + (data.items.length ? data.items.map(item => '<div class="hist"><div><b>' + E(item.kind) + '</b> · ' + stamp(item.at) + ' · ' + E(label(item.by)) + '</div><p>' + E(item.title) + '</p>' + (item.detail ? '<p class="dg-pre">' + E(item.detail) + '</p>' : '') + (item.costDelta !== undefined ? '<p class="muted">인정 자재비 증감 ' + Number(item.costDelta).toLocaleString() + '원</p>' : '') + (item.photoCount ? '<p class="muted">점검 사진 ' + item.photoCount + '장</p>' : '') + (controls && item.workId ? '<button class="btn ghost sm noprint" data-dg="open-work" data-id="' + E(item.workId) + '">관련 작업</button>' : '') + '</div>').join('') : '<p>연결된 업무 기록이 없어요.</p>') + '</section>';
  }
  async function openFacility(id) {
    const token = ++sequence; await root.DGOperations.persistActive();
    api.toast('시설의 점검·신고·작업·검수·자재 이력을 조회해요.');
    const data = await readFacility(id); if (token !== sequence) return;
    state.facility = data; releaseMap(); api.navigate(heading('시설 통합 이력') + facilityHTML(data));
  }
  async function renderSummary(id, element) {
    if (!element) return;
    try {
      const orders = await api.readAll('workOrders', { ...options(), where: [['lightId', '==', id]] });
      if (!element.isConnected) return;
      const open = orders.filter(active);
      element.innerHTML = '<b>진행 중인 보수 작업 ' + open.length + '건</b>' + (open.length ? open.map(work => '<p>' + E(work.title) + ' · ' + E(C.STATES[work.status]) + ' · 담당 ' + E(label(work.assignedTo)) + '<button class="btn ghost sm" data-dg="open-work" data-id="' + E(work.id) + '">작업 열기</button></p>').join('') : '<p class="muted">현재 조회한 자료에 진행 중인 작업이 없어요.</p>') + '<button class="btn ghost sm" data-fw="facility" data-id="' + E(id) + '">신고·점검·보수·검수 통합 이력</button>';
    } catch (error) { if (element.isConnected) element.textContent = '진행 작업을 확인하지 못했어요. 통합 이력에서 다시 조회해 주세요.'; }
  }
  async function facilitySection(id, options = {}) {
    const data = await readFacility(id);
    if (options.omitExistingDetails) data.items = data.items.filter(item => !item.inspectionId && item.kind !== '시설 정보 변경');
    return facilityHTML(data, false);
  }
  async function handle(button) {
    const action = button.dataset.fw;
    if (action === 'report-facility') return openReportLink(button.dataset.id);
    if (action === 'report-work') return openReportWork(button.dataset.id);
    if (action === 'report-map') return showReportMap();
    if (action === 'choose-facility') { const light = api.byId(button.dataset.id); if (light && Q('#dgReportFacility')) { Q('#dgReportFacility').value = light.code + ' [' + light.id + ']'; api.toast(light.code + ' 시설을 선택했어요. 연결 사유를 기록해 주세요.'); } return; }
    if (action === 'new-from-report') { const ids = selectedReportIds(); if (!ids.length) throw new Error('연결할 신고를 선택해 주세요.'); return root.DGOperations.newWork(state.report.lightId, ids); }
    if (action === 'link-existing-work') return linkExisting();
    if (action === 'facility' || action === 'facility-refresh') return openFacility(button.dataset.id);
    if (action === 'facility-print') { if (state.facility) api.print(facilityHTML(state.facility, false)); return; }
    if (action === 'facility-csv') { if (state.facility) return root.DGOperations.download('동구_시설통합이력', [['시설', state.facility.light.code], ['조회 출처', root.DGOperations.sourceText(state.facility.metadata)], ['일시', '종류', '내용', '상세', '담당', '작업ID', '신고ID', '인정자재비증감'], ...state.facility.items.map(x => [stamp(x.at), x.kind, x.title, x.detail, label(x.by), x.workId || '', x.reportId || '', x.costDelta ?? ''])]); }
  }
  function attach(context) {
    api = context; if (attached) return; attached = true;
    document.addEventListener('click', event => { const button = event.target.closest('[data-fw]'); if (button) Promise.resolve().then(() => handle(button)).catch(e => api.toast(e.message)); });
    document.addEventListener('input', event => { if (event.target.id === 'dgReportFacility' && Q('#dgReportChoices')) Q('#dgReportChoices').innerHTML = choices(event.target.value); });
    document.addEventListener('submit', event => { if (event.target.id === 'dgReportLink') { event.preventDefault(); saveReportLink(event.target).catch(e => api.toast(e.message)); } });
  }
  return { attach, state, duplicateCandidates, timelineItems, readFacility, facilityHTML, facilitySection, renderSummary, openFacility, openReportLink, openReportWork };
});
