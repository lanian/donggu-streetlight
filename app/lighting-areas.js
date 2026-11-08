/* Explicit review areas: exclusions and narrow public-path exceptions preserve field evidence. */
(function (root) {
  'use strict';
  /* in-app confirmation when app/dialog.js is present; the plain confirm() keeps bare test sandboxes working */
  const ask = (message, opts) => root.DGDialog ? root.DGDialog.confirm(message, opts) : Promise.resolve(confirm(message));
  const Core = root.DGLightingAreaCore, Commands = root.DGLightingAreaCommands;
  const KIND = 'lightingAreaDraft', JOB = 'lighting-area';
  const REASONS = { mountain: '산·숲', private: '사유지·단지 내부', non_walkway: '통행로 아님', water: '하천·수면', other: '기타', public_path: '공공 보행로·확인할 길' };
  const EFFECTS = { exclude: '검토 제외', include: '보행로 예외 포함' };
  const state = { loaded: false, error: '', records: [], draft: null, drafts: [], filter: 'active', search: '', show: 40 };
  let api, attached = false, loading = null, reloadRequested = false, signature = '', compiled = null, unsubscribe;
  let generation = 0, editorSequence = 0, writes = Promise.resolve(), writeCount = 0, editorMap = null, mapLayer = null, mapSequence = 0, searchComposing = false;
  const settlements = new Map(), appliedOperations = new Set(), saveViews = new Map();
  const Q = selector => document.querySelector(selector), copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const E = value => api.esc(value == null ? '' : value), uid = prefix => root.DGData.newId(prefix);
  const errorText = error => String(error?.message || error || '처리를 완료하지 못했어요.');
  const fail = (message, code = 'failed-precondition') => { throw Object.assign(new Error(message), { code }); };
  const actor = () => api.state().me;
  const canWrite = () => api.can('admin') && api.state().canWrite && (!!api.firebase() || typeof api.database()?.commitMany === 'function');
  const sheetOpen = () => !!Q('#sheet.open');
  const time = at => root.DGLighting?.kstTime(at) || (Number.isFinite(at) ? new Date(at).toISOString() : '');
  const option = (values, selected) => Object.entries(values).map(([value, label]) => '<option value="' + E(value) + '"' + (value === selected ? ' selected' : '') + '>' + E(label) + '</option>').join('');
  const heading = title => '<div class="sheet-head"><div><h3>' + E(title) + '</h3><p class="muted">검토 범위 설정이며 밝음 판정 아님</p></div><button class="x" data-close aria-label="닫기">×</button></div>';
  const pointValid = p => p && p.lat !== '' && p.lng !== '' && Number.isFinite(+p.lat) && Math.abs(+p.lat) <= 85 && Number.isFinite(+p.lng) && Math.abs(+p.lng) <= 180;
  const verticesText = vertices => (vertices || []).map(p => p.lat + ', ' + p.lng).join('\n');
  function parseVertices(value) {
    const lines = String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 32) fail('경계점은 최대 32개예요. 필요한 구역을 나누어 등록해 주세요.', 'invalid-argument');
    return lines.map((line, index) => {
      const values = line.split(',').map(x => x.trim());
      if (values.length !== 2 || values.some(v => !v || !Number.isFinite(Number(v)))) fail((index + 1) + '번째 경계점은 위도, 경도 순서로 입력해 주세요.', 'invalid-argument');
      const point = { lat: Number(values[0]), lng: Number(values[1]) };
      if (!pointValid(point)) fail((index + 1) + '번째 경계점의 좌표 범위를 확인해 주세요.', 'invalid-argument');
      return point;
    });
  }
  // Editing history belongs to this draft object, never to the stored area payload.
  const polygonSessions = new WeakMap();
  function polygonSession(draft = state.draft) {
    if (!draft) return null;
    let session = polygonSessions.get(draft);
    if (!session) {
      const editor = root.DGPolygonEditor.create(draft.polygonText ?? verticesText(draft.data.vertices));
      let count = 0; try { count = root.DGPolygonEditor.points(editor.text).length; } catch (_) {}
      session = { editor, mode: count >= 3 ? 'edit' : 'draw' }; polygonSessions.set(draft, session);
    }
    return session;
  }
  function polygonEditable(form, draft, sequence, scope) {
    return ownsView(form, draft, sequence, scope) && !draft.readonly && !draft.pending && !draft.conflict && canWrite() && Q('#laShape')?.value === 'polygon';
  }
  function focusPoint(index) { Q('#laMap .la-vertex[data-point="' + index + '"]')?.focus({ preventScroll: true }); }
  function editPolygon(operation, focus = false) {
    const draft = state.draft, form = Q('#laForm'), sequence = editorSequence, scope = generation;
    if (!draft || !polygonEditable(form, draft, sequence, scope)) return false;
    readForm(); const session = polygonSession(draft), editor = session.editor;
    root.DGPolygonEditor.update(editor, draft.polygonText, editor.text === draft.polygonText ? editor.selected : null);
    operation(editor, session); Q('#laVertices').value = editor.text;
    changed(); if (focus && editor.selected !== null) focusPoint(editor.selected);
    return true;
  }
  function geometryPreview(draft) {
    return normalizedDraft({ ...draft, data: { ...draft.data, label: draft.data.label || '범위 미리보기' } });
  }
  function ownsView(form, draft, sequence, scope) {
    return scope === generation && sequence === editorSequence && !!form?.isConnected && Q('#laForm') === form && form.dataset.recordId === draft.recordId && form.dataset.editorSequence === String(sequence) && sheetOpen();
  }
  function notify() {
    const list = Q('#laList');
    if (list && sheetOpen()) {
      if (searchComposing) return;
      const input = Q('#laSearch'), focused = document.activeElement === input, start = input?.selectionStart, end = input?.selectionEnd;
      list.outerHTML = view();
      if (focused && Q('#laSearch')) { Q('#laSearch').focus({ preventScroll: true }); Q('#laSearch').setSelectionRange(start, end); }
    } else if (!Q('#laForm') || !sheetOpen()) api.render();
  }
  async function load() {
    if (loading) { reloadRequested = true; return loading; }
    const scope = generation;
    loading = Promise.resolve().then(async () => {
      try {
        do {
          reloadRequested = false;
          const rows = await api.readAll('lightingAreas', { requireServer: !!api.firebase() });
          if (scope !== generation) return state.records;
          rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
          const nextContext = Core.compile(rows), next = JSON.stringify(rows);
          if (next !== signature) { signature = next; state.records = rows; compiled = nextContext; api.invalidateLighting('검토 제외 구역·보행로 예외가 바뀌었어요.'); }
          else if (!compiled) compiled = nextContext;
          state.loaded = true; state.error = '';
        } while (reloadRequested);
      } catch (error) {
        if (scope === generation) { state.error = errorText(error); state.loaded = false; api.invalidateLighting('검토 구역 자료를 확인하지 못했어요.'); }
      } finally { if (scope === generation) { loading = null; notify(); } }
      return state.records;
    });
    return loading;
  }
  function context() {
    if (!state.loaded || state.error || !compiled) fail('검토 제외 구역을 새로고침한 뒤 다시 검토해 주세요.');
    return compiled;
  }
  function snapshot() { context(); return copy(state.records); }
  function filtered() {
    const term = state.search.trim().toLocaleLowerCase();
    return state.records.filter(r => (state.filter === 'all' || state.filter === 'disabled' && r.disabled || !r.disabled && (state.filter === 'active' || r.effect === state.filter)) && (!term || [r.label, REASONS[r.reason], r.note].join(' ').toLocaleLowerCase().includes(term))).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  function view() {
    if (!state.loaded && !state.error && !loading) queueMicrotask(load);
    const rows = filtered(), active = state.records.filter(r => !r.disabled);
    return '<div id="laList"><div class="panel"><h3>밝기 검토 제외 구역</h3><p>산·숲처럼 조명 검토가 필요 없는 범위를 직접 지정해요. 제외 구역 안의 실제 보행로는 예외 포함으로 남겨 둘 수 있어요.</p><p class="muted">검토 범위 설정이며 밝음 판정 아님. 시설·광원·현장 관찰은 지우지 않으며, 어두움·관찰 충돌 지점은 별도로 확인해요.</p>' +
      '<div class="split">' + (canWrite() ? '<button class="btn" data-la="new">새 제외 구역</button><button class="btn ghost" data-la="new-include">보행로 예외 추가</button>' : '<p class="muted">구역 변경은 관리자 권한이 필요해요.</p>') + '<button class="btn ghost" data-la="reload">새로고침</button><button class="btn ghost" data-asec="light">밝기 검토로</button></div>' +
      (state.drafts.length ? '<details><summary>작성 중인 구역 ' + state.drafts.length + '건</summary>' + state.drafts.map(d => '<p>' + E(d.value?.data?.label || '이름 미입력 구역') + ' <button class="btn ghost sm" data-la="resume" data-id="' + E(d.id) + '">이어쓰기</button></p>').join('') + '</details>' : '') +
      '<label class="f" for="laSearch">구역 이름·사유 검색</label><input class="f-in" id="laSearch" type="search" value="' + E(state.search) + '" placeholder="예: 산, 주차장, 보행로"><label class="f" for="laFilter">구역 보기</label><select class="f-in" id="laFilter">' + option({ active: '적용 중 전체', exclude: '제외 구역', include: '보행로 예외', disabled: '해제한 구역', all: '전체 기록' }, state.filter) + '</select>' +
      (state.error ? '<p class="notice" role="alert">현재 구역을 확인하지 못했어요: ' + E(state.error) + ' · 새로고침 후 검토해 주세요.</p>' : '<p class="muted">적용 중 제외 ' + active.filter(r => r.effect === 'exclude').length + '곳 · 보행로 예외 ' + active.filter(r => r.effect === 'include').length + '곳 · 현재 보기 ' + rows.length + '곳</p>') + '</div>' +
      rows.slice(0, state.show).map(r => '<article class="panel"><div class="split"><b>' + E(r.label) + '</b><span class="chip">' + E(r.disabled ? '적용 해제' : EFFECTS[r.effect]) + '</span></div><p>' + E(REASONS[r.reason]) + ' · ' + (r.shape === 'circle' ? '반경 ' + E(r.radius) + 'm' : '다각형 경계 ' + r.vertices.length + '점') + '</p>' + (r.note ? '<p>' + E(r.note) + '</p>' : '') + '<p class="muted">수정 ' + E(time(r.updatedAt)) + ' · ' + E(api.state().names?.[r.updatedBy] || r.updatedBy) + '</p><button class="btn ghost sm" data-la="edit" data-id="' + E(r.id) + '">' + (canWrite() ? '지도 확인·수정' : '지도·범위 보기') + '</button></article>').join('') +
      (!rows.length && state.loaded ? '<p class="empty">이 조건의 구역이 없어요.</p>' : '') + (rows.length > state.show ? '<button class="btn ghost block" data-la="more">더 보기 · ' + (rows.length - state.show) + '곳 남음</button>' : '') + '</div>';
  }
  function readForm(draft = state.draft) {
    const form = Q('#laForm');
    if (!draft || draft !== state.draft || draft.readonly || draft.pending || draft.conflict || !canWrite() || form?.dataset.recordId !== draft.recordId || !sheetOpen()) return draft;
    Object.assign(draft.data, { label: Q('#laLabel').value, effect: Q('#laEffect').value, reason: Q('#laReason').value, note: Q('#laNote').value, shape: Q('#laShape').value, lat: Q('#laLat').value, lng: Q('#laLng').value, radius: Q('#laRadius').value });
    draft.polygonText = Q('#laVertices').value;
    return draft;
  }
  function showDraftError(draft, error) {
    if (state.draft !== draft || Q('#laForm')?.dataset.recordId !== draft.recordId) return;
    const element = Q('#laSaveState'); if (element) element.textContent = '초안을 보관하지 못했어요. 현재 입력은 화면에 남아 있어요. ' + errorText(error);
    if (error.code === 'conflict') {
      draft.conflict = true;
      const fieldset = Q('#laForm')?.querySelector('fieldset'); if (fieldset) fieldset.disabled = true;
      if (element) element.textContent = '다른 탭의 초안이 바뀌어 편집을 잠갔어요. 현재 입력을 새 구역 초안으로 복사하거나 최신 초안을 열어 주세요.';
      if (Q('#laDraftConflict')) Q('#laDraftConflict').hidden = false;
      updateGeometry();
    }
  }
  function writeDraft(draft) {
    if (!draft || draft.readonly) return writes;
    if (draft.pending && appliedOperations.has(draft.pending)) return writes;
    if (!root.DGOffline.ready) return Promise.reject(Object.assign(new Error('초안 저장소가 준비되지 않았어요. 입력 내용을 복사한 뒤 다시 연결해 주세요.'), { code: 'unavailable' }));
    const value = copy(draft), scope = generation;
    writeCount++;
    writes = writes.catch(() => {}).then(async () => {
      if (scope !== generation) fail('계정이 바뀌어 이전 초안 저장을 중단했어요.', 'account-changed');
      if (value.pending && appliedOperations.has(value.pending)) return;
      if (draft.conflict) fail('다른 탭의 초안이 바뀌었어요. 최신 초안 확인 또는 새 구역으로 복사를 선택해 주세요.', 'conflict');
      const saved = await root.DGOffline.putIfCurrent(KIND, draft.recordId, value, draft.draftRevision ?? null);
      draft.draftRevision = saved.draftRevision; draft.saveError = '';
      state.drafts = await root.DGOffline.list(KIND);
    }).catch(error => { draft.saveError = errorText(error); showDraftError(draft, error); throw error; }).finally(() => { writeCount--; });
    return writes;
  }
  function persistActive() { return writeDraft(readForm()); }
  function clearDraft(owner) {
    const scope = generation;
    if (owner.pending) appliedOperations.add(owner.pending);
    writes = writes.catch(() => {}).then(async () => {
      if (scope !== generation) return;
      const saved = await root.DGOffline.get(KIND, owner.recordId);
      if (saved?.pending === owner.pending) {
        try { await root.DGOffline.removeIfCurrent(KIND, owner.recordId, saved.draftRevision ?? 0); }
        catch (error) { const latest = await root.DGOffline.get(KIND, owner.recordId); if (error.code !== 'conflict' || latest?.pending === owner.pending) throw error; }
      }
      if (scope !== generation) return;
      if (state.draft === owner) state.draft = null;
      state.drafts = await root.DGOffline.list(KIND);
    });
    return writes;
  }
  async function draftApplied(draft) {
    if (!draft?.pending) return false;
    if (appliedOperations.has(draft.pending)) return true;
    const snap = await api.database().doc('lightingAreaOperations/' + Core.id(draft.pending)).get(api.firebase() ? { source: 'server' } : undefined);
    const receipt = Commands.dataOf(snap);
    return receipt?.recordId === draft.recordId && receipt.by === actor() && receipt.revision === draft.expectedRevision + 1;
  }
  function fromRecord(record, draftRevision = null, returnSection = 'lightingareas') {
    const data = Core.normalize(record);
    return { recordId: record.id, expectedRevision: record.revision, data, polygonText: verticesText(data.vertices), readonly: !canWrite(), pending: null, draftRevision, returnSection };
  }
  async function discardDraft(id) {
    await writes.catch(() => {});
    const saved = await root.DGOffline.get(KIND, id), active = state.draft?.recordId === id ? state.draft : null;
    if (saved?.pending || active?.pending) fail('전송 중인 구역은 저장 대기함에서 먼저 처리해 주세요.');
    if (saved) await root.DGOffline.removeIfCurrent(KIND, id, active?.draftRevision ?? saved.draftRevision ?? 0);
    if (active && state.draft === active) state.draft = null;
    state.drafts = await root.DGOffline.list(KIND);
  }
  async function openEditor(input = null, recordId = null, resume = false) {
    const gen = api.navGen ? api.navGen() : null, sequence = ++editorSequence, scope = generation, current = () => sequence === editorSequence && scope === generation && (gen === null || api.navAlive(gen));
    await persistActive(); if (!current()) return;
    if (recordId || !state.loaded) await load(); if (!current()) return;
    if (state.error || !state.loaded) fail('검토 구역을 새로고침한 뒤 다시 열어 주세요.');
    let old = recordId && state.records.find(r => r.id === recordId);
    if (!recordId && !canWrite()) fail('검토 구역을 추가하려면 관리자 권한과 저장소가 필요해요.', 'permission-denied');
    let saved = recordId && canWrite() ? await root.DGOffline.get(KIND, recordId) : null;
    if (!current()) return;
    if (saved?.pending && await draftApplied(saved)) {
      if (!current()) return;
      await clearDraft(saved); if (!current()) return;
      await load(); if (!current()) return;
      saved = await root.DGOffline.get(KIND, recordId); if (!current()) return;
      old = state.records.find(r => r.id === recordId);
    }
    if (!current()) return;
    if (recordId && !old && !(resume && saved)) fail('구역을 찾지 못했어요. 목록을 새로고침해 주세요.');
    if (resume && !saved && !old) fail('이어 쓸 구역 초안이 없어요.');
    const useSaved = saved && (resume || saved.pending || await ask('이 구역의 작성 중인 초안을 이어 쓸까요?', { ok: '이어 쓰기', cancel: '새로 시작' }));
    if (useSaved) { state.draft = saved; state.draft.readonly = !canWrite(); }
    else {
      const effect = input?.effect === 'include' ? 'include' : 'exclude';
      const data = old ? Core.normalize(old) : { label: input?.label || '', effect, reason: input?.reason || (effect === 'include' ? 'public_path' : 'mountain'), note: input?.note || '', shape: input?.shape || 'circle', lat: input?.lat ?? '', lng: input?.lng ?? '', radius: input?.radius ?? 25, vertices: input?.vertices || [], disabled: false };
      state.draft = { recordId: old?.id || uid('lighting-area'), expectedRevision: old?.revision || 0, data, polygonText: verticesText(data.vertices), readonly: !canWrite(), pending: null, draftRevision: saved?.draftRevision ?? null, returnSection: input?.returnSection || 'lightingareas' };
    }
    const draft = state.draft;
    // Render before the first durable write so quota/storage failures never hide the user's input.
    renderEditor();
    if (!draft.readonly) await writeDraft(draft);
  }
  function normalizedDraft(draft) {
    const data = copy(draft.data);
    if (data.shape === 'polygon') { data.vertices = parseVertices(draft.polygonText); data.radius = 0; }
    else data.vertices = [];
    return Core.normalize(data);
  }
  function destroyMap() { if (editorMap) { editorMap.stop(); editorMap.remove(); editorMap = null; mapLayer = null; } }
  function returnFromEditor(draft) {
    destroyMap();
    // the editor is one level above the list or map it was opened from: leaving it is a plain back
    if (api.navDepth && api.navDepth() > 1) return api.closeSheet();
    if (draft?.returnSection === 'light' && api.returnLightingReview) return api.returnLightingReview();
    return api.openSection(draft?.returnSection || 'lightingareas');
  }
  function renderEditor() {
    const draft = state.draft; if (!draft) return;
    destroyMap();
    const data = draft.data, old = state.records.find(r => r.id === draft.recordId), locked = draft.readonly || !!draft.pending || !!draft.conflict || !canWrite();
    const coordinates = '<div id="laCircleFields"' + (data.shape === 'polygon' ? ' hidden' : '') + '><div class="grid2"><div><label class="f" for="laLat">중심 위도</label><input class="f-in" id="laLat" type="number" min="-85" max="85" step="any" value="' + E(data.lat) + '"></div><div><label class="f" for="laLng">중심 경도</label><input class="f-in" id="laLng" type="number" min="-180" max="180" step="any" value="' + E(data.lng) + '"></div></div><label class="f" for="laRadius">반경 (5–1,000m)</label><input class="f-in" id="laRadius" type="number" min="5" max="1000" step="any" value="' + E(data.shape === 'circle' ? data.radius : 25) + '"></div>';
    const polygonTools = '<div id="laPolygonTools"' + (data.shape !== 'polygon' ? ' hidden' : '') + '><div class="la-mode" role="group" aria-label="다각형 편집 방법"><button type="button" class="btn ghost" id="laDrawMode" data-la="draw-mode" aria-pressed="false">점 추가</button><button type="button" class="btn ghost" id="laEditMode" data-la="edit-mode" aria-pressed="false">그리기 마치기 · 모양 수정</button></div><p id="laPointState" class="muted" role="status" aria-live="polite"></p></div>';
    const polygonActions = '<div id="laPolygonActions"' + (data.shape !== 'polygon' ? ' hidden' : '') + '><div class="la-tools" role="group" aria-label="경계 편집 도구"><button type="button" class="btn ghost sm" id="laUndo" data-la="undo-edit">되돌리기</button><button type="button" class="btn ghost sm" id="laRedo" data-la="redo-edit">다시하기</button><button type="button" class="btn ghost sm" id="laDeletePoint" data-la="delete-point">선택한 점 삭제</button><button type="button" class="btn ghost sm" data-la="fit-area">전체 범위 보기</button></div><p class="muted la-help">번호 점을 끌어 경계를 고쳐요. 모양 수정 중 선의 +를 누르면 중간 점이 생겨요. 점을 선택한 뒤 방향키로 이동하거나 Delete로 지울 수도 있어요.</p></div>';
    const advanced = '<div id="laPolygonFields"' + (data.shape !== 'polygon' ? ' hidden' : '') + '><details id="laCoordinateDetails" class="la-coordinates"><summary>좌표 직접 입력 · 고급 설정</summary><label class="f" for="laVertices">경계점 (한 줄에 위도, 경도)</label><textarea class="f-in" id="laVertices" rows="5" spellcheck="false" placeholder="35.145000, 126.928000&#10;35.145100, 126.928000&#10;35.145100, 126.928200">' + E(draft.polygonText ?? verticesText(data.vertices)) + '</textarea><div class="la-tools"><button type="button" class="btn ghost sm" data-la="undo-point">마지막 점 취소</button><button type="button" class="btn ghost sm" data-la="clear-points">경계점 비우기</button></div></details></div>';
    api.navigate(heading(data.effect === 'include' ? '보행로 예외 포함' : '검토 제외 구역') + '<div class="split"><button type="button" class="btn ghost sm" data-la="back">' + (draft.returnSection === 'light' ? '밝기 검토로' : '구역 목록으로') + '</button></div><form id="laForm" class="panel" data-record-id="' + E(draft.recordId) + '" data-editor-sequence="' + editorSequence + '"><fieldset' + (locked ? ' disabled' : '') + ' style="border:0;padding:0;min-width:0"><label class="f" for="laLabel">구역 이름</label><input class="f-in" id="laLabel" value="' + E(data.label) + '" maxlength="100" placeholder="예: 보행로 밖 산림" required><div class="grid2"><div><label class="f" for="laEffect">적용 방법</label><select class="f-in" id="laEffect">' + option(EFFECTS, data.effect) + '</select></div><div><label class="f" for="laReason">사유</label><select class="f-in" id="laReason">' + option(data.effect === 'include' ? { public_path: REASONS.public_path, other: REASONS.other } : Object.fromEntries(Object.entries(REASONS).filter(([k]) => k !== 'public_path')), data.reason) + '</select></div></div><label class="f" for="laShape">범위 지정 방식</label><select class="f-in" id="laShape">' + option({ circle: '중심과 반경', polygon: '경계선을 직접 지정' }, data.shape) + '</select>' + polygonTools + '<div id="laMap" class="gmap la-map" aria-label="검토 구역 범위 지도"></div><p id="laMapHint" class="muted">' + (locked ? '지도로 저장한 범위를 확인하세요.' : '지도에서 실제 제외 범위와 보행로를 확인해 주세요.') + '</p>' + polygonActions + '<p id="laGeometryHint" class="muted" role="status"></p>' + coordinates + advanced + '<label class="f" for="laNote">제외·예외 판단 근거</label><textarea class="f-in" id="laNote" rows="3" maxlength="1000" placeholder="예: 통행로 없는 산림 내부만 제외. 산책로는 별도 예외 구역으로 포함.">' + E(data.note) + '</textarea></fieldset><p class="notice">제외와 예외가 겹치면 보행로 예외가 우선해요. 이 설정은 시설이나 현장 기록을 삭제하지 않아요.</p>' +
      (old ? '<p class="muted">등록 ' + E(time(old.createdAt)) + ' · ' + E(api.state().names?.[old.createdBy] || old.createdBy) + '<br>수정 ' + E(time(old.updatedAt)) + ' · ' + E(api.state().names?.[old.updatedBy] || old.updatedBy) + ' · 버전 ' + E(old.revision) + (old.disabled ? ' · 현재 적용 해제' : '') + '</p>' : '') +
      '<p id="laSaveState" class="notice" role="status">' + E(draft.saveError || (draft.pending ? '저장 대기함에서 전송 결과를 확인해 주세요.' : draft.readonly ? '저장된 구역을 보고 있어요. 변경에는 관리자 권한이 필요해요.' : root.DGOffline.durable ? '초안은 이 기기에 보관돼요. 구역 저장 후 검토를 다시 실행하세요.' : '초안은 현재 창에서만 보관돼요.')) + '</p><div id="laDraftConflict"' + (draft.conflict ? '' : ' hidden') + '><button type="button" class="btn ghost" data-la="reload-draft">최신 초안 열기</button><button type="button" class="btn ghost" data-la="copy-draft">새 구역 초안으로 복사</button></div>' +
      (draft.pending ? '<button type="button" class="btn ghost" data-asec="outbox">저장 대기함</button>' : draft.readonly ? '' : '<div class="split"><button type="submit" class="btn" id="laSave">구역 저장</button>' + (old ? '<button type="button" class="btn ghost" data-la="toggle">' + (data.disabled ? '다시 적용' : data.effect === 'include' ? '예외 해제' : '제외 해제') + '</button>' : '') + '<button type="button" class="btn ghost" data-la="discard">초안 버리기</button></div>') + '</form>', { key: 'laedit', reopen: () => renderEditor(), back: draft.returnSection === 'light' && api.returnLightingReview ? () => api.returnLightingReview() : null });
    updateGeometry();
    const form = Q('#laForm'), sequence = editorSequence, scope = generation;
    requestAnimationFrame(() => { if (ownsView(form, draft, sequence, scope)) initializeMap(); });
  }
  function updateGeometry() {
    const draft = state.draft; if (!draft || Q('#laForm')?.dataset.recordId !== draft.recordId) return;
    let hint = '', valid = false;
    try {
      const data = geometryPreview(draft); valid = true;
      hint = (data.shape === 'circle' ? '선택 반경 ' + data.radius + 'm' : '선택 경계 ' + data.vertices.length + '점') + ' · ' + EFFECTS[data.effect] + (data.disabled ? ' · 적용 해제 상태' : '');
    } catch (error) { hint = errorText(error); }
    const geometry = Q('#laGeometryHint'); if (geometry) { geometry.textContent = hint; geometry.dataset.valid = String(valid); }
    const locked = draft.readonly || !!draft.pending || !!draft.conflict || !canWrite();
    if (Q('#laSave')) Q('#laSave').disabled = locked || !valid;
    if (draft.data.shape === 'polygon') {
      const session = polygonSession(draft), editor = session.editor;
      let points = []; try { points = parseVertices(draft.polygonText); } catch (_) {}
      const count = points.length, selected = editor.selected;
      for (const [id, disabled] of [['laDrawMode', locked || count >= 32], ['laEditMode', locked || !valid], ['laUndo', locked || !root.DGPolygonEditor.canUndo(editor)], ['laRedo', locked || !root.DGPolygonEditor.canRedo(editor)], ['laDeletePoint', locked || selected === null || selected >= count]]) { if (Q('#' + id)) Q('#' + id).disabled = disabled; }
      Q('#laDrawMode')?.setAttribute('aria-pressed', String(session.mode === 'draw'));
      Q('#laEditMode')?.setAttribute('aria-pressed', String(session.mode === 'edit'));
      if (Q('#laPointState')) Q('#laPointState').textContent = count + '/32점 · ' + (locked ? '지금은 수정할 수 없어요.' : session.mode === 'draw' ? count < 3 ? '둘레를 따라 최소 3점을 찍어 주세요.' : '점을 더 찍거나 그리기를 마쳐 주세요.' : '모양 수정 중 · 지도 바탕을 눌러도 점이 추가되지 않아요.') + (selected !== null && selected < count ? ' · ' + (selected + 1) + '번 점 선택' : '');
    }
    if (Q('#laMapHint') && editorMap) Q('#laMapHint').textContent = locked ? '저장한 범위를 확인하세요. 현재 편집은 잠겨 있어요.' : draft.data.shape === 'circle' ? '지도를 눌러 중심을 지정하고 아래에서 반경을 정해 주세요.' : polygonSession(draft).mode === 'draw' ? '둘레를 차례대로 누르세요. 번호 점은 끌어서 고칠 수 있어요.' : '번호 점을 끌어 모양을 고치세요. 새 꼭짓점은 선의 +로 추가해요.';
    drawMap();
  }
  function initializeMap() {
    const element = Q('#laMap'); if (!element) return;
    if (!root.L) { element.hidden = true; Q('#laMapHint').textContent = '지도를 불러오지 못했어요. 중심 좌표 또는 경계점 좌표로 범위를 지정할 수 있어요.'; return; }
    const draft = state.draft, sequence = editorSequence, scope = generation, form = Q('#laForm');
    try {
      const data = draft.data, center = pointValid(data) ? [+data.lat, +data.lng] : [35.145, 126.928];
      editorMap = root.L.map(element, { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false, doubleClickZoom: false }).setView(center, pointValid(data) ? 17 : 14);
      root.DongguPWA.tileLayer(root.L).addTo(editorMap); mapLayer = root.L.layerGroup().addTo(editorMap);
      editorMap.on('click', event => {
        if (!ownsView(form, draft, sequence, scope) || draft.readonly || draft.pending || draft.conflict || !canWrite()) return;
        readForm();
        if (draft.data.shape === 'circle') { Q('#laLat').value = event.latlng.lat.toFixed(6); Q('#laLng').value = event.latlng.lng.toFixed(6); changed(); }
        else if (polygonSession(draft).mode === 'draw') {
          try { editPolygon(editor => root.DGPolygonEditor.add(editor, { lat: +event.latlng.lat.toFixed(6), lng: +event.latlng.lng.toFixed(6) })); }
          catch (error) { api.toast(errorText(error)); }
        }
      });
      drawMap(true); editorMap.invalidateSize();
    } catch (error) { destroyMap(); element.hidden = true; Q('#laMapHint').textContent = '지도를 열지 못했어요. 좌표로 범위를 지정해 주세요. ' + errorText(error); }
  }
  // editor colors follow the day/night theme (Leaflet needs resolved values, not var())
  const areaColor = effect => {
    const name = effect === 'include' ? 'bright' : 'weak', fallback = effect === 'include' ? '#176d66' : '#b97900';
    try { return getComputedStyle(document.documentElement).getPropertyValue('--rv-' + name).trim() || fallback; } catch (_) { return fallback; }
  };
  if (typeof MutationObserver === 'function' && root.document?.documentElement) new MutationObserver(() => drawMap()).observe(root.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (typeof root.matchMedia === 'function') { const mq = root.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', () => drawMap()); }
  function drawMap(fit = false) {
    if (!editorMap || !mapLayer || !state.draft || !Q('#laMap')?.isConnected) return;
    const drawing = ++mapSequence;
    mapLayer.clearLayers(); const draft = state.draft, data = draft.data;
    const form = Q('#laForm'), sequence = editorSequence, scope = generation;
    for (const record of state.records.filter(r => !r.disabled && r.id !== draft.recordId)) {
      const style = { color: areaColor(record.effect), weight: 1, opacity: .45, fillOpacity: .04, interactive: false };
      if (record.shape === 'circle') root.L.circle([record.lat, record.lng], { ...style, radius: record.radius }).addTo(mapLayer);
      else root.L.polygon(record.vertices.map(p => [p.lat, p.lng]), style).addTo(mapLayer);
    }
    const style = { color: areaColor(data.effect), weight: 3, dashArray: data.disabled ? '5 5' : null, fillOpacity: data.disabled ? .04 : .15, interactive: false };
    let layer, bounds;
    if (data.shape === 'circle' && pointValid(data) && +data.radius > 0 && +data.radius <= 1000) layer = root.L.circle([+data.lat, +data.lng], { ...style, radius: +data.radius }).addTo(mapLayer);
    else if (data.shape === 'polygon') {
      let points; try { points = parseVertices(draft.polygonText); } catch (_) { return; }
      const session = polygonSession(draft), editor = session.editor, text = draft.polygonText;
      const alive = () => drawing === mapSequence && polygonEditable(form, draft, sequence, scope) && draft.polygonText === text && polygonSession(draft) === session;
      const editable = alive();
      if (Q('#laGeometryHint')?.dataset.valid === 'false') { style.dashArray = '6 5'; style.fillOpacity = .06; }
      if (points.length >= 2) layer = (points.length >= 3 ? root.L.polygon : root.L.polyline)(points.map(p => [p.lat, p.lng]), style).addTo(mapLayer);
      if (points.length) bounds = root.L.latLngBounds(points.map(p => [p.lat, p.lng]));
      for (let index = 0; index < points.length; index++) {
        const point = points[index], selected = editor.selected === index;
        const marker = root.L.marker([point.lat, point.lng], { icon: root.L.divIcon({ className: 'la-vertex' + (selected ? ' is-selected' : ''), html: '<span>' + (index + 1) + '</span>', iconSize: [44, 44], iconAnchor: [22, 22] }), draggable: editable, keyboard: editable, bubblingMouseEvents: false, title: '경계점 ' + (index + 1), zIndexOffset: selected ? 1000 : 500 }).addTo(mapLayer);
        const element = marker.getElement();
        if (element) { element.setAttribute('aria-label', '경계점 ' + (index + 1)); element.setAttribute('data-point', String(index)); element.setAttribute('aria-pressed', String(selected)); if (!editable) { element.setAttribute('aria-disabled', 'true'); element.tabIndex = -1; } }
        const choose = () => { if (!alive()) return; root.DGPolygonEditor.select(editor, index); updateGeometry(); focusPoint(index); };
        marker.on('click', choose);
        element?.addEventListener('keydown', event => {
          if (!alive()) return;
          if (event.key === ' ' || event.key === 'Enter') { root.L.DomEvent.stop(event); choose(); return; }
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'].includes(event.key)) {
            root.L.DomEvent.stop(event);
            try {
              if (event.key === 'Delete' || event.key === 'Backspace') editPolygon(ed => root.DGPolygonEditor.remove(ed, index));
              else { const delta = event.shiftKey ? .00005 : .00001; editPolygon(ed => root.DGPolygonEditor.move(ed, index, { lat: +(point.lat + (event.key === 'ArrowUp' ? delta : event.key === 'ArrowDown' ? -delta : 0)).toFixed(6), lng: +(point.lng + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0)).toFixed(6) }), true); }
            } catch (error) { api.toast(errorText(error)); }
          }
        });
        marker.on('drag', () => {
          if (!alive()) return;
          const moved = marker.getLatLng(), preview = points.map((p, i) => i === index ? [moved.lat, moved.lng] : [p.lat, p.lng]); layer?.setLatLngs(preview);
        });
        marker.on('dragend', () => {
          if (!alive()) { if (ownsView(form, draft, sequence, scope)) drawMap(); return; }
          const moved = marker.getLatLng();
          try { editPolygon(ed => root.DGPolygonEditor.move(ed, index, { lat: +moved.lat.toFixed(6), lng: +moved.lng.toFixed(6) })); }
          catch (error) { api.toast(errorText(error)); drawMap(); }
        });
        if (editable && session.mode === 'edit' && points.length >= 3 && points.length < 32) {
          const next = points[(index + 1) % points.length], mid = [(point.lat + next.lat) / 2, (point.lng + next.lng) / 2];
          const add = root.L.marker(mid, { icon: root.L.divIcon({ className: 'la-midpoint', html: '<span aria-hidden="true">+</span>', iconSize: [44, 44], iconAnchor: [22, 22] }), keyboard: true, bubblingMouseEvents: false, title: (index + 1) + '번과 ' + ((index + 1) % points.length + 1) + '번 사이에 점 추가' }).addTo(mapLayer);
          const addElement = add.getElement(); if (addElement) addElement.setAttribute('aria-label', add.options.title);
          const insert = () => { if (!alive() || session.mode !== 'edit') return; try { editPolygon(ed => root.DGPolygonEditor.insert(ed, index), true); } catch (error) { api.toast(errorText(error)); } };
          add.on('click', insert);
          addElement?.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { root.L.DomEvent.stop(event); insert(); } });
        }
      }
    }
    if (!bounds && layer?.getBounds) bounds = layer.getBounds();
    if (fit && bounds?.isValid()) editorMap.fitBounds(bounds.pad(.3), { maxZoom: 18, animate: false });
  }
  function changed() {
    const draft = readForm(); if (!draft || draft.readonly || draft.pending || draft.conflict || !canWrite()) return;
    const session = polygonSession(draft); root.DGPolygonEditor.update(session.editor, draft.polygonText, session.editor.text === draft.polygonText ? session.editor.selected : null);
    if (Q('#laCircleFields')) Q('#laCircleFields').hidden = draft.data.shape !== 'circle';
    if (Q('#laPolygonFields')) Q('#laPolygonFields').hidden = draft.data.shape !== 'polygon';
    for (const id of ['laPolygonTools', 'laPolygonActions']) if (Q('#' + id)) Q('#' + id).hidden = draft.data.shape !== 'polygon';
    updateGeometry(); writeDraft(draft).catch(error => api.toast(errorText(error)));
  }
  async function settleSynced(job, owner = null) {
    if (settlements.has(job.id)) return settlements.get(job.id);
    const original = saveViews.get(job.id), draft = original?.draft || owner || { recordId: job.payload?.recordId, pending: job.id };
    if (!draft.recordId) return;
    const scope = generation; appliedOperations.add(job.id);
    const work = (async () => {
      await clearDraft(draft); if (scope !== generation) return;
      await load(); if (scope !== generation) return;
      if (original && ownsView(original.form, draft, original.sequence, original.scope)) { returnFromEditor(draft); return; }
      const active = state.draft, form = Q('#laForm'), sequence = editorSequence;
      if (!active || active.pending !== job.id || !ownsView(form, active, sequence, scope)) return;
      const record = state.records.find(r => r.id === active.recordId); if (!record) return;
      const saved = await root.DGOffline.get(KIND, active.recordId);
      if (state.draft !== active || !ownsView(form, active, sequence, scope)) return;
      state.draft = saved && !saved.pending ? saved : fromRecord(record, null, active.returnSection);
      if (!state.draft.readonly) await writeDraft(state.draft);
      if (ownsView(form, active, sequence, scope)) renderEditor();
    })();
    settlements.set(job.id, work); return work;
  }
  async function save(toggle = false) {
    const draft = readForm(); if (!draft || draft.readonly || draft.pending || draft.conflict || !canWrite()) return;
    const data = normalizedDraft(draft); if (toggle) data.disabled = !data.disabled;
    const job = { id: uid('lighting-area-op'), recordId: draft.recordId, actor: actor(), at: Date.now(), expectedRevision: draft.expectedRevision, data };
    const form = Q('#laForm'), sequence = editorSequence, scope = generation;
    saveViews.set(job.id, { draft, form, sequence, scope });
    draft.pending = job.id; draft.data = copy(data); form.querySelector('fieldset').disabled = true;
    for (const button of form.querySelectorAll('button')) if (!button.dataset.asec) button.disabled = true;
    Q('#laSaveState').textContent = '구역을 저장하는 중이에요. 결과가 확인될 때까지 입력을 잠시 잠가요.';
    try {
      await writeDraft(draft);
      const result = await root.DGOffline.submit(JOB, job, { id: job.id, summary: EFFECTS[data.effect] + ' · ' + data.label });
      if (scope !== generation) return;
      if (result.state === 'synced') { await settleSynced(result, draft); api.toast(data.disabled ? '구역 적용을 해제했어요. 밝기 검토를 다시 실행해 주세요.' : '구역을 저장했어요. 밝기 검토를 다시 실행하면 반영돼요.'); }
      else if (ownsView(form, draft, sequence, scope)) { renderEditor(); api.toast(result.error || '구역을 저장 대기함에 보관했어요. 전송 완료 후 적용돼요.'); }
    } catch (error) {
      // A storage failure before queue admission keeps an editable draft. Existing jobs keep their fixed payload.
      const existing = (await root.DGOffline.jobs().catch(() => [])).find(j => j.id === job.id);
      if (!existing) { draft.pending = null; await writeDraft(draft).catch(() => {}); }
      if (ownsView(form, draft, sequence, scope)) { renderEditor(); showDraftError(draft, error); }
      throw error;
    }
  }
  async function restoreRecord(row, overwrite) {
    if (!canWrite()) fail('검토 구역 복원에는 관리자 권한이 필요해요.', 'permission-denied');
    const snap = await api.database().doc('lightingAreas/' + row.id).get(api.firebase() ? { source: 'server' } : undefined);
    const old = snap?.exists !== false && snap?.data ? snap.data() : null;
    if (old && !overwrite || !old && row.disabled) return { skipped: true };
    const job = { id: uid('lighting-area-restore'), recordId: row.id, actor: actor(), at: Date.now(), expectedRevision: old?.revision || 0, data: Core.normalize(row) };
    await Commands.execute(job, { db: api.database(), fb: api.firebase(), user: actor(), admin: api.can('admin') });
    return { skipped: false };
  }
  async function handle(button) {
    const action = button.dataset.la;
    if (action === 'new' || action === 'new-include') return openEditor({ effect: action === 'new-include' ? 'include' : 'exclude' });
    if (action === 'edit') return openEditor(null, button.dataset.id);
    if (action === 'resume') return openEditor(null, button.dataset.id, true);
    if (action === 'reload') return load();
    if (action === 'more') { state.show += 40; notify(); return; }
    if (action === 'candidate') {
      const review = api.lightingReview(), candidate = review && api.lightingCandidates(review)[Number(button.dataset.candidate)];
      if (!candidate) fail('검토를 다시 실행한 뒤 후보를 선택해 주세요.');
      if (api.rememberLightingCandidate) api.rememberLightingCandidate(button.dataset.candidate);
      const title = candidate.a ? candidate.a.code + ' ↔ ' + candidate.b.code : candidate.name;
      return openEditor({ ...candidate.mid, radius: 25, label: String(title || '검토 지점').slice(0, 90) + ' 주변', note: '검토 후보 주변 · 지도에서 실제 제외 범위를 확인하세요.', returnSection: 'light' });
    }
    if (action === 'back') {
      const draft = state.draft, form = Q('#laForm'), sequence = editorSequence, scope = generation;
      await persistActive(); if (!draft || !ownsView(form, draft, sequence, scope)) return;
      editorSequence++; returnFromEditor(draft); return;
    }
    if (action === 'toggle') return save(true);
    if (action === 'discard') {
      const draft = state.draft, form = Q('#laForm'), sequence = editorSequence, scope = generation;
      if (!draft || !await ask('작성 중인 구역 초안을 버려요. 저장된 구역은 유지돼요.', { title: '초안을 버릴까요?', ok: '버리기', danger: true })) return;
      await discardDraft(draft.recordId); if (!ownsView(form, draft, sequence, scope)) return;
      editorSequence++; returnFromEditor(draft); return;
    }
    if (action === 'fit-area') { drawMap(true); return; }
    if (action === 'draw-mode' || action === 'edit-mode') {
      const draft = state.draft;
      if (!draft || !polygonEditable(Q('#laForm'), draft, editorSequence, generation)) return;
      readForm(); if (action === 'edit-mode') geometryPreview(draft);
      polygonSession(draft).mode = action === 'draw-mode' ? 'draw' : 'edit'; updateGeometry(); return;
    }
    if (['undo-edit', 'redo-edit', 'delete-point', 'undo-point'].includes(action)) {
      return editPolygon(editor => {
        if (action === 'undo-edit') root.DGPolygonEditor.undo(editor);
        else if (action === 'redo-edit') root.DGPolygonEditor.redo(editor);
        else { const index = action === 'undo-point' ? root.DGPolygonEditor.points(editor.text).length - 1 : editor.selected; if (index !== null && index >= 0) root.DGPolygonEditor.remove(editor, index); }
      });
    }
    if (action === 'clear-points') {
      const draft = state.draft, form = Q('#laForm'), sequence = editorSequence, scope = generation;
      if (!draft || !polygonEditable(form, draft, sequence, scope)) return;
      readForm(); const text = draft.polygonText; if (!text.trim()) return;
      if (!await ask('찍어 둔 경계점을 모두 비울까요? 되돌리기로 복구할 수 있어요.', { title: '경계점 비우기', ok: '모두 비우기', cancel: '유지하기' })) return;
      if (!polygonEditable(form, draft, sequence, scope) || draft.polygonText !== text) return;
      editPolygon(editor => root.DGPolygonEditor.update(editor, '')); return;
    }
    if (action === 'reload-draft') {
      if (!await ask('현재 창의 저장되지 않은 입력 대신 최신 초안을 열까요?', { ok: '최신 초안 열기', cancel: '현재 입력 유지' })) return;
      const id = state.draft?.recordId, sequence = ++editorSequence, scope = generation; await writes.catch(() => {});
      const saved = id && await root.DGOffline.get(KIND, id); if (sequence !== editorSequence || scope !== generation) return;
      state.draft = saved; if (saved) { delete saved.conflict; saved.saveError = ''; renderEditor(); }
      else { await load(); if (state.records.some(r => r.id === id)) return openEditor(null, id); api.openSection('lightingareas'); } return;
    }
    if (action === 'copy-draft') {
      const previous = readForm(); if (!previous || previous.pending || !canWrite()) return;
      const data = copy(previous.data), polygonText = previous.polygonText, returnSection = previous.returnSection, form = Q('#laForm'), sequence = editorSequence, scope = generation;
      await writes.catch(() => {}); if (!ownsView(form, previous, sequence, scope)) return;
      editorSequence++;
      state.draft = { recordId: uid('lighting-area'), expectedRevision: 0, data: { ...data, disabled: false }, polygonText, readonly: false, pending: null, draftRevision: null, returnSection };
      renderEditor(); await writeDraft(state.draft); return;
    }
  }
  async function ready() {
    const scope = ++generation; editorSequence++; if (unsubscribe) unsubscribe(); destroyMap();
    loading = null; reloadRequested = false; signature = ''; compiled = null; searchComposing = false; state.loaded = false; state.error = ''; state.records = []; state.draft = null; state.drafts = []; settlements.clear(); appliedOperations.clear(); saveViews.clear();
    await writes.catch(() => {}); if (scope !== generation) return;
    const jobs = new Map((await root.DGOffline.jobs()).map(job => [job.id, job]));
    for (const entry of await root.DGOffline.list(KIND)) {
      if (scope !== generation) return;
      const draft = entry.value; if (!draft?.pending) continue;
      const job = jobs.get(draft.pending);
      if (job?.kind === JOB && job.state === 'synced') await clearDraft(draft);
      else if (!job) { draft.pending = null; await root.DGOffline.putIfCurrent(KIND, draft.recordId, draft, draft.draftRevision ?? 0); }
    }
    state.drafts = await root.DGOffline.list(KIND); if (scope !== generation) return;
    await load(); if (scope !== generation) return;
    if (actor() === 'local' || api.firebase()) {
      try { unsubscribe = api.database().collection('lightingAreas').onSnapshot(() => load(), error => { if (scope !== generation) return; state.error = errorText(error); state.loaded = false; api.invalidateLighting('검토 구역의 최신 상태를 읽지 못했어요.'); notify(); }); }
      catch (error) { state.error = errorText(error); state.loaded = false; notify(); }
    }
  }
  function attach(contextApi) {
    api = contextApi;
    root.DGOffline.register(JOB, job => Commands.execute(job, { db: api.database(), fb: api.firebase(), user: actor(), admin: api.can('admin') }));
    if (attached) return; attached = true;
    document.addEventListener('click', event => { const button = event.target.closest('[data-la]'); if (button) Promise.resolve().then(() => handle(button)).catch(error => api.toast(errorText(error))); });
    document.addEventListener('submit', event => { if (event.target.id === 'laForm') { event.preventDefault(); save().catch(error => api.toast(errorText(error))); } });
    document.addEventListener('input', event => {
      if (event.target.id === 'laSearch') { state.search = event.target.value; state.show = 40; if (!event.isComposing && !searchComposing) notify(); return; }
      if (event.target.closest('#laForm') && event.target.tagName !== 'SELECT') changed();
    });
    document.addEventListener('change', event => {
      const target = event.target;
      if (target.id === 'laFilter') { state.filter = target.value; state.show = 40; notify(); return; }
      if (!target.closest('#laForm')) return;
      if (target.id === 'laEffect') {
        const choices = target.value === 'include' ? { public_path: REASONS.public_path, other: REASONS.other } : Object.fromEntries(Object.entries(REASONS).filter(([k]) => k !== 'public_path'));
        const previous = Q('#laReason').value; Q('#laReason').innerHTML = option(choices, choices[previous] ? previous : target.value === 'include' ? 'public_path' : 'mountain');
      }
      changed();
    });
    document.addEventListener('compositionstart', event => { if (event.target.id === 'laSearch') searchComposing = true; });
    document.addEventListener('compositionend', event => { if (event.target.id === 'laSearch') { searchComposing = false; state.search = event.target.value; state.show = 40; notify(); } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistActive().catch(() => {}); });
    root.DGOffline.subscribe(event => {
      if (event.job?.kind !== JOB) return;
      if (event.type === 'synced') settleSynced(event.job).catch(error => api.toast(errorText(error)));
      if (event.type === 'discarded') {
        const scope = generation, id = event.job.payload?.recordId;
        writes = writes.catch(() => {}).then(async () => {
          if (scope !== generation || !id) return;
          const saved = await root.DGOffline.get(KIND, id); if (saved?.pending !== event.job.id) return;
          saved.pending = null; const next = await root.DGOffline.putIfCurrent(KIND, id, saved, saved.draftRevision ?? 0);
          if (scope !== generation) return;
          if (state.draft?.recordId === id && state.draft.pending === event.job.id) { state.draft = next; if (Q('#laForm')?.dataset.recordId === id && sheetOpen()) renderEditor(); }
          state.drafts = await root.DGOffline.list(KIND); notify();
        }).catch(error => api.toast(errorText(error)));
      }
    });
  }
  root.DGLightingAreas = { attach, ready, load, view, state, openEditor, context, snapshot, persistActive, discardDraft, restoreRecord, reasons: REASONS, effects: EFFECTS,
    hasActiveDraft: () => writeCount > 0 || !!(sheetOpen() && Q('#laForm') && state.draft && !state.draft.readonly) };
})(globalThis);
