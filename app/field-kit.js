/* Explicit, account-scoped read packages. No server records or map tiles are written. */
(function (root) {
  'use strict';
  const MAX_WORKS = 50, MAX_PHOTOS = 100, MAX_BYTES = 12 * 1024 * 1024, RECENT_INSPECTIONS = 3;
  const ACTIVE = ['draft', 'assigned', 'in_progress', 'completed'];
  const REPORTS_PER_LIGHT = 50;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  let api, attached = false, request = 0, owner = null, loadPromise = null;
  const state = { packet: null, loaded: false, attempt: null, error: '', loading: false, downloading: false, committing: false, works: [], selected: new Set(), scope: 'today', progress: '' };
  const Q = selector => document.querySelector(selector), E = value => api.esc(value);
  function capture() { return { api, actor: api.state().me, db: api.database(), fb: api.firebase(), offline: root.DGOffline, namespace: root.DGOffline.namespace }; }
  function same(a, b) { return !!a && !!b && ['api', 'actor', 'db', 'fb', 'offline', 'namespace'].every(key => a[key] === b[key]); }
  function owned(value) { return same(value, capture()); }
  function reset() {
    const next = capture();
    if (!same(owner, next)) { request++; owner = next; loadPromise = null; Object.assign(state, { packet: null, loaded: false, attempt: null, error: '', loading: false, downloading: false, committing: false, works: [], selected: new Set(), progress: '' }); }
    return owner;
  }
  function notify(value) { if (owned(value || owner)) api.render(); }
  async function ready() {
    const current = reset(); if (!current.offline.ready) return null;
    if (state.loaded) return state.packet;
    if (loadPromise) return loadPromise;
    const pending = (async () => {
      const packet = await current.offline.get('fieldKit', 'current');
      if (!owned(current)) return null;
      if (packet?.schemaVersion === 1 && packet.actor === current.actor && packet.namespace === current.namespace && packet.complete === true) state.packet = packet;
      state.loaded = true;
      return state.packet;
    })();
    loadPromise = pending;
    try { return await pending; } finally { if (loadPromise === pending) loadPromise = null; }
  }
  function todayEnd() {
    const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    return Date.parse(day + 'T23:59:59.999+09:00');
  }
  function scopedWorks(rows) { return rows.filter(work => ACTIVE.includes(work.status) && work.assignedTo === api.state().me && (state.scope === 'all' || !work.dueAt || work.dueAt <= todayEnd())); }
  async function loadWorks() {
    const current = reset(); if (state.downloading) return false;
    const token = ++request; state.loading = true; state.error = ''; notify(current);
    try {
      if (current.fb && root.navigator?.onLine === false) throw new Error('출동 전 자료 준비는 연결된 상태에서 실행해 주세요. 이미 받은 자료는 아래에서 확인할 수 있어요.');
      const metadata = [], rows = await api.readAll('workOrders', { where: [['status', 'in', ACTIVE], ['assignedTo', '==', current.actor]], orderBy: [['updatedAt', 'desc']], requireServer: !!current.fb, onMetadata: value => metadata.push(value) });
      if (!owned(current) || token !== request) return;
      if (current.fb && (!metadata.length || metadata.some(value => value.source !== 'server' || value.complete !== true))) throw new Error('전체 배정 작업을 서버에서 확인하지 못했어요. 연결 후 다시 조회해 주세요.');
      state.works = scopedWorks(rows); state.selected = new Set(state.works.slice(0, MAX_WORKS).map(work => work.id));
    } catch (error) { if (owned(current) && token === request) state.error = error.message; }
    finally { if (owned(current) && token === request) { state.loading = false; notify(current); } }
  }
  async function prepare(ids) {
    const current = reset(); if (state.downloading) return false;
    const workIds = [...new Set(ids || [...state.selected])], token = ++request;
    const active = () => owned(current) && token === request;
    state.downloading = true; state.error = ''; state.progress = ''; state.attempt = { complete: false, missing: [], workIds }; notify(current);
    const missing = [], records = Object.fromEntries(['workOrders', 'lights', 'reports', 'inspections', 'photos', 'assetLinks', 'circuits', 'cabinets'].map(key => [key, {}]));
    const check = () => { if (!active()) throw Object.assign(new Error('계정 또는 준비 대상이 바뀌어 이전 준비를 중단했어요.'), { code: 'cancelled' }); };
    async function read(collection, id, required = true) {
      check(); const snap = await current.db.doc(collection + '/' + id).get(current.fb ? { source: 'server' } : undefined); check();
      const value = snap?.exists === false ? null : typeof snap?.data === 'function' ? snap.data() : snap;
      if (!value) { if (required) missing.push(collection + '/' + id); return null; }
      const result = { ...clone(value), id }; records[collection][id] = result; return result;
    }
    async function rows(collection, options) {
      check(); const metadata = [], result = await api.readAll(collection, { ...options, requireServer: !!current.fb, onMetadata: value => metadata.push(value) }); check();
      if (current.fb && (!metadata.length || metadata.some(value => value.source !== 'server' || value.complete !== true))) throw new Error('서버의 전체 자료를 확인하지 못했어요: ' + collection);
      return result;
    }
    async function boundedRows(collection, lightId, count, activeOnly = false) {
      if (typeof current.db.collection !== 'function') return (await rows(collection, { where: [['lightId', '==', lightId]], orderBy: collection === 'inspections' ? [['date', 'desc']] : undefined })).filter(row => !activeOnly || row.status !== '완료').sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, count);
      check(); let query = current.db.collection(collection).where('lightId', '==', lightId);
      if (activeOnly) query = query.where('status', 'in', ['접수', '처리중']);
      if (collection === 'inspections') query = query.orderBy('date', 'desc');
      const snap = await query.limit(count).get(current.fb ? { source: 'server' } : undefined); check();
      if (current.fb && snap.metadata?.fromCache) throw new Error('서버에서 최신 자료를 확인하지 못했어요: ' + collection);
      return (snap.docs || []).map(doc => ({ ...clone(doc.data()), id: doc.id }));
    }
    try {
      await ready(); check();
      if (!current.offline.ready || !current.actor || !current.db) throw new Error('로그인과 기기 저장소 준비 상태를 확인해 주세요.');
      if (!current.fb && current.actor !== 'local') throw new Error('출동 자료 준비는 기기 체험 또는 Firebase 저장소에서 사용할 수 있어요.');
      if (current.fb && root.navigator?.onLine === false) throw new Error('연결된 상태에서 출동 자료를 준비해 주세요.');
      if (!workIds.length || workIds.length > MAX_WORKS) throw new Error('준비할 작업을 1~' + MAX_WORKS + '건 선택해 주세요.');
      const lightIds = new Set(), photoIds = new Set();
      for (const id of workIds) {
        const work = await read('workOrders', id);
        if (!work) continue;
        if (work.assignedTo !== current.actor || !ACTIVE.includes(work.status)) { missing.push('배정 변경: ' + id); delete records.workOrders[id]; continue; }
        lightIds.add(work.lightId); for (const photoId of [...(work.beforePhotos || []), ...(work.afterPhotos || [])]) photoIds.add(photoId);
        for (const reportId of work.reportIds || []) await read('reports', reportId);
        state.progress = '작업 ' + Object.keys(records.workOrders).length + '/' + workIds.length + '건 확인'; notify(current);
      }
      for (const id of lightIds) {
        const base = api.byId(id); if (!base) { missing.push('시설 대장: ' + id); continue; }
        const patch = await read('lights', id, false);
        records.lights[id] = { ...clone(base), ...(patch || {}), id };
        const link = await read('assetLinks', id, false);
        if (link) { if (link.circuitId) await read('circuits', link.circuitId); if (link.cabinetId) await read('cabinets', link.cabinetId); }
        const latest = await boundedRows('inspections', id, RECENT_INSPECTIONS);
        for (const inspection of latest) { records.inspections[inspection.id] = clone(inspection); for (const thumb of inspection.thumbs || []) if (thumb.id) photoIds.add(thumb.id); }
        const reports = await boundedRows('reports', id, REPORTS_PER_LIGHT + 1, true);
        if (reports.length > REPORTS_PER_LIGHT) throw new Error('한 시설의 미완료 신고가 50건을 넘어요. 신고 상태를 확인한 뒤 다시 준비해 주세요.');
        for (const report of reports) records.reports[report.id] = clone(report);
        const facility = records.lights[id];
        for (const representative of Object.values(facility.reps || {})) if (representative?.id) photoIds.add(representative.id);
        for (const key of ['repWide', 'repPlate', 'repAround']) if (facility[key]?.id) photoIds.add(facility[key].id);
        if (facility.photoId) photoIds.add(facility.photoId);
        if (new TextEncoder().encode(JSON.stringify(records)).length > MAX_BYTES) throw new Error('자료가 12MB 한도를 넘어요. 준비할 작업을 나눠 선택해 주세요.');
      }
      // Work references are enough for field handling; reporter contact/GPS/photo are not copied into packages.
      for (const [id, report] of Object.entries(records.reports)) records.reports[id] = Object.fromEntries(['id', 'lightId', 'workId', 'code', 'dong', 'issue', 'desc', 'status', 'createdAt', 'updatedAt'].filter(key => report[key] !== undefined).map(key => [key, report[key]]));
      if (photoIds.size > MAX_PHOTOS) throw new Error('원본 사진이 ' + MAX_PHOTOS + '장을 넘어요. 준비할 작업을 나눠 선택해 주세요.');
      let payloadBytes = new TextEncoder().encode(JSON.stringify(records)).length;
      for (const id of photoIds) {
        const photo = await read('photos', id);
        if (photo && (!/^data:image\/(jpeg|png|webp);base64,/.test(photo.data || '') || !lightIds.has(photo.lightId))) { missing.push('사진 연결·원본: ' + id); delete records.photos[id]; }
        if (records.photos[id]) payloadBytes += new TextEncoder().encode(JSON.stringify(records.photos[id])).length;
        if (payloadBytes > MAX_BYTES) throw new Error('자료가 12MB 한도를 넘어요. 준비할 작업을 나눠 선택해 주세요.');
        state.progress = '원본 사진 ' + Object.keys(records.photos).length + '/' + photoIds.size + '장 확인'; notify(current);
      }
      check();
      if (missing.length) throw new Error('빠진 자료 ' + missing.length + '건이 있어 준비를 완료하지 않았어요. 이전에 완료한 자료는 유지돼요.');
      const packet = { schemaVersion: 1, actor: current.actor, namespace: current.namespace, preparedAt: Date.now(), complete: true, scope: { workIds, lightIds: [...lightIds], recentInspections: RECENT_INSPECTIONS }, source: current.fb ? 'server' : current.actor === 'local' ? 'local' : 'unknown', records };
      const bytes = new TextEncoder().encode(JSON.stringify(packet)).length;
      if (bytes > MAX_BYTES) throw new Error('자료가 12MB 한도를 넘어요. 준비할 작업을 나눠 선택해 주세요.');
      check(); state.committing = true; state.progress = '자료 보관 중… 저장이 끝날 때까지 기다려 주세요.'; notify(current);
      await current.offline.put('fieldKit', 'current', packet); check();
      state.packet = packet; state.attempt = { complete: true, missing: [], workIds, bytes }; state.progress = '선택한 작업의 자료 준비 완료'; return true;
    } catch (error) {
      if (active()) { state.error = error.message; state.attempt = { complete: false, missing, workIds }; }
      return false;
    } finally { if (active()) { state.downloading = false; state.committing = false; notify(current); } }
  }
  async function record(collection, id) {
    const current = reset(), packet = await ready();
    return owned(current) && packet?.records?.[collection]?.[id] ? clone(packet.records[collection][id]) : null;
  }
  async function getPhoto(id) { const photo = await record('photos', id); return photo && /^data:image\/(jpeg|png|webp);base64,/.test(photo.data || '') ? photo : null; }
  function facility(id) {
    if (!api) return null;
    const current = reset(), packet = state.packet;
    if (!owned(current) || !packet?.scope?.lightIds?.includes(id) || !packet.records?.lights?.[id]) return null;
    const records = packet.records, link = records.assetLinks?.[id] || null;
    return clone({ light: records.lights[id], reports: Object.values(records.reports || {}).filter(row => row.lightId === id), inspections: Object.values(records.inspections || {}).filter(row => row.lightId === id).sort((a, b) => b.date - a.date).slice(0, RECENT_INSPECTIONS), link, circuit: link && records.circuits?.[link.circuitId] || null, cabinet: link && records.cabinets?.[link.cabinetId] || null, preparedAt: packet.preparedAt, source: packet.source, recentInspections: packet.scope.recentInspections });
  }
  async function forLight(collection, id) {
    const current = reset(); await ready(); if (!owned(current)) return null;
    const saved = facility(id); if (!saved) return null;
    const rows = collection === 'inspections' ? saved.inspections : collection === 'reports' ? saved.reports : collection === 'assetLinks' ? [saved.link].filter(Boolean) : collection === 'circuits' ? [saved.circuit].filter(Boolean) : collection === 'cabinets' ? [saved.cabinet].filter(Boolean) : null;
    return rows && { rows, preparedAt: saved.preparedAt, source: saved.source, recentInspections: saved.recentInspections, scope: 'prepared-facility', coverage: collection === 'inspections' ? 'latest-3' : collection === 'reports' ? 'active-and-work-linked' : 'confirmed-link' };
  }
  function currentLight(id) { if (!api) return null; const current = reset(); return root.navigator?.onLine === false && owned(current) && state.packet?.records?.lights?.[id] ? clone(state.packet.records.lights[id]) : null; }
  // The work screen's weak-signal fallback: this account's prepared works, or null until the packet is read.
  function preparedWorks() {
    if (!api) return null; const current = reset();
    if (!state.loaded) { if (!loadPromise && current.offline.ready) ready().then(() => notify(current)).catch(() => {}); return null; }
    const packet = state.packet; if (!owned(current) || !packet) return null;
    return { preparedAt: packet.preparedAt, works: clone(packet.scope.workIds.map(id => packet.records.workOrders[id]).filter(Boolean)) };
  }
  function cancel() { const current = reset(); if (state.committing) return false; request++; state.downloading = false; state.loading = false; state.error = '준비를 중단했어요. 이전에 완료한 자료는 유지돼요.'; notify(current); return true; }
  function view() {
    const current = reset(); if (!state.loaded && !loadPromise && current.offline.ready) ready().then(() => notify(current)).catch(error => { if (owned(current)) state.error = error.message; });
    const packet = state.packet;
    return '<div class="panel"><h3>출동 자료 준비</h3><p>선택한 내 작업과 시설 정보, 미완료 신고 내용, 시설별 최근 점검 3건, 관련 원본 사진을 받아요. 배경지도는 내려받지 않아요.</p><p class="muted">' + (root.DGOffline.durable ? '전용 기기 보관 · 같은 계정에서 다시 열 수 있어요.' : '공유 기기 임시 보관 · 새로고침하거나 창을 닫으면 자료가 사라져요.') + '</p><label class="f" for="fieldKitScope">대상</label><select class="f-in" id="fieldKitScope"' + (state.downloading ? ' disabled' : '') + '><option value="today"' + (state.scope === 'today' ? ' selected' : '') + '>오늘·기한 초과·기한 미정 내 작업</option><option value="all"' + (state.scope === 'all' ? ' selected' : '') + '>내 미완료 작업 전체</option></select><button class="btn ghost" data-fk="load"' + (state.loading || state.downloading ? ' disabled' : '') + '>준비할 작업 조회</button>' +
      (state.loading ? '<p role="status">배정 작업 조회 중…</p>' : '') + (state.error ? '<p class="notice" role="alert">' + E(state.error) + '</p>' : '') +
      (state.works.length ? '<p>조회 ' + state.works.length + '건 · 선택 ' + state.selected.size + '건 (한 번에 최대 50건)</p><p class="muted">50건을 넘으면 위 50건이 먼저 선택돼요. 이번에 가져갈 작업을 확인해 주세요.</p><fieldset style="border:0;padding:0"' + (state.downloading ? ' disabled' : '') + '>' + state.works.map(work => '<label style="display:flex;gap:8px;padding:8px"><input type="checkbox" data-field-kit-work="' + E(work.id) + '"' + (state.selected.has(work.id) ? ' checked' : '') + '>' + E(work.title) + ' · ' + E(work.code || work.lightId) + '</label>').join('') + '<button class="btn sodium" data-fk="prepare">선택 작업 자료 받기</button></fieldset>' : '') +
      (state.downloading ? '<p role="status">' + E(state.progress) + '</p>' + (state.committing ? '' : '<button class="btn ghost" data-fk="cancel">준비 중단</button>') : '') + '</div>' +
      (packet ? '<div class="panel"><h3>보관한 자료 · 준비 완료</h3><p>' + api.fmtDT(packet.preparedAt) + ' · ' + (packet.source === 'server' ? '서버에서 받은 자료' : '이 기기 자료') + '</p><p>선택 작업 ' + packet.scope.workIds.length + '건 · 시설 ' + packet.scope.lightIds.length + '곳 · 원본 사진 ' + Object.keys(packet.records.photos).length + '장</p><p class="muted">받은 시각의 사본이에요. 이후 다른 직원이 바꾼 내용은 다시 준비해야 반영돼요. 저장 명령은 기존 충돌 확인과 전송 대기 절차를 사용해요.</p>' + packet.scope.workIds.map(id => '<button class="btn ghost sm" data-dg="open-work" data-id="' + E(id) + '">' + E(packet.records.workOrders[id].title) + '</button>').join('') + '<button class="btn ghost block" data-fk="discard">보관 자료 지우기</button></div>' : '<p class="empty">아직 완료한 출동 자료가 없어요.</p>');
  }
  function open() { if (api.openSection) return api.openSection('field-kit'); api.navigate('<div class="sheet-head"><h3>출동 자료 준비</h3><button class="x" data-close aria-label="닫기">×</button></div>' + view(), { key: 'field-kit', reopen: open }); }
  async function discard() {
    const current = reset();
    if (!root.DGDialog?.confirm) { api.toast('확인 창을 준비하지 못했어요. 화면을 다시 연 뒤 보관 자료를 지워 주세요.'); return false; }
    const ok = await root.DGDialog.confirm('이 기기에 받은 출동 자료만 지울까요? 서버 기록과 미전송 작업은 유지돼요.', { ok: '보관 자료 지우기' });
    if (!ok || !owned(current) || state.downloading) return;
    await current.offline.remove('fieldKit', 'current'); if (owned(current)) { state.packet = null; notify(current); }
  }
  function attach(context) {
    api = context; reset(); if (attached) return; attached = true;
    root.DGOffline.subscribe?.(event => { if (event.type === 'ready') { reset(); ready().then(() => notify(owner)).catch(() => {}); } });
    document.addEventListener('change', event => {
      if (event.target.id === 'fieldKitScope') { state.scope = event.target.value; state.works = []; state.selected.clear(); notify(reset()); }
      if (event.target.dataset?.fieldKitWork) { const id = event.target.dataset.fieldKitWork; if (event.target.checked) state.selected.add(id); else state.selected.delete(id); }
    });
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-fk]'); if (!button) return;
      Promise.resolve().then(() => ({ load: loadWorks, prepare: () => prepare(), cancel, discard })[button.dataset.fk]?.()).catch(error => api.toast(error.message));
    });
  }
  root.DGFieldKit = { attach, view, open, ready, loadWorks, prepare, record, getPhoto, facility, forLight, currentLight, preparedWorks, cancel, state, MAX_WORKS, MAX_PHOTOS, MAX_BYTES };
})(globalThis);
