/* Follow-up tasks, explicit import previews, and immutable brightness review history. */
(function (root) {
  'use strict';
  const C = root.DGLightingWorkflowCore, Commands = root.DGLightingWorkflowCommands;
  const state = { tasks: [], tasksLoaded: false, tasksError: '', taskFilter: 'open', taskShow: 40, runs: [], runsLoaded: false, runsError: '', runShow: 30, draft: null,
    import: { parsed: null, name: '', agency: '', dataset: '', mapping: {}, preview: null, busy: false, progress: '', show: 50 } };
  let api, attached = false, taskLoading, taskReload = false, historyLoading, taskWrites = Promise.resolve(), draftWriteCount = 0, unsubscribe, generation = 0, taskEditorSequence = 0;
  const appliedTaskOperations = new Set(), taskSettlements = new Map(), taskSaveViews = new Map();
  const Q = selector => document.querySelector(selector), E = value => api.esc(value == null ? '' : value), copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const uid = prefix => root.DGData.newId(prefix), actor = () => api.state().me;
  const supported = () => api.state().canWrite && api.can('inspect') && (!!api.firebase() || typeof api.database()?.commitMany === 'function');
  const dateInput = at => at ? new Date(at + 9 * 3600000).toISOString().slice(0, 16) : '';
  const time = at => root.DGLighting.kstTime(at), minuteText = m => root.DGLighting.minuteText(m);
  const statusLabel = { open: '재확인 진행', completed: '현장 확인 완료', cancelled: '취소' };
  const names = () => api.state().names || {};
  const heading = title => '<div class="sheet-head"><h3>' + E(title) + '</h3><button class="x" data-close aria-label="닫기">×</button></div>';
  const errorText = error => String(error?.message || error || '처리를 완료하지 못했어요.');
  function notify() {
    if (Q('#lwTasks')) Q('#lwTasks').outerHTML = tasksView();
    else if (Q('#lwHistory')) Q('#lwHistory').outerHTML = historyView();
    else if (Q('#lwImport')) Q('#lwImport').outerHTML = importView();
    else api.render();
  }
  async function loadTasks() {
    if (taskLoading) { taskReload = true; return taskLoading; }
    const started = generation;
    taskLoading = (async () => {
      try { do { taskReload = false; const rows = await api.readAll('lightingTasks', { requireServer: !!api.firebase() }); if (generation !== started) return; state.tasks = rows.sort((a, b) => a.dueAt - b.dueAt); state.tasksLoaded = true; state.tasksError = ''; } while (taskReload); }
      catch (error) { if (generation === started) state.tasksError = errorText(error); }
      finally { if (generation === started) { taskLoading = null; notify(); } }
    })();
    return taskLoading;
  }
  async function loadHistory() {
    if (historyLoading) return historyLoading;
    const started = generation;
    historyLoading = (async () => {
      try { const rows = await api.readAll('lightingRuns', { requireServer: !!api.firebase() }); if (generation !== started) return; for (const row of rows) C.normalizeRun(row); state.runs = rows.sort((a, b) => b.reviewedAt - a.reviewedAt); state.runsLoaded = true; state.runsError = ''; }
      catch (error) { if (generation === started) { state.runsError = errorText(error); state.runsLoaded = false; } }
      finally { if (generation === started) { historyLoading = null; notify(); } }
    })();
    return historyLoading;
  }
  function tasksView() {
    if (!state.tasksLoaded && !state.tasksError && !taskLoading) queueMicrotask(loadTasks);
    const now = Date.now(), rows = state.tasks.filter(r => state.taskFilter === 'all' || state.taskFilter === 'mine' && r.assignedTo === actor() && r.status === 'open' || state.taskFilter === 'overdue' && r.status === 'open' && r.dueAt < now || r.status === state.taskFilter);
    const stale = root.DGLighting.state.records.filter(r => !r.removed && r.observedAt + r.validDays * 86400000 <= now), drafts = state.draft;
    return '<div id="lwTasks"><div class="panel"><h3>밝기 재확인 업무</h3><p>대장 시설이 없는 지점도 담당자·기한·방문 시간대를 정해 확인해요. 완료에는 업무 등록 이후의 유효한 야간 관찰이 필요해요.</p><div class="split"><button class="btn" data-lw="task-new"' + (supported() ? '' : ' disabled') + '>지점 재확인 등록</button><button class="btn ghost" data-lw="tasks-refresh">새로고침</button><button class="btn ghost" data-lw="tasks-csv"' + (!state.tasksLoaded || state.tasksError ? ' disabled' : '') + '>업무 전체 CSV</button></div>' +
      (drafts ? '<button class="btn ghost block" data-lw="task-resume" data-id="' + E(drafts.recordId) + '">작성 중인 재확인 업무 이어쓰기</button>' : '') +
      '<label class="f" for="lwTaskFilter">업무 보기</label><select class="f-in" id="lwTaskFilter">' + Object.entries({ open: '진행 중', mine: '내 진행 업무', overdue: '기한 초과', completed: '완료', cancelled: '취소', all: '전체' }).map(([key, label]) => '<option value="' + key + '"' + (state.taskFilter === key ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>' +
      (state.tasksError ? '<p class="notice" role="alert">전체 업무를 확인하지 못했어요: ' + E(state.tasksError) + '</p>' : '<p class="muted">전체 ' + state.tasks.length + '건 · 현재 보기 ' + rows.length + '건</p>') + '</div>' +
      rows.slice(0, state.taskShow).map(t => '<div class="panel"><b>' + E(t.title) + '</b><p>' + E(statusLabel[t.status]) + ' · ' + E(names()[t.assignedTo] || t.assignedTo) + (t.status === 'open' && t.dueAt < now ? ' · 기한 초과' : '') + '</p><p>기한 ' + E(time(t.dueAt)) + ' · 확인 ' + E(minuteText(t.reviewMinute)) + ' KST</p><p class="muted">' + E(t.lat.toFixed(6)) + ', ' + E(t.lng.toFixed(6)) + ' · ' + E(t.radius) + 'm</p><button class="btn ghost sm" data-lw="task-open" data-id="' + E(t.id) + '">업무·관찰 결과</button></div>').join('') +
      (rows.length > state.taskShow ? '<button class="btn ghost block" data-lw="tasks-more">더 보기</button>' : '') + (!rows.length && state.tasksLoaded ? '<p class="empty">이 조건의 업무가 없어요.</p>' : '') +
      '<div class="panel"><h3>재확인 기한이 지난 근거 ' + stale.length + '건</h3><p>자료를 확인하고 필요한 업무를 등록하세요. 이미 진행 중인 같은 원본·시간의 업무는 기존 업무를 열어요.</p>' + stale.slice(0, 30).map(r => '<p>' + E(r.label) + ' <button class="btn ghost sm" data-lw="record-task" data-record-id="' + E(r.id) + '">업무로 연결</button></p>').join('') + (stale.length > 30 ? '<p class="muted">최근 목록 30건 표시 · 전체는 외부 광원·관찰의 기한 경과 필터에서 확인해요.</p>' : '') + '</div></div>';
  }
  function readTaskForm() {
    const d = state.draft, form = Q('#lwTaskForm');
    if (!d || d.readonly || d.pending || form?.dataset.recordId !== d.recordId || !Q('#sheet.open')) return d;
    Object.assign(d.data, { title: Q('#lwTitle').value, lat: Q('#lwLat').value, lng: Q('#lwLng').value, radius: Q('#lwRadius').value, assignedTo: Q('#lwAssigned').value, dueAt: Date.parse(Q('#lwDue').value + '+09:00'), reviewMinute: root.DGLighting.parseMinute(Q('#lwMinute').value), note: Q('#lwNote').value });
    if (Q('#lwObservation')) { d.data.observationId = Q('#lwObservation').value; d.data.completionNote = Q('#lwCompletion').value; }
    return d;
  }
  function persistDraft(read = true, owner = state.draft) {
    const d = read && owner === state.draft ? readTaskForm() : owner;
    if (!d || d.readonly || !root.DGOffline.ready) return taskWrites;
    if (d.pending && appliedTaskOperations.has(d.pending)) return taskWrites;
    const value = copy(d), scope = generation;
    draftWriteCount++;
    taskWrites = taskWrites.catch(() => {}).then(async () => {
      if (scope !== generation) C.fail('계정이 바뀌어 이전 초안 쓰기를 중단했어요.', 'account-changed');
      if (value.pending && appliedTaskOperations.has(value.pending)) return;
      if (d.conflict) C.fail('다른 탭의 초안이 바뀌었어요. 최신 초안을 다시 열어 주세요.', 'conflict');
      if (!root.DGOffline.putIfCurrent) C.fail('새 버전을 적용한 뒤 재확인 업무를 작성해 주세요.', 'unsupported-backend');
      try { const saved = await root.DGOffline.putIfCurrent('lightingTaskDraft', d.recordId, value, d.draftRevision ?? null); d.draftRevision = saved.draftRevision; }
      catch (error) { if (error.code === 'conflict') { d.conflict = true; if (Q('#lwTaskForm')?.dataset.recordId === d.recordId) { const notice = Q('#lwTaskState'); if (notice) notice.textContent = '다른 탭의 초안이 바뀌었어요. 현재 입력은 화면에 남아 있으며 저장되지 않았어요.'; const controls = Q('#lwDraftConflict'); if (controls) controls.hidden = false; } } throw error; }
    }).finally(() => { draftWriteCount--; });
    return taskWrites;
  }
  function clearTaskDraft(owner) {
    if (!owner || !root.DGOffline.ready) return taskWrites;
    const scope = generation;
    if (owner.pending) appliedTaskOperations.add(owner.pending);
    taskWrites = taskWrites.catch(() => {}).then(async () => {
      if (scope !== generation) return;
      const saved = await root.DGOffline.get('lightingTaskDraft', owner.recordId);
      if (saved && saved.pending === owner.pending) {
        try { await root.DGOffline.removeIfCurrent('lightingTaskDraft', owner.recordId, saved.draftRevision ?? 0); }
        catch (error) {
          const latest = await root.DGOffline.get('lightingTaskDraft', owner.recordId);
          if (error.code !== 'conflict' || latest?.pending === owner.pending) throw error;
        }
      }
      if (scope === generation && state.draft === owner) state.draft = null;
    });
    return taskWrites;
  }
  async function taskDraftApplied(draft) {
    if (!draft?.pending) return false;
    if (appliedTaskOperations.has(draft.pending)) return true;
    const receipt = Commands.dataOf(await api.database().doc('lightingWorkflowOperations/' + C.id(draft.pending)).get(api.firebase() ? { source: 'server' } : undefined));
    return receipt?.entity === 'task' && receipt.recordId === draft.recordId && receipt.by === actor() && receipt.revision === draft.expectedRevision + 1;
  }
  const taskViewOwned = view => view && view.scope === generation && view.sequence === taskEditorSequence && view.form?.isConnected && Q('#lwTaskForm') === view.form && view.form.dataset.recordId === view.draft.recordId && view.form.dataset.editorSequence === String(view.sequence) && !!Q('#sheet.open');
  const taskReadonly = task => !!task && (!api.can('admin') && task.assignedTo !== actor() || task.status !== 'open');
  function taskFromRecord(task, draftRevision = null) { return { recordId: task.id, data: C.normalizeTask(task), expectedRevision: task.revision, readonly: taskReadonly(task), pending: null, draftRevision }; }
  function settleTask(job, fallbackOwner) {
    if (taskSettlements.has(job.id)) return taskSettlements.get(job.id);
    const scope = generation, original = taskSaveViews.get(job.id), owner = original?.draft || fallbackOwner || { recordId: job.payload?.recordId, pending: job.id };
    if (!owner.recordId) return Promise.resolve();
    appliedTaskOperations.add(job.id);
    const work = (async () => {
      await clearTaskDraft(owner); if (scope !== generation) return;
      await loadTasks(); if (scope !== generation) return;
      if (taskViewOwned(original)) { api.closeSheet(); return; }
      // A pending task may have been reopened before its acknowledgement. Refresh
      // that current locked view from the committed record, without closing it.
      const active = state.draft, form = Q('#lwTaskForm'), sequence = taskEditorSequence;
      if (!active || active.pending !== job.id || !taskViewOwned({ draft: active, form, sequence, scope })) return;
      const task = state.tasks.find(t => t.id === active.recordId); if (!task) return;
      const saved = await root.DGOffline.get('lightingTaskDraft', active.recordId);
      if (state.draft !== active || !taskViewOwned({ draft: active, form, sequence, scope })) return;
      state.draft = saved && !saved.pending ? saved : taskFromRecord(task);
      if (!state.draft.readonly) await persistDraft(false);
      if (taskViewOwned({ draft: active, form, sequence, scope })) renderTask();
    })();
    taskSettlements.set(job.id, work); return work;
  }
  async function discardDraft(recordId) {
    await taskWrites.catch(() => {}); const saved = await root.DGOffline.get('lightingTaskDraft', recordId);
    if (!saved) return;
    if (saved.pending) C.fail('전송 중인 업무는 저장 대기함에서 먼저 처리해 주세요.');
    const active = state.draft?.recordId === recordId ? state.draft : null;
    await root.DGOffline.removeIfCurrent('lightingTaskDraft', recordId, active?.draftRevision ?? saved.draftRevision ?? 0);
    if (active && state.draft === active) state.draft = null;
  }
  async function openTask(input = null, recordId = null, resume = false) {
    if (!supported()) return api.toast('재확인 업무에는 점검 권한과 저장소가 필요해요.');
    const gen = api.navGen ? api.navGen() : null, sequence = ++taskEditorSequence, scope = generation, current = () => sequence === taskEditorSequence && scope === generation && (gen === null || api.navAlive(gen));
    await persistDraft(); if (!current()) return;
    if (recordId || !state.tasksLoaded) await loadTasks(); if (!current()) return;
    if (state.tasksError) C.fail('최신 재확인 업무를 읽은 뒤 다시 열어 주세요.');
    if (!recordId && input?.originId) { const existing = state.tasks.find(t => t.status === 'open' && t.originKind === input.originKind && t.originId === input.originId && t.reviewMinute === input.reviewMinute); if (existing) recordId = existing.id; }
    let old = recordId && state.tasks.find(t => t.id === recordId), previous = recordId && await root.DGOffline.get('lightingTaskDraft', recordId);
    if (!current()) return;
    if (previous?.pending && await taskDraftApplied(previous)) {
      if (!current()) return;
      await clearTaskDraft(previous); if (!current()) return;
      await loadTasks(); if (!current()) return;
      previous = await root.DGOffline.get('lightingTaskDraft', recordId); if (!current()) return;
      old = state.tasks.find(t => t.id === recordId);
    }
    if (!current()) return;
    if (recordId && !old && !(resume && previous)) C.fail('업무를 찾지 못했어요. 새로고침해 주세요.');
    if (resume && !previous && !old) C.fail('이어 쓸 재확인 초안이 없어요.');
    if (previous && (resume || previous.pending || confirm('작성 중인 재확인 초안을 이어 쓸까요?'))) { state.draft = previous; if (old) state.draft.readonly = taskReadonly(old); }
    else if (old) state.draft = taskFromRecord(old, previous?.draftRevision ?? null);
    else {
      const now = Date.now(), data = { title: input?.title || '', lat: input?.lat ?? '', lng: input?.lng ?? '', radius: input?.radius || 10, note: input?.note || '', originKind: input?.originKind || 'manual', originId: input?.originId || '', evidenceIds: input?.evidenceIds || [], assignedTo: actor(), dueAt: now + 86400000, reviewMinute: input?.reviewMinute ?? 1260, status: 'open', observationId: '', completionNote: '', completedAt: 0, completedBy: '' };
      state.draft = { recordId: uid('lighting-task'), data, expectedRevision: 0, readonly: false, pending: null, draftRevision: null };
    }
    const draft = state.draft;
    if (!draft.readonly) await persistDraft(false, draft);
    if (current() && state.draft === draft) renderTask();
  }
  function renderTask() {
    const draft = state.draft; if (!draft) return;
    const d = draft.data, old = state.tasks.find(t => t.id === draft.recordId), locked = draft.readonly || !!draft.pending, mayAssign = api.can('admin');
    const people = { [actor()]: names()[actor()] || '나', ...names() }; if (!people[d.assignedTo]) people[d.assignedTo] = d.assignedTo;
    const compatible = root.DGLighting.state.records.filter(r => { if (d.status === 'completed' && r.id === d.observationId) return true; try { C.checkCompletion({ ...d, createdAt: old?.createdAt || Date.now() }, r, Date.now()); return true; } catch (_) { return false; } });
    api.navigate(heading('밝기 재확인 업무') + '<form id="lwTaskForm" data-record-id="' + E(draft.recordId) + '" data-editor-sequence="' + taskEditorSequence + '" class="panel"><fieldset' + (locked ? ' disabled' : '') + ' style="border:0;padding:0;min-width:0"><label class="f" for="lwTitle">업무 제목</label><input class="f-in" id="lwTitle" maxlength="120" value="' + E(d.title) + '" required><div class="grid2"><div><label class="f" for="lwLat">위도</label><input class="f-in" id="lwLat" type="number" step="any" value="' + E(d.lat) + '" required></div><div><label class="f" for="lwLng">경도</label><input class="f-in" id="lwLng" type="number" step="any" value="' + E(d.lng) + '" required></div></div><label class="f" for="lwRadius">확인 범위 반경 (5–80m)</label><input class="f-in" id="lwRadius" type="number" min="5" max="80" value="' + E(d.radius) + '"><label class="f" for="lwAssigned">담당자</label><select class="f-in" id="lwAssigned"' + (mayAssign ? '' : ' disabled') + '>' + Object.entries(people).map(([id, name]) => '<option value="' + E(id) + '"' + (id === d.assignedTo ? ' selected' : '') + '>' + E(name) + '</option>').join('') + '</select><label class="f" for="lwDue">확인 기한 (한국 시간)</label><input class="f-in" id="lwDue" type="datetime-local" value="' + E(dateInput(d.dueAt)) + '" required><label class="f" for="lwMinute">현장에서 확인할 시간 (KST)</label><input class="f-in" id="lwMinute" type="time" value="' + E(minuteText(d.reviewMinute)) + '" required><label class="f" for="lwNote">확인할 내용</label><textarea class="f-in" id="lwNote" maxlength="1500">' + E(d.note) + '</textarea>' +
      (old ? '<h4>현장 결과 연결</h4><label class="f" for="lwObservation">이 업무 이후의 유효한 관찰</label><select class="f-in" id="lwObservation"><option value="">현장 관찰을 선택해 주세요</option>' + compatible.map(r => '<option value="' + E(r.id) + '"' + (d.observationId === r.id ? ' selected' : '') + '>' + E(r.label + ' · ' + root.DGLighting.levels[r.level] + ' · ' + time(r.observedAt)) + '</option>').join('') + '</select><label class="f" for="lwCompletion">확인 결과와 다음 조치</label><textarea class="f-in" id="lwCompletion" maxlength="1000">' + E(d.completionNote) + '</textarea><p class="muted">새 관찰을 저장한 뒤 이 업무를 다시 열어 연결하세요. 완료해도 시설 상태나 보수 완료를 자동 변경하지 않아요.</p>' : '') + '</fieldset><p id="lwTaskState" class="notice" role="status">' + (draft.pending ? '저장 대기함에서 전송 결과를 확인해 주세요.' : draft.readonly ? E(statusLabel[d.status]) : '초안은 기록별로 보관하며 다른 탭과 충돌하면 덮어쓰지 않아요.') + '</p>' +
      '<div id="lwDraftConflict"' + (draft.conflict ? '' : ' hidden') + '><button class="btn ghost" type="button" data-lw="task-reload-draft">최신 초안 다시 열기</button><button class="btn ghost" type="button" data-lw="task-copy-draft">현재 입력을 새 업무 초안으로 복사</button></div>' +
      (!locked ? '<div class="split"><button class="btn" type="submit">업무 저장</button>' + (old ? '<button class="btn ghost" type="button" data-lw="task-complete">현장 확인 완료</button><button class="btn ghost" type="button" data-lw="task-cancel">업무 취소</button>' : '') + '<button class="btn ghost" type="button" data-lw="task-discard">초안 버리기</button></div>' : '') +
      (old?.status === 'open' && !draft.pending ? '<button class="btn ghost block" type="button" data-lw="task-observe" data-id="' + E(old.id) + '">이 지점의 현장 밝기 기록</button>' : '') +
      (old && old.status !== 'open' && api.can('admin') ? '<button class="btn ghost block" type="button" data-lw="task-reopen" data-id="' + E(old.id) + '">업무 다시 열기</button>' : '') + '</form>', { key: 'lwtask', reopen: () => renderTask() });
  }
  async function saveTask(status = 'open') {
    const draft = readTaskForm(); if (!draft || draft.readonly || draft.pending || draft.conflict) return;
    const at = Date.now(), data = { ...draft.data, status, completedAt: status === 'completed' ? at : 0, completedBy: status === 'completed' ? actor() : '', observationId: status === 'completed' ? draft.data.observationId : '' };
    const normalized = C.normalizeTask(data), job = { id: uid('lighting-workflow'), entity: 'task', recordId: draft.recordId, actor: actor(), at, expectedRevision: draft.expectedRevision, data: normalized };
    const form = Q('#lwTaskForm'), view = { draft, form, sequence: taskEditorSequence, scope: generation }; taskSaveViews.set(job.id, view);
    draft.pending = job.id; if (form?.isConnected) form.querySelector('fieldset').disabled = true;
    try {
      await persistDraft(false, draft);
      const result = await root.DGOffline.submit('lighting-workflow', job, { id: job.id, summary: '밝기 재확인 · ' + data.title });
      if (view.scope !== generation) return;
      if (result.state === 'synced') { await settleTask(result, draft); api.toast('재확인 업무를 저장했어요.'); }
      else { api.toast(result.error || '업무를 저장 대기함에 보관했어요.'); if (state.draft === draft && taskViewOwned(view)) renderTask(); }
    } catch (error) {
      const queued = (await root.DGOffline.jobs().catch(() => [])).find(j => j.id === job.id);
      if (!queued && view.scope === generation) { draft.pending = null; await persistDraft(false, draft).catch(() => {}); }
      throw error;
    }
    finally { if (taskViewOwned(view) && !draft.pending) form.querySelector('fieldset').disabled = false; }
  }
  async function reopenTask(id) {
    const old = state.tasks.find(t => t.id === id); if (!old || !api.can('admin')) C.fail('관리자만 완료·취소 업무를 다시 열 수 있어요.', 'permission-denied');
    const at = Date.now(), job = { id: uid('lighting-workflow'), entity: 'task', recordId: id, actor: actor(), at, expectedRevision: old.revision, data: { ...C.normalizeTask(old), status: 'open', observationId: '', completionNote: '', completedAt: 0, completedBy: '' } };
    const result = await root.DGOffline.submit('lighting-workflow', job, { id: job.id, summary: '재확인 업무 다시 열기 · ' + old.title });
    if (result.state === 'synced') { await loadTasks(); await openTask(null, id); } else api.toast(result.error || '업무 재개를 저장 대기함에 보관했어요.');
  }
  async function candidateTask(index) {
    const review = api.lightingReview(), candidate = review && api.lightingCandidates(review)[+index]; if (!candidate) C.fail('검토를 다시 실행한 뒤 지점을 선택해 주세요.');
    const title = candidate.a ? candidate.a.code + ' ↔ ' + candidate.b.code : candidate.name;
    const originId = await C.digest({ lat: +candidate.mid.lat.toFixed(6), lng: +candidate.mid.lng.toFixed(6), title });
    const evidenceIds = [...new Set([...candidate.context.sources, ...candidate.context.observations].map(r => r.id))];
    if (evidenceIds.length > 20) C.fail('연결 근거가 20개를 넘어요. 구간을 나누거나 지점을 직접 등록해 주세요. 근거를 임의로 생략하지 않아요.');
    return openTask({ title: String(title).slice(0, 120), ...candidate.mid, radius: 10, originKind: 'candidate', originId, evidenceIds, reviewMinute: review.minute, note: root.DGLighting.classification(candidate.context.classification) + ' · 대장 ' + candidate.context.base.toFixed(2) + ' → 외부 반영 ' + candidate.context.adjusted.toFixed(2) + ' (상대 지수)' });
  }
  function recordTask(id) {
    const record = root.DGLighting.state.records.find(r => r.id === id); if (!record) C.fail('원본 기록을 다시 읽어 주세요.');
    return openTask({ title: (record.label + ' 재확인').slice(0, 120), lat: record.lat, lng: record.lng, radius: Math.min(80, record.radius), originKind: 'record', originId: id, evidenceIds: [id], reviewMinute: api.state().rvMinute ?? 1260, note: root.DGLighting.recordSummary(record) });
  }
  function reviewHistoryStatus(review) {
    const status = !review ? '' : review.historyState === 'synced' ? '현재 실행 이력 보관 완료' : review.historyState === 'preparing' ? '현재 실행 이력 준비 중…' : review.historyState === 'queued' ? '실행 이력 전송 대기 · 저장 대기함 확인' : review.historyError || '';
    return '<div class="split"><button class="btn ghost sm" data-lw="tasks">재확인 업무</button><button class="btn ghost sm" data-lw="history">검토 이력·관찰 비교</button>' + (review && !['synced', 'preparing', 'queued'].includes(review.historyState) ? '<button class="btn ghost sm" data-lw="run-save">현재 실행 이력 보관</button>' : '') + '</div>' + (status ? '<p class="notice" role="status">' + E(status) + '</p>' : '') + '<p class="muted">검토 이력은 전체 후보·관찰 비교와 모델 버전을 함께 보관해요. 1회 최대 600KB이며 초과하면 범위를 나눠 검토해 주세요.</p>';
  }
  async function captureReview(review) {
    if (!supported() || !review || ['preparing', 'synced', 'queued'].includes(review.historyState)) return;
    const scope = generation, author = actor();
    review.historyState = 'preparing'; review.historyError = ''; api.render();
    try {
      let job = review.historyJob;
      if (!job) {
        const grid = api.lightingGrid(), configuration = api.lightingModel();
        const data = await C.buildRun({ review: copy(review), lights: copy(api.state().lights), records: copy(root.DGLighting.state.records), roads: copy(api.lightingRoads() || null), model: copy(configuration.model), calibration: copy(configuration.calibration), baseAt: point => { const p = grid.toXY(point); return grid.lightAt(p.x, p.y); } });
        job = { id: uid('lighting-run-op'), entity: 'run', recordId: uid('lighting-run'), actor: author, at: Date.now(), expectedRevision: 0, data }; review.historyJob = job;
      }
      if (scope !== generation || actor() !== author || job.actor !== author) C.fail('계정이 바뀌어 이전 검토의 저장을 중단했어요.', 'account-changed');
      const result = await root.DGOffline.submit('lighting-workflow', job, { id: job.id, summary: '밝기 검토 이력 · ' + time(review.at) });
      review.historyState = result.state === 'synced' ? 'synced' : ['failed', 'conflict'].includes(result.state) ? 'failed' : 'queued';
      review.historyError = result.error || ''; review.runId = job.recordId; state.runsLoaded = false;
    } catch (error) { review.historyState = 'failed'; review.historyError = errorText(error); }
    if (api.lightingReview() === review) api.render();
  }
  function comparisonHTML(run) {
    const e = JSON.parse(run.evaluationJson), n = e.counts;
    return '<p>비교 가능한 관찰 ' + n.compared + '건 · 조건 불충족·충돌 ' + e.excluded.length + '건</p><div class="dg-table"><table><thead><tr><th>비교 항목</th><th>대장 모델</th><th>외부 광원 반영</th></tr></thead><tbody><tr><td>관찰과 일치</td><td>' + n.baseMatched + '</td><td>' + n.adjustedMatched + '</td></tr><tr><td>모델은 기준 이상·현장은 어두움</td><td>' + n.baseMissedDark + '</td><td>' + n.adjustedMissedDark + '</td></tr><tr><td>모델은 부족·현장은 밝음/보통</td><td>' + n.baseWeakButBright + '</td><td>' + n.adjustedWeakButBright + '</td></tr></tbody></table></div><p class="muted">선택 시간에 유효한 관찰 지점을 비교한 결과예요. 독립된 현장 표본의 정확도나 조도 기준 충족률은 아니며 계수를 자동 변경하지 않아요.</p>';
  }
  function historyView() {
    if (!state.runsLoaded && !state.runsError && !historyLoading) queueMicrotask(loadHistory);
    return '<div id="lwHistory"><div class="panel"><h3>검토 실행 이력·관찰 비교</h3><p>당시 전체 후보, 적용 시간, 모델 설정, 대장·보완 기록 버전과 자료 지문을 보관해요. 이력은 수정하지 않으며 새 검토를 별도 기록해요.</p><p class="muted">한 실행 600KB 이하. 자료 버전·후보 JSON 각 300,000자, 관찰 비교 180,000자, 설정 12,000자 이내예요. 초과한 실행은 오류를 표시하고 일부만 보관하지 않아요. 자료 지문은 자료의 동일성을 확인하며 원본 자료 전체를 대신 보관하지는 않아요.</p><div class="split"><button class="btn ghost" data-lw="history-refresh">전체 새로고침</button><button class="btn ghost" data-lw="history-export"' + (!state.runsLoaded || state.runsError ? ' disabled' : '') + '>전체 실행 JSON</button></div>' + (state.runsError ? '<p class="notice">전체 이력을 읽지 못했어요: ' + E(state.runsError) + '</p>' : '<p class="muted">전체 ' + state.runs.length + '회 · 화면 ' + Math.min(state.runShow, state.runs.length) + '회</p>') + '</div>' +
      state.runs.slice(0, state.runShow).map(r => '<div class="panel"><b>' + E(time(r.reviewedAt)) + '</b><p>' + E(r.dong || '전체') + ' · ' + E(minuteText(r.minute)) + ' KST · 후보 ' + r.candidateCount + '개 · ' + Math.ceil(r.payloadBytes / 1024) + 'KB</p><p class="muted">' + E(r.modelVersion) + ' · 대장 ' + r.registryCount + ' / 보완 ' + r.contextCount + '건</p>' + comparisonHTML(r) + '<div class="split"><button class="btn ghost sm" data-lw="run-open" data-id="' + E(r.id) + '">전체 근거 보기</button><button class="btn ghost sm" data-lw="run-export" data-id="' + E(r.id) + '">이 실행 JSON</button><button class="btn ghost sm" data-lw="run-evaluation-csv" data-id="' + E(r.id) + '">관찰 비교 전체 CSV</button></div></div>').join('') + (state.runs.length > state.runShow ? '<button class="btn ghost block" data-lw="history-more">더 보기</button>' : '') + (!state.runs.length && state.runsLoaded ? '<p class="empty">보관한 실행이 없어요. 밝기 검토를 실행하면 조건과 결과를 보관해요.</p>' : '') + '</div>';
  }
  function openRun(id) {
    const r = state.runs.find(x => x.id === id); if (!r) C.fail('이력을 새로 읽어 주세요.');
    const candidates = JSON.parse(r.candidatesJson), e = JSON.parse(r.evaluationJson);
    api.navigate(heading('보관한 밝기 검토') + '<div class="panel"><b>' + E(time(r.reviewedAt)) + '</b><p>' + E(r.modelVersion) + ' · ' + E(minuteText(r.minute)) + ' KST</p><p class="muted" style="overflow-wrap:anywhere">자료 지문 ' + E(r.inputDigest) + '</p>' + comparisonHTML(r) + '<button class="btn ghost" data-lw="run-export" data-id="' + E(id) + '">전체 결과·입력 버전 JSON</button><h4>후보 ' + candidates.length + '개</h4>' + candidates.slice(0, 100).map(c => '<p>' + E(c.title) + ' · ' + E(root.DGLighting.classification(c.classification)) + ' · ' + c.base.toFixed(2) + ' → ' + c.adjusted.toFixed(2) + '</p>').join('') + (candidates.length > 100 ? '<p class="muted">화면은 100개까지 표시해요. 위 JSON에는 전체 ' + candidates.length + '개가 포함돼요.</p>' : '') + '<h4>비교에서 제외한 관찰 ' + e.excluded.length + '건</h4>' + e.excluded.slice(0, 100).map(x => '<p>' + E(x.label) + ' · ' + E(x.reason === 'conflict' ? '현장 관찰 충돌' : x.reason === 'unknown_observation' ? '밝기 판단 보류' : root.DGLighting.reason(x.reason)) + '</p>').join('') + (e.excluded.length > 100 ? '<p>나머지 사유는 전체 JSON에서 확인해 주세요.</p>' : '') + '</div>', { key: 'lwrun:' + id, reopen: () => openRun(id) });
  }
  async function exportJSON(filename, value) { return api.download({ filename: filename + '.json', data: JSON.stringify(value, null, 2) }); }
  async function exportCSV(filename, rows) {
    const cell = value => '"' + String(value == null ? '' : value).replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
    return api.download({ filename: filename + '.csv', data: '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n') });
  }
  function importView() {
    const s = state.import, p = s.preview, fields = { sourceRecordId: '기관 시설 ID *', label: '이름 *', lat: '위도 *', lng: '경도 *', operator: '운영 주체', radius: '반경', sourceUpdatedAt: '원본 갱신일' };
    return '<div id="lwImport" class="panel"><h3>타기관 조명 CSV·GeoJSON 반입</h3><p>새 기록만 추가해요. 같은 기관 시설 ID의 기존 기록과 현장 수정은 덮어쓰지 않아요. 반입 자료는 야간·점등·시간 미확인 상태로 저장하므로 확인 전에는 밝기 수치에 더하지 않아요.</p>' + (!api.can('admin') ? '<p class="notice">자료 반입에는 관리자 권한이 필요해요.</p>' : '<label class="f" for="lwImportFile">UTF-8 CSV 또는 Point GeoJSON · 최대 5MB / 5,000행</label><input class="f-in" type="file" id="lwImportFile" accept=".csv,.geojson,.json"' + (s.busy ? ' disabled' : '') + '><p>' + E(s.name) + '</p><label class="f" for="lwImportAgency">원본 관리기관</label><input class="f-in" id="lwImportAgency" maxlength="100" value="' + E(s.agency) + '"' + (s.busy ? ' disabled' : '') + '><label class="f" for="lwImportDataset">자료 출처·파일 버전</label><input class="f-in" id="lwImportDataset" maxlength="300" value="' + E(s.dataset) + '"' + (s.busy ? ' disabled' : '') + '>' + (s.parsed ? '<h4>열 연결 · ' + s.parsed.rows.length + '행</h4><div class="grid2">' + Object.entries(fields).map(([key, label]) => '<div><label class="f" for="lwMap-' + key + '">' + label + '</label><select class="f-in" id="lwMap-' + key + '" data-lw-map="' + key + '"' + (s.busy ? ' disabled' : '') + '><option value="">연결 안 함</option>' + s.parsed.headers.map(h => '<option value="' + E(h) + '"' + (s.mapping[key] === h ? ' selected' : '') + '>' + E(h) + '</option>').join('') + '</select></div>').join('') + '</div><button class="btn" data-lw="import-preview"' + (s.busy ? ' disabled' : '') + '>검증·반입 미리보기</button>' : '') +
      '<p id="lwImportProgress" class="notice" role="status">' + E(s.progress) + '</p>' + (p ? '<div id="lwImportPreview"><h4>반입 전 검토</h4><p>전체 ' + p.total + '행 · 신규 ' + p.counts.new + ' / 기존 보존 ' + p.counts.protected + ' / 중복 ' + p.counts.duplicate + ' / 오류 ' + p.counts.invalid + '</p><div class="split"><button class="btn" data-lw="import-apply"' + (s.busy || !p.counts.new ? ' disabled' : '') + '>검증된 신규 기록 반입</button><button class="btn ghost" data-lw="import-csv">전체 검토·처리 결과 CSV</button></div>' + p.rows.slice(0, s.show).map(r => '<p><b>' + r.row + '행 · ' + E(r.label || r.sourceId) + '</b> · ' + E({ new: '신규', protected: '기존 보존', duplicate: '파일 중복', invalid: '입력 오류' }[r.status]) + (r.result ? ' · ' + E(r.result) : '') + '<br>' + E(r.error || r.message) + '</p>').join('') + (p.rows.length > s.show ? '<button class="btn ghost block" data-lw="import-more">더 보기 · CSV에는 전체 포함</button>' : '') + '</div>' : '')) + '</div>';
  }
  function readImport() { const s = state.import; if (Q('#lwImportAgency')) s.agency = Q('#lwImportAgency').value; if (Q('#lwImportDataset')) s.dataset = Q('#lwImportDataset').value; for (const key of Object.keys(s.mapping)) if (Q('#lwMap-' + key)) s.mapping[key] = Q('#lwMap-' + key).value; }
  async function selectImport(file) {
    if (!file) return; if (state.import.busy) return;
    const s = state.import, version = s.fileVersion = (s.fileVersion || 0) + 1; s.preview = null; s.parsed = null; s.name = file.name; s.progress = '';
    if (file.size > C.IMPORT_BYTES) C.fail('파일은 5MB 이내로 나눠 주세요.');
    const contents = await file.text(); if (state.import !== s || version !== s.fileVersion) return;
    s.parsed = C.parseImport(contents, file.name); if (!s.dataset) s.dataset = file.name;
    const aliases = { sourceRecordId: ['sourceRecordId', 'facility_id', 'id', '시설ID', '시설번호', '관리번호'], label: ['label', 'name', '시설명', '이름', '광원명'], lat: ['lat', 'latitude', '위도'], lng: ['lng', 'lon', 'longitude', '경도'], operator: ['operator', '관리기관', '운영주체'], radius: ['radius', '반경'], sourceUpdatedAt: ['sourceUpdatedAt', 'updated_at', '갱신일', '기준일'] };
    s.mapping = Object.fromEntries(Object.entries(aliases).map(([key, values]) => [key, s.parsed.headers.find(h => values.includes(h)) || ''])); notify();
  }
  async function previewImport() {
    const s = state.import; if (s.busy || !s.parsed || !api.can('admin')) return;
    readImport(); s.busy = true; s.preview = null; s.progress = '전체 기존 자료와 입력 행을 확인하는 중…'; notify();
    try {
      const existing = await api.readAll('lightingContext', { requireServer: !!api.firebase() });
      s.preview = await C.previewImport(s.parsed, s.mapping, { now: Date.now(), agency: s.agency, dataset: s.dataset, batchId: uid('lighting-import'), existing, registry: api.state().lights, yield: () => new Promise(resolve => setTimeout(resolve, 0)) });
      s.preview.actor = actor(); s.progress = '검토가 끝났어요. 오류·중복·기존 보존 행은 반입하지 않아요.';
    } catch (error) { s.progress = errorText(error); }
    finally { s.busy = false; notify(); }
  }
  async function applyImport() {
    const s = state.import, p = s.preview; if (!p || s.busy || !api.can('admin') || !supported()) return;
    if (p.actor !== actor()) C.fail('계정이 바뀌었어요. 자료를 다시 검토해 주세요.', 'account-changed');
    const rows = p.rows.filter(r => r.status === 'new' && !['저장 완료', '전송 대기'].includes(r.result));
    if (!rows.length) return;
    s.busy = true; let synced = 0, queued = 0, failed = 0, stopped = 0; notify();
    try {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (actor() !== p.actor || !api.can('admin')) { stopped = rows.length - i; break; }
        try {
          row.jobId ||= 'lighting-import-op-' + await C.digest({ batchId: p.batchId, recordId: row.recordId });
          const job = { id: row.jobId, recordId: row.recordId, actor: p.actor, at: p.at, expectedRevision: 0, data: row.data, importSource: true };
          const result = await root.DGOffline.submit('lighting', job, { id: job.id, summary: '기관 반입 · ' + row.label, retry: true });
          row.result = result.state === 'synced' ? '저장 완료' : ['failed', 'conflict'].includes(result.state) ? '실패·확인 필요' : '전송 대기'; row.error = result.error || '';
          if (row.result === '저장 완료') synced++; else if (row.result === '전송 대기') queued++; else failed++;
        } catch (error) { row.result = '실패·확인 필요'; row.error = errorText(error); failed++; }
        s.progress = (i + 1) + '/' + rows.length + '행 처리 · 저장 ' + synced + ' / 전송 대기 ' + queued + ' / 실패 ' + failed; if (Q('#lwImportProgress')) Q('#lwImportProgress').textContent = s.progress;
        if (i % 20 === 19) await new Promise(resolve => setTimeout(resolve, 0));
      }
      s.progress = '이번 처리: 저장 완료 ' + synced + ' / 전송 대기 ' + queued + ' / 실패 ' + failed + ' / 미처리 ' + stopped + '행. 각 행과 저장 대기함에서 결과를 확인하세요.';
      await root.DGLighting.load();
    } finally { s.busy = false; notify(); }
  }
  function openSection(action) { api.navigate(heading(action === 'tasks' ? '재확인 업무' : action === 'history' ? '검토 이력' : '기관 자료 반입') + (action === 'tasks' ? tasksView() : action === 'history' ? historyView() : importView()), { key: 'lw:' + action, reopen: () => openSection(action) }); }
  async function handle(button) {
    const action = button.dataset.lw;
    if (['tasks', 'history', 'import'].includes(action)) { await persistDraft(); openSection(action); return; }
    // tasks / history / import are screens of their own; keep them reopenable for back navigation
    if (action === 'tasks-refresh') return loadTasks(); if (action === 'history-refresh') return loadHistory();
    if (action === 'tasks-more') { state.taskShow += 40; return notify(); } if (action === 'history-more') { state.runShow += 30; return notify(); }
    if (action === 'task-new') return openTask(); if (action === 'task-open') return openTask(null, button.dataset.id); if (action === 'task-resume') return openTask(null, button.dataset.id, true);
    if (action === 'candidate-task') return candidateTask(button.dataset.candidate); if (action === 'record-task') return recordTask(button.dataset.recordId);
    if (action === 'task-complete') return saveTask('completed'); if (action === 'task-cancel' && confirm('재확인 업무를 취소할까요?')) return saveTask('cancelled');
    if (action === 'task-reopen') return reopenTask(button.dataset.id);
    if (action === 'task-discard' && confirm('작성 중인 재확인 초안을 버릴까요?')) { const id = state.draft.recordId; await discardDraft(id); api.closeSheet(); return; }
    if (action === 'task-reload-draft') {
      if (!confirm('현재 창의 저장되지 않은 입력 대신 다른 탭이 저장한 최신 초안을 열까요?')) return;
      const id = state.draft.recordId; await taskWrites.catch(() => {}); const saved = await root.DGOffline.get('lightingTaskDraft', id); state.draft = saved;
      if (saved) { delete saved.conflict; renderTask(); } else { await loadTasks(); if (state.tasks.some(t => t.id === id)) await openTask(null, id); else api.closeSheet(); } return;
    }
    if (action === 'task-copy-draft') {
      const previous = readTaskForm(); if (!previous) return; const data = { ...copy(previous.data), assignedTo: actor(), originKind: 'manual', originId: '', status: 'open', observationId: '', completionNote: '', completedAt: 0, completedBy: '' };
      await taskWrites.catch(() => {}); state.draft = { recordId: uid('lighting-task'), data, expectedRevision: 0, readonly: false, pending: null, draftRevision: null }; await persistDraft(false); renderTask(); return;
    }
    if (action === 'task-observe') { const task = state.tasks.find(t => t.id === button.dataset.id); if (!task) C.fail('업무를 다시 읽어 주세요.'); await persistDraft(); return root.DGLighting.openObservation({ lat: task.lat, lng: task.lng, radius: Math.min(30, task.radius), label: task.title.slice(0, 100), observedAt: Date.now(), note: '재확인 업무: ' + task.title, originKind: 'task', originId: task.id, originPointId: '', positionAccuracy: 0 }); }
    if (action === 'run-save') return captureReview(api.lightingReview()); if (action === 'run-open') return openRun(button.dataset.id);
    if (action === 'run-export') { const run = state.runs.find(r => r.id === button.dataset.id); if (!run) C.fail('이력을 다시 읽어 주세요.'); return exportJSON('동구_밝기검토_' + run.id, run); }
    if (action === 'history-export') { await loadHistory(); if (!state.runsLoaded || state.runsError) C.fail('전체 이력 조회를 마친 뒤 내보내 주세요.'); return exportJSON('동구_밝기검토_전체', { exportedAt: Date.now(), count: state.runs.length, runs: state.runs }); }
    if (action === 'tasks-csv') { await loadTasks(); if (!state.tasksLoaded || state.tasksError) C.fail('전체 업무 조회를 마친 뒤 내보내 주세요.'); return exportCSV('동구_밝기재확인_전체', [['ID', '제목', '상태', '담당자', '기한KST', '확인시각KST', '위도', '경도', '원본종류', '원본ID', '관찰ID', '확인결과'], ...state.tasks.map(t => [t.id, t.title, statusLabel[t.status], names()[t.assignedTo] || t.assignedTo, time(t.dueAt), minuteText(t.reviewMinute), t.lat, t.lng, t.originKind, t.originId, t.observationId, t.completionNote])]); }
    if (action === 'run-evaluation-csv') { const run = state.runs.find(r => r.id === button.dataset.id); if (!run) C.fail('이력을 다시 읽어 주세요.'); const e = JSON.parse(run.evaluationJson); return exportCSV('동구_밝기관찰비교_' + run.id, [['관찰ID', '이름', '실제관찰', '대장지수', '외부반영지수', '대장일치', '외부반영일치', '제외사유'], ...e.rows.map(r => [r.id, r.label, root.DGLighting.levels[r.level], r.base, r.adjusted, r.baseMatch, r.adjustedMatch, '']), ...e.excluded.map(r => [r.id, r.label, '', '', '', '', '', r.reason])]); }
    if (action === 'import-preview') return previewImport(); if (action === 'import-apply') return applyImport();
    if (action === 'import-more') { state.import.show += 50; return notify(); }
    if (action === 'import-csv') { const p = state.import.preview; if (!p) return; return exportCSV('동구_기관조명반입_' + p.batchId, [['원본행', '기관', '기관시설ID', '이름', '검토구분', '처리결과', '확인내용'], ...p.rows.map(r => [r.row, p.agency, r.sourceId, r.label, r.status, r.result || '미처리', r.error || r.message])]); }
  }
  async function ready() {
    generation++; taskEditorSequence++; taskSettlements.clear(); taskSaveViews.clear(); appliedTaskOperations.clear(); taskLoading = null; historyLoading = null; state.tasksLoaded = false; state.tasksError = ''; state.runsLoaded = false; state.runsError = ''; state.runs = []; state.tasks = []; state.draft = null;
    state.import = { parsed: null, name: '', agency: '', dataset: '', mapping: {}, preview: null, busy: false, progress: '', show: 50 };
    const jobs = new Map((await root.DGOffline.jobs()).map(j => [j.id, j]));
    for (const entry of await root.DGOffline.list('lightingTaskDraft')) {
      const draft = entry.value; if (!draft?.pending) continue;
      const job = jobs.get(draft.pending);
      if (job?.state === 'synced') await clearTaskDraft(draft);
      else if (!job && root.DGOffline.putIfCurrent) { draft.pending = null; await root.DGOffline.putIfCurrent('lightingTaskDraft', draft.recordId, draft, draft.draftRevision ?? 0); }
    }
    state.draft = (await root.DGOffline.list('lightingTaskDraft')).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.value || null;
    if (unsubscribe) unsubscribe();
    if (api.state().me === 'local' || api.firebase()) { try { unsubscribe = api.database().collection('lightingTasks').onSnapshot(() => { if (state.tasksLoaded || Q('#lwTasks')) loadTasks(); }, error => { state.tasksError = errorText(error); notify(); }); } catch (_) {} }
  }
  function attach(contextApi) {
    api = contextApi;
    root.DGOffline.register('lighting-workflow', job => Commands.execute(job, { db: api.database(), fb: api.firebase(), user: actor(), admin: api.can('admin') }));
    if (attached) return; attached = true;
    document.addEventListener('click', event => { const button = event.target.closest('[data-lw]'); if (button) Promise.resolve().then(() => handle(button)).catch(error => api.toast(errorText(error))); });
    document.addEventListener('submit', event => { if (event.target.id === 'lwTaskForm') { event.preventDefault(); saveTask().catch(error => api.toast(errorText(error))); } });
    for (const type of ['input', 'change']) document.addEventListener(type, event => { if (event.target.closest('#lwTaskForm')) persistDraft().catch(error => api.toast(errorText(error))); });
    document.addEventListener('change', event => {
      const target = event.target;
      if (target.id === 'lwTaskFilter') { state.taskFilter = target.value; state.taskShow = 40; notify(); }
      if (target.id === 'lwImportFile') selectImport(target.files?.[0]).catch(error => { state.import.progress = errorText(error); notify(); });
      if (target.id === 'lwImportAgency' || target.id === 'lwImportDataset' || target.dataset.lwMap) {
        readImport(); state.import.preview = null; state.import.progress = '조건이 바뀌었어요. 반입 전 미리보기를 다시 실행해 주세요.';
        // Keep the focused input and preview button alive through blur/click dispatch.
        Q('#lwImportPreview')?.remove(); const progress = Q('#lwImportProgress'); if (progress) progress.textContent = state.import.progress;
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistDraft().catch(() => {}); });
    root.DGOffline.subscribe(event => {
      if (event.job?.kind !== 'lighting-workflow') return;
      if (event.type === 'synced') {
        if (event.job.payload?.entity === 'task') settleTask(event.job).catch(error => api.toast(errorText(error)));
        if (event.job.payload?.entity === 'run') { const review = api.lightingReview(); if (review?.historyJob?.id === event.job.id) { review.historyState = 'synced'; review.historyError = ''; } state.runsLoaded = false; }
        loadTasks();
      }
      if (event.type === 'discarded' && event.job.payload?.entity === 'task') {
        const id = event.job.payload.recordId;
        taskWrites = taskWrites.catch(() => {}).then(async () => { const saved = await root.DGOffline.get('lightingTaskDraft', id); if (saved?.pending === event.job.id) { saved.pending = null; const next = await root.DGOffline.putIfCurrent('lightingTaskDraft', id, saved, saved.draftRevision ?? 0); if (state.draft?.recordId === id && state.draft.pending === event.job.id) { Object.assign(state.draft, next); if (Q('#lwTaskForm')?.dataset.recordId === id && Q('#sheet.open')) renderTask(); } } }).catch(error => api.toast(errorText(error)));
      }
    });
  }
  root.DGLightingWorkflows = { attach, ready, state, loadTasks, loadHistory, tasksView, historyView, importView, openTask, discardDraft, persistDraft, persistActive: persistDraft, hasActiveDraft: () => draftWriteCount > 0 || !!(Q('#lwTaskForm') && state.draft && !state.draft.readonly), captureReview, reviewHistoryStatus };
})(globalThis);
