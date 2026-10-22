/* Supplemental light sources and field evidence remain separate from the managed registry. */
(function (root) {
  'use strict';
  let api, attached = false, loading = null, reloadRequested = false, signature = '', unsubscribe, draftWrites = Promise.resolve(), editorMap;
  const state = { records: [], loaded: false, error: '', revision: 0, draft: null, filter: 'all', show: 40 };
  const Q = selector => document.querySelector(selector), E = value => api.esc(value == null ? '' : value);
  const CATEGORIES = { other_public: '다른 공공기관', private: '민간·공동주택', shop: '상가', building: '건물', unknown: '관리 주체 미확인', field: '현장 관찰' };
  const LEVELS = { bright: '밝음', adequate: '보통', dark: '어두움', unknown: '판단 보류' };
  const REASONS = { linked_registry: '관리 대장과 연결됨 · 중복 합산 제외', unresolved_link: '연결된 대장 ID 확인 필요', possible_registry_duplicate: '5m 이내 대장 시설 · 별개 광원 확인 필요', duplicate_source: '같은 위치의 중복 기록', not_night_confirmed: '야간 확인 필요', stale: '재확인 기한 경과', future: '관찰 시간이 아직 지나지 않음', off: '꺼짐 확인', unknown_status: '점등 상태 미확인', unknown_schedule: '점등 시간 미확인', outside_schedule: '선택 시간대 밖', invalid_record: '기록 형식 확인 필요', removed: '제외한 기록' };
  const CLASSIFICATIONS = { observed_dark: '현장 어두움 관찰', observed_bright: '현장 밝음·보통 관찰', conflict: '현장 관찰 충돌', external_supported: '외부 광원으로 모델 보완', partial_supported: '일부 범위 보완 · 나머지 확인', data_gap: '대장 광원 정보 부족', model_weak: '모델상 부족 후보', model_lit: '모델상 기준 지수 이상' };
  const minuteText = minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
  const parseMinute = value => /^\d{2}:\d{2}$/.test(value || '') ? +value.slice(0, 2) * 60 + +value.slice(3) : NaN;
  const kstInput = time => Number.isFinite(time) && time > 0 ? new Date(time + 9 * 3600000).toISOString().slice(0, 16) : '';
  const kstTime = time => Number.isFinite(time) ? kstInput(time).replace('T', ' ') + ' KST' : '시각 미입력';
  const uuid = prefix => root.DGData.newId(prefix);
  function canWrite() { return api.can('inspect') && api.state().canWrite && (!!api.firebase() || typeof api.database()?.commitMany === 'function'); }
  function canEdit(record) { return canWrite() && (api.can('admin') || record.createdBy === api.state().me); }
  function notify() { api.render(); }
  function invalidate(reason) { state.revision++; api.invalidateLighting(reason || '추가 광원·현장 관찰이 바뀌었어요.'); }
  async function load() {
    if (loading) { reloadRequested = true; return loading; }
    loading = Promise.resolve().then(async () => {
      try {
        do {
          reloadRequested = false;
          const records = await api.readAll('lightingContext');
          records.sort((a, b) => a.id.localeCompare(b.id));
          const next = JSON.stringify(records);
          if (next !== signature) { signature = next; state.records = records; invalidate(); }
          state.loaded = true; state.error = '';
        } while (reloadRequested);
      } catch (error) { state.error = error.message || '추가 광원·관찰을 읽지 못했어요.'; invalidate('추가 광원·관찰 자료의 최신 상태를 읽지 못했어요.'); }
      finally { loading = null; }
      notify(); return state.records;
    });
    return loading;
  }
  function context(options = {}) { return root.DGLightingModel.createContext(state.records, api.state().lights, options); }
  function heading(title) { return '<div class="sheet-head"><div><h3>' + E(title) + '</h3><p class="muted">관리 대장과 별도로 기록해 밝기 검토에 사용해요.</p></div><button class="x" data-close aria-label="닫기">×</button></div>'; }
  function option(values, selected) { return Object.entries(values).map(([value, label]) => '<option value="' + E(value) + '"' + (value === selected ? ' selected' : '') + '>' + E(label) + '</option>').join(''); }
  function field(id, label, value, attributes = '') { return '<label class="f" for="' + id + '">' + label + '</label><input class="f-in" id="' + id + '" value="' + E(value) + '" ' + attributes + '>'; }
  function select(id, label, values, value) { return '<label class="f" for="' + id + '">' + label + '</label><select class="f-in" id="' + id + '">' + option(values, value) + '</select>'; }
  function scheduleText(record) { return record.schedule === 'always' ? '상시 확인' : record.schedule === 'hours' ? minuteText(record.startMinute) + '–' + minuteText(record.endMinute) + ' KST' : '시간 미확인'; }
  function recordSummary(record) {
    const flags = [];
    if (!record.nightConfirmed) flags.push('야간 미확인');
    if (record.observedAt + record.validDays * 86400000 <= Date.now()) flags.push('재확인 필요');
    if (record.observedAt > Date.now()) flags.push('관찰 시각 확인 필요');
    if (record.removed) flags.push('제외됨');
    return [record.kind === 'source' ? CATEGORIES[record.category] : '현장 ' + LEVELS[record.level], record.operator, scheduleText(record), ...flags].filter(Boolean).join(' · ');
  }
  function view() {
    if (!state.loaded && !state.error && !loading) load();
    const active = state.records.filter(r => !r.removed), records = state.records.filter(r => state.filter === 'removed' ? r.removed : !r.removed && (state.filter === 'all' || r.kind === state.filter));
    return '<div class="panel"><h3>대장 밖 광원·현장 관찰</h3><p>다른 기관의 등, 상가·건물의 빛을 위치와 점등 시간대로 기록해요. 다른 기관 자료를 자동으로 수집한 목록은 아니에요.</p><p class="muted">추가 광원은 상대 모델의 보완 입력이에요. 현장 밝기와 조도계 실측은 별도 근거로 표시하며 모델 지수에 더하지 않아요.</p>' +
      (!canWrite() ? '<p class="notice">기록에는 점검 권한과 Firebase 또는 기기 저장 모드가 필요해요.</p>' : '<div class="split"><button class="btn" data-lc="new-source">외부 광원 추가</button><button class="btn ghost" data-lc="new-observation">현장 밝기 기록</button></div>') +
      (state.draft ? '<button class="btn ghost block" data-lc="resume">작성 중 기록 이어쓰기</button>' : '') +
      (state.error ? '<p class="notice" role="alert">' + E(state.error) + ' 기존에 읽은 자료만 표시해요.</p>' : '') +
      '<div class="split"><select class="f-in" id="lcFilter" aria-label="보완 기록 종류">' + option({ all: '사용 중 전체', source: '외부 광원', observation: '현장 관찰', removed: '제외한 기록' }, state.filter) + '</select><button class="btn ghost sm" data-lc="reload">새로고침</button></div><p class="muted">사용 중 광원 ' + active.filter(r => r.kind === 'source').length + ' · 관찰 ' + active.filter(r => r.kind === 'observation').length + '</p>' +
      (records.length ? records.slice(0, state.show).map(r => '<div class="panel"><b>' + E(r.label) + '</b><p>' + E(recordSummary(r)) + '</p><p class="muted">' + E(kstTime(r.observedAt)) + ' · 반경 ' + E(r.radius) + 'm · 재확인 ' + E(r.validDays) + '일' + (r.lux != null ? ' · 실측 ' + E(r.lux) + ' lux (' + E(r.instrument) + ')' : '') + '</p><button class="btn ghost sm" data-lc="edit" data-id="' + E(r.id) + '">' + (canEdit(r) ? '확인·수정' : '기록 보기') + '</button></div>').join('') : '<p class="empty">' + (state.loaded ? '이 범위의 기록이 없어요.' : '불러오는 중…') + '</p>') +
      (records.length > state.show ? '<button class="btn ghost block" data-lc="more">더 보기</button>' : '') + '</div>';
  }
  function defaults(kind, point) {
    const now = Date.now(), minute = root.DGLightingModel.minuteOfKst(now);
    return { kind, label: '', category: kind === 'source' ? 'other_public' : 'field', operator: '', lat: point?.lat ?? '', lng: point?.lng ?? '', radius: kind === 'source' ? 20 : 10, strength: 'medium', status: 'unknown', level: 'unknown', schedule: kind === 'source' ? 'unknown' : 'hours', startMinute: kind === 'source' ? 1080 : (minute + 1380) % 1440, endMinute: kind === 'source' ? 360 : (minute + 60) % 1440, observedAt: now, validDays: kind === 'source' ? 90 : 30, nightConfirmed: false, lux: null, instrument: '', note: '', linkedLightId: '', distinct: false, removed: false };
  }
  async function openEditor(kind, point, id, resume = false) {
    if (!state.loaded) await load();
    await persistDraft();
    if (resume) { if (id) state.draft = await root.DGOffline.get('lightingDraft', id); else if (!state.draft) state.draft = (await root.DGOffline.list('lightingDraft')).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.value; if (!state.draft) return api.toast('이어 쓸 기록이 없어요.'); }
    else {
      const record = id && state.records.find(r => r.id === id);
      if (id && !record) return api.toast('기록을 찾을 수 없어요. 새로고침해 주세요.');
      const saved = id && root.DGOffline.ready ? await root.DGOffline.get('lightingDraft', id) : null;
      if (saved && confirm('이 기록의 작성 중인 초안을 이어 쓸까요?')) { state.draft = saved; renderEditor(); return; }
      state.draft = { recordId: record ? record.id : uuid('lighting'), expectedRevision: record ? record.revision : 0, data: record ? root.DGLightingCommands.normalize(record) : defaults(kind, point), readonly: record ? !canEdit(record) : !canWrite(), pending: null };
      if (!state.draft.readonly) await persistDraft(false);
    }
    renderEditor();
  }
  function renderEditor() {
    if (editorMap) { editorMap.remove(); editorMap = null; }
    const draft = state.draft, d = draft.data, source = d.kind === 'source', disabled = draft.readonly || !!draft.pending;
    api.navigate(heading(source ? '외부 광원 기록' : '현장 밝기 관찰') + '<form id="lcForm" data-record-id="' + E(draft.recordId) + '" class="panel" novalidate><fieldset ' + (disabled ? 'disabled' : '') + ' style="border:0;padding:0;margin:0;min-width:0">' +
      field('lcLabel', '장소·광원 이름', d.label, 'maxlength="100" required placeholder="예: OO교차로 다른 기관 보행등"') +
      (source ? '<div class="grid2"><div>' + select('lcCategory', '광원 구분', CATEGORIES_SOURCE(), d.category) + '</div><div>' + field('lcOperator', '관리기관·운영 주체 (모르면 빈칸)', d.operator, 'maxlength="100"') + '</div></div>' : select('lcLevel', '눈으로 확인한 밝기', LEVELS, d.level)) +
      '<div class="grid2"><div>' + field('lcLat', '위도', d.lat, 'type="number" step="any" min="-90" max="90" required') + '</div><div>' + field('lcLng', '경도', d.lng, 'type="number" step="any" min="-180" max="180" required') + '</div></div><div class="split"><button type="button" class="btn ghost sm" data-lc="gps">현재 위치 입력</button><button type="button" class="btn ghost sm" data-lc="pick-map">지도에서 위치 선택</button></div><p id="lcPosition" class="muted" role="status">위치는 광원 또는 실제 관찰 지점에 맞춰 주세요.</p><div id="lcPickMap" style="display:none;height:260px" aria-label="관찰 지점 선택 지도"></div>' +
      '<div class="grid2"><div>' + field('lcRadius', source ? '모델에 반영할 반경 (5–80m)' : '확인한 범위 반경 (5–30m)', d.radius, 'type="number" min="5" max="' + (source ? 80 : 30) + '" step="1" required') + '</div><div>' + (source ? select('lcStrength', '모델 영향 가정', { low: '낮음', medium: '중간', high: '높음' }, d.strength) : field('lcLux', '조도계 실측 lux (선택)', d.lux ?? '', 'type="number" min="0" max="200000" step="any"')) + '</div></div>' +
      (source ? select('lcStatus', '관찰 당시 점등 상태', { unknown: '미확인', on: '켜짐', off: '꺼짐' }, d.status) + '<p class="muted">반경·영향 가정은 상대 모델 입력이에요. 광도·조도 실측값이나 조명 설계값이 아니에요.</p>' : field('lcInstrument', '측정 기기·방법 (실측 입력 시 필수)', d.instrument, 'maxlength="100" placeholder="예: 조도계 모델, 보행면 수평 측정"') + '<p class="muted">밝기 판단과 lux는 기록한 범위 안의 관찰이에요. 주변 길 전체로 확대하거나 모델 지수로 변환하지 않아요.</p>') +
      field('lcObservedAt', '실제로 확인한 날짜·시각 (한국 시간)', kstInput(d.observedAt), 'type="datetime-local" required') +
      '<label class="f"><input id="lcNight" type="checkbox" ' + (d.nightConfirmed ? 'checked' : '') + '> 실제 해가 진 뒤 확인했어요</label>' +
      select('lcSchedule', source ? '점등 시간 정보' : '이 관찰을 적용할 시간대', source ? { unknown: '모름 · 수치 보완 없이 확인 대상으로 표시', hours: '확인한 시간대', always: '상시 점등 확인' } : { hours: '관찰한 시간대', unknown: '시간대 미확인' }, d.schedule) +
      '<div class="grid2"><div>' + field('lcStart', '시작 (한국 시간)', minuteText(d.startMinute), 'type="time"') + '</div><div>' + field('lcEnd', '종료 (다음 날 가능)', minuteText(d.endMinute), 'type="time"') + '</div></div><p class="muted">상가가 문을 닫거나 조명이 꺼지는 시간을 반영해 주세요. 시간 미확인·야간 미확인 자료는 밝기 수치 보완에 쓰지 않아요.</p>' +
      field('lcValidDays', '다시 확인할 때까지의 기간 (일)', d.validDays, 'type="number" min="1" max="365" step="1" required') +
      (source ? '<details><summary>중복 광원 확인</summary>' + field('lcLinked', '같은 시설의 관리 대장 ID (선택)', d.linkedLightId, 'maxlength="180" placeholder="같은 시설이면 연결하고 중복 합산 제외"') + '<label class="f"><input id="lcDistinct" type="checkbox" ' + (d.distinct ? 'checked' : '') + '> 5m 이내 대장 시설과 별개의 광원임을 확인했어요</label><p class="muted">대장 시설과 가까우면 확인 전까지 중복 합산하지 않아요. 동일 이름·관리기관의 가까운 추가 기록도 중복을 확인해요.</p></details>' : '') +
      '<label class="f" for="lcNote">근거·주변 환경 메모</label><textarea class="f-in" id="lcNote" maxlength="1000" placeholder="예: 상가 폐점 후 꺼짐, 가로수 가림, 맞은편 기관 보행등">' + E(d.note) + '</textarea></fieldset>' +
      (draft.pending ? '<p class="notice">전송 중인 내용은 저장 대기함에서 확인해 주세요. 완료 전에는 모델에 반영되지 않아요.</p><button type="button" class="btn ghost" data-asec="outbox">저장 대기함</button>' : draft.readonly ? '<p class="muted">작성자 또는 관리자가 수정할 수 있어요.</p>' : '<div class="split"><button type="submit" class="btn" id="lcSave">기록 저장</button><button type="button" class="btn ghost" data-lc="discard">초안 버리기</button>' + (draft.expectedRevision ? '<button type="button" class="btn ghost" data-lc="remove">' + (d.removed ? '다시 사용' : '검토에서 제외') + '</button>' : '') + '</div>') +
      '<p id="lcSaveState" class="muted" role="status">' + (root.DGOffline.durable ? '작성 내용은 이 기기에 자동 보관돼요.' : '현재 창에서만 초안을 보관해요.') + '</p></form>');
  }
  function CATEGORIES_SOURCE() { const result = { ...CATEGORIES }; delete result.field; return result; }
  function readForm() {
    const draft = state.draft; if (!draft || Q('#lcForm')?.dataset.recordId !== draft.recordId || draft.readonly || draft.pending) return draft;
    const d = draft.data, num = id => Q(id).value === '' ? '' : Number(Q(id).value);
    Object.assign(d, { label: Q('#lcLabel').value, lat: num('#lcLat'), lng: num('#lcLng'), radius: num('#lcRadius'), observedAt: Date.parse(Q('#lcObservedAt').value + '+09:00'), nightConfirmed: Q('#lcNight').checked, schedule: Q('#lcSchedule').value, startMinute: parseMinute(Q('#lcStart').value), endMinute: parseMinute(Q('#lcEnd').value), validDays: num('#lcValidDays'), note: Q('#lcNote').value });
    if (d.kind === 'source') Object.assign(d, { category: Q('#lcCategory').value, operator: Q('#lcOperator').value, strength: Q('#lcStrength').value, status: Q('#lcStatus').value, linkedLightId: Q('#lcLinked').value, distinct: Q('#lcDistinct').checked });
    else Object.assign(d, { level: Q('#lcLevel').value, lux: Q('#lcLux').value === '' ? null : +Q('#lcLux').value, instrument: Q('#lcInstrument').value });
    return draft;
  }
  function persistDraft(read = true) {
    const d = read ? readForm() : state.draft;
    return writeDraft(d);
  }
  function writeDraft(d) {
    if (!d || d.readonly || !root.DGOffline.ready) return draftWrites;
    const value = JSON.parse(JSON.stringify(d));
    draftWrites = draftWrites.catch(() => {}).then(() => root.DGOffline.put('lightingDraft', value.recordId, value));
    return draftWrites;
  }
  function clearDraft(owner = state.draft) {
    if (!owner) return draftWrites;
    const recordId = owner.recordId, pending = owner.pending;
    if (state.draft === owner) state.draft = null;
    draftWrites = draftWrites.catch(() => {}).then(async () => {
      if (!root.DGOffline.ready) return;
      const stored = await root.DGOffline.get('lightingDraft', recordId);
      if (stored?.recordId === recordId && stored.pending === pending) await root.DGOffline.remove('lightingDraft', recordId);
    });
    return draftWrites;
  }
  async function save(button, remove) {
    const d = readForm(); if (!d || d.readonly || d.pending || !canWrite()) return;
    if (remove !== undefined) d.data.removed = remove;
    if (d.data.lat === '' || d.data.lng === '') throw new Error('실제 확인 지점의 위도와 경도를 입력해 주세요.');
    const data = root.DGLightingCommands.normalize(d.data), job = { id: uuid('lighting-op'), recordId: d.recordId, actor: api.state().me, at: Date.now(), expectedRevision: d.expectedRevision, data };
    const form = Q('#lcForm');
    d.pending = job.id; if (button) button.disabled = true;
    if (form) { form.querySelector('fieldset').disabled = true; Q('#lcSaveState').textContent = '저장 요청을 확인하는 중이에요. 입력한 내용은 전송 완료까지 잠시 잠겨요.'; }
    try {
      await writeDraft(d);
      const result = await root.DGOffline.submit('lighting', job, { id: job.id, summary: (data.kind === 'source' ? '추가 광원 · ' : '현장 밝기 · ') + data.label });
      if (result.state === 'synced') { await clearDraft(d); await load(); if (form?.isConnected && Q('#lcForm') === form) api.closeSheet(); api.toast('기록했어요. 밝기 검토를 다시 실행하면 반영돼요.'); }
      else { api.toast(result.error || '기기에 보관했어요. 전송 완료 후 검토에 반영돼요.'); if (state.draft === d) renderEditor(); }
    } catch (error) { d.pending = null; await writeDraft(d).catch(() => {}); throw error; }
    finally { if (button?.isConnected) button.disabled = !!d.pending; if (form?.isConnected && !d.pending) { form.querySelector('fieldset').disabled = false; form.querySelector('#lcSaveState').textContent = '입력 내용이 남아 있어요. 오류를 확인한 뒤 다시 저장해 주세요.'; } }
  }
  function pickMap() {
    if (!root.L) return api.toast('지도를 불러오지 못했어요. 좌표를 입력해 주세요.');
    if (editorMap) { editorMap.invalidateSize(); return; }
    const lat = +Q('#lcLat').value, lng = +Q('#lcLng').value, valid = Q('#lcLat').value !== '' && Q('#lcLng').value !== '' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    Q('#lcPickMap').style.display = 'block'; editorMap = root.L.map('lcPickMap').setView(valid ? [lat, lng] : [35.145, 126.928], valid ? 18 : 15);
    root.DongguPWA.tileLayer(root.L).addTo(editorMap); let marker = valid ? root.L.circleMarker([lat, lng]).addTo(editorMap) : null;
    editorMap.on('click', e => { Q('#lcLat').value = e.latlng.lat.toFixed(6); Q('#lcLng').value = e.latlng.lng.toFixed(6); if (marker) marker.setLatLng(e.latlng); else marker = root.L.circleMarker(e.latlng).addTo(editorMap); Q('#lcPosition').textContent = '선택한 위치를 입력했어요. 확인한 지점과 일치하는지 확인해 주세요.'; persistDraft().catch(error => api.toast(error.message)); });
  }
  async function handle(button) {
    const action = button.dataset.lc;
    if (action === 'new-source' || action === 'new-observation') return openEditor(action === 'new-source' ? 'source' : 'observation', button.dataset.lat ? { lat: +button.dataset.lat, lng: +button.dataset.lng } : null);
    if (action === 'edit') return openEditor(null, null, button.dataset.id);
    if (action === 'resume') return openEditor(null, null, null, true);
    if (action === 'reload') return load();
    if (action === 'more') { state.show += 40; return notify(); }
    if (action === 'discard') { if (!confirm('작성 중인 보완 기록을 버릴까요?')) return; await clearDraft(); api.closeSheet(); notify(); return; }
    if (action === 'remove') { if (confirm(state.draft.data.removed ? '이 기록을 다시 검토에 사용할까요?' : '이 기록을 검토에서 제외할까요? 기록은 남아 있어요.')) return save(button, !state.draft.data.removed); return; }
    if (action === 'pick-map') return pickMap();
    if (action === 'gps') {
      if (!root.navigator.geolocation) return api.toast('현재 위치를 사용할 수 없어요. 좌표나 지도를 이용해 주세요.');
      button.disabled = true; const form = Q('#lcForm');
      root.navigator.geolocation.getCurrentPosition(position => { button.disabled = false; if (!form.isConnected || form !== Q('#lcForm')) return; Q('#lcLat').value = position.coords.latitude.toFixed(6); Q('#lcLng').value = position.coords.longitude.toFixed(6); Q('#lcPosition').textContent = 'GPS 오차 약 ' + Math.round(position.coords.accuracy) + 'm. 실제 광원·관찰 지점과 맞는지 확인해 주세요.'; persistDraft().catch(error => api.toast(error.message)); }, () => { button.disabled = false; api.toast('위치 권한과 GPS를 확인하거나 지도에서 위치를 선택해 주세요.'); }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 });
    }
  }
  async function restoreRecord(row, overwrite) {
    const snap = await api.database().doc('lightingContext/' + row.id).get(api.firebase() ? { source: 'server' } : undefined), current = snap?.exists !== false && snap?.data ? snap.data() : null;
    if (current && !overwrite || !current && row.removed) return { skipped: true };
    const job = { id: uuid('lighting-restore'), recordId: row.id, actor: api.state().me, at: Date.now(), expectedRevision: current?.revision || 0, data: root.DGLightingCommands.normalize(row) };
    await root.DGLightingCommands.execute(job, { db: api.database(), fb: api.firebase(), user: api.state().me, admin: api.can('admin') }); return { skipped: false };
  }
  async function ready() {
    const jobs = new Map((await root.DGOffline.jobs()).map(job => [job.id, job]));
    for (const entry of await root.DGOffline.list('lightingDraft')) {
      const d = entry.value; if (!d?.pending) continue;
      const job = jobs.get(d.pending);
      if (job?.kind === 'lighting' && job.state === 'synced') await clearDraft(d);
      else if (!job) { d.pending = null; await writeDraft(d); }
    }
    state.draft = (await root.DGOffline.list('lightingDraft')).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.value || null; await load();
    if (unsubscribe) unsubscribe();
    if (api.state().me === 'local' || api.firebase()) {
      try { unsubscribe = api.database().collection('lightingContext').onSnapshot(() => load(), error => { state.error = error.message || '실시간 갱신 실패'; notify(); }); } catch (_) { /* The refresh button remains available. */ }
    }
  }
  function attach(contextApi) {
    api = contextApi; root.DGOffline.register('lighting', job => root.DGLightingCommands.execute(job, { db: api.database(), fb: api.firebase(), user: api.state().me, admin: api.can('admin') }));
    if (attached) return; attached = true;
    document.addEventListener('click', event => { const b = event.target.closest('[data-lc]'); if (b) Promise.resolve().then(() => handle(b)).catch(error => api.toast(error.message)); });
    document.addEventListener('submit', event => { if (event.target.id !== 'lcForm') return; event.preventDefault(); save(Q('#lcSave')).catch(error => api.toast(error.message)); });
    for (const event of ['input', 'change']) document.addEventListener(event, e => { if (e.target.closest('#lcForm')) persistDraft().catch(error => api.toast(error.message)); });
    document.addEventListener('change', e => { if (e.target.id === 'lcFilter') { state.filter = e.target.value; state.show = 40; notify(); } });
    root.DGOffline.subscribe(event => {
      if (event.type === 'synced' && event.job.kind === 'lighting') {
        const owner = state.draft?.pending === event.job.id ? state.draft : { recordId: event.job.payload.recordId, pending: event.job.id };
        if (state.draft === owner && Q('#lcForm')?.dataset.recordId === owner.recordId) api.closeSheet();
        clearDraft(owner).catch(() => {});
        load();
      }
      if (event.type === 'discarded' && event.job?.kind === 'lighting' && event.job.payload) {
        const id = event.job.payload.recordId;
        if (state.draft?.pending === event.job.id) { state.draft.pending = null; persistDraft(false).catch(() => {}); }
        else { draftWrites = draftWrites.catch(() => {}).then(async () => { const d = await root.DGOffline.get('lightingDraft', id); if (d?.pending === event.job.id) { d.pending = null; await root.DGOffline.put('lightingDraft', id, d); } }); }
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistDraft().catch(() => {}); });
  }
  root.DGLighting = { attach, ready, load, context, view, openEditor, state, restoreRecord, persistDraft, clearDraft, minuteText, parseMinute, kstTime, recordSummary, reason: key => REASONS[key] || key, classification: key => CLASSIFICATIONS[key] || key, categories: CATEGORIES, levels: LEVELS };
})(globalThis);
