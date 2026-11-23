/* The legacy field UI is connected here; business commands stay in independent modules. */
(function (root) {
  'use strict';
  /* in-app confirmation when app/dialog.js is present; the plain confirm() keeps bare test sandboxes working */
  const ask = (message, opts) => root.DGDialog ? root.DGDialog.confirm(message, opts) : Promise.resolve(confirm(message));
  let api, attached = false, initialized = false, timer = null, patrolTimer = null, memoryPending = false, autosaveError = '', patrolKey = '', draftWrite = Promise.resolve(), resolveReady, operationsUnsubscribe, suspended = false, readyRun = 0;
  const readyPromise = new Promise(resolve => { resolveReady = resolve; });
  const finishing = new Map(), busy = new Set(), draftBaselines = new WeakMap(), settledDrafts = new WeakMap(), discardedDrafts = new WeakMap();
  const Q = s => document.querySelector(s), copy = v => JSON.parse(JSON.stringify(v));
  const captureOwner = () => ({ context: api, actor: api.state().me, database: api.database(), firebase: api.firebase(), offline: root.DGOffline, namespace: root.DGOffline.namespace });
  const ownsContext = owner => !suspended && owner && owner.context === api && owner.actor === api.state().me && owner.database === api.database() && owner.firebase === api.firebase() && owner.offline === root.DGOffline;
  const ownsOwner = owner => ownsContext(owner) && owner.offline.ready && owner.namespace === owner.offline.namespace;
  const canInspect = () => api.can('inspect') && api.state().canWrite;
  function warn(error) { const message = error && error.message || '초안을 보관하지 못했어요. 저장 공간을 확인해 주세요.'; if (message !== autosaveError) api.toast(message); autosaveError = message; }
  function syncMemo(d) { const m = Q('#iMemo'); if (d && api.activeDraft() === d && m) d.memo = m.value; if (typeof root.syncInspectionEvidence === 'function') root.syncInspectionEvidence(d); return d; }
  const revision = value => value ? value.draftRevision || 0 : null;
  const draftContent = value => value ? JSON.stringify([api.inspectionDraftKey(value), value.memo || '', value.__saveJob?.id || null]) : null;
  const hasDraftInput = d => !!(api.draftDirty(d) || d?.__saveJob);
  function writeInspectionDraft(owner, id, value, previous) {
    if (value) return owner.offline.putIfCurrent('draft', id, value, revision(previous), previous);
    return owner.offline.removeIfCurrent('draft', id, revision(previous), previous).then(() => null);
  }
  function queueDraftWrite(write) {
    draftWrite = draftWrite.catch(() => {}).then(write);
    return draftWrite;
  }
  function persistDraft() {
    if (suspended || !root.DGOffline.ready) return Promise.resolve();
    const owner = captureOwner();
    const d = syncMemo(api.activeDraft());
    if (!d || !d.lightId) return Promise.resolve();
    const id = d.lightId, dirty = hasDraftInput(d), value = dirty ? copy(d) : null;
    if (dirty) api.drafts()[id] = d; else delete api.drafts()[id];
    memoryPending = memoryPending || dirty;
    return queueDraftWrite(async () => {
      if (!ownsOwner(owner)) return false;
      // A snapshot captured during cleanup must not recreate the retired draft or job.
      if (discardedDrafts.has(d) && draftContent(value) === discardedDrafts.get(d)) return true;
      const settled = settledDrafts.get(d);
      if (settled && value?.__saveJob?.id === settled.id) {
        delete value.__saveJob;
        if (draftContent(value) === settled.removedContent) return true;
      }
      const previous = draftBaselines.get(d) || null;
      // An untouched view has no input to write over a newer tab's draft.
      if (draftContent(value) === draftContent(previous)) return true;
      const status = () => api.activeDraft() === d ? Q('#dgDraftState') : null;
      try {
        const saved = await writeInspectionDraft(owner, id, value, previous);
        if (!ownsOwner(owner)) return false;
        draftBaselines.set(d, saved);
        autosaveError = '';
        const note = status();
        if (note) note.textContent = value ? owner.offline.durable ? '이 기기에 초안을 보관했어요.' : '현재 창에 초안을 보관했어요. 창을 닫으면 지워져요.' : '';
        return true;
      } catch (error) {
        if (!ownsOwner(owner)) return false;
        if (error?.code === 'conflict') error.message = '다른 탭에서 이 점검 초안을 변경했어요. 화면의 입력은 남아 있으니 창을 닫기 전에 두 탭의 내용을 확인해 주세요.';
        const note = status();
        if (note) note.textContent = error?.code === 'conflict' ? error.message : '최신 초안을 보관하지 못했어요. 저장 공간을 확인해 주세요.';
        throw error;
      }
    });
  }
  function discardInspectionDraft(id, displayed) {
    const owner = captureOwner(), active = syncMemo(api.activeDraft());
    const d = active?.lightId === id ? active : api.drafts()[id], input = draftContent(d);
    return queueDraftWrite(async () => {
      if (!ownsOwner(owner)) return;
      const baseline = draftBaselines.get(d) || null, previous = displayed ?? baseline;
      if (previous) await writeInspectionDraft(owner, id, null, previous);
      if (!ownsOwner(owner) || !d || revision(baseline) !== revision(previous) || draftContent(baseline) !== draftContent(previous)) return;
      draftBaselines.set(d, null);
      discardedDrafts.set(d, input);
      if (draftContent(syncMemo(d)) !== input) return;
      if (api.drafts()[id] === d) delete api.drafts()[id];
      if (api.activeDraft() === d) { api.setDraft(null); api.closeSheet(); }
    });
  }
  async function restoreInspectionDraft(id) {
    const owner = captureOwner(), generation = api.navGen?.();
    const current = () => ownsOwner(owner) && canInspect() && (generation == null || api.navAlive(generation));
    if (!current()) return;
    await draftWrite.catch(() => {});
    if (!current()) return;
    const saved = await owner.offline.get('draft', id);
    if (!current()) return;
    const active = syncMemo(api.activeDraft()), local = active?.lightId === id ? active : api.drafts()[id];
    const content = draftContent(local);
    if (hasDraftInput(local) && content !== draftContent(draftBaselines.get(local)) && content !== draftContent(saved)) {
      api.toast('이 창의 최신 입력을 먼저 열었어요. 다른 탭에 저장된 초안도 저장 대기함에 남아 있어요.');
      return api.openLight(id);
    }
    if (active?.lightId === id) api.setDraft(null);
    if (!saved || saved.lightId !== id) {
      delete api.drafts()[id];
      api.toast('이어 쓸 점검 초안이 없어요. 저장 대기함을 새로 확인해 주세요.');
      return;
    }
    const draft = copy(saved);
    draftBaselines.set(draft, saved);
    api.drafts()[id] = draft;
    return api.openLight(id);
  }
  function unpreservedInspectionDrafts(stored) {
    if (suspended) return [];
    const active = syncMemo(api.activeDraft()), entries = new Map(stored.map(row => [row.id, row.value])), drafts = new Map(Object.entries(api.drafts()));
    if (active?.lightId) drafts.set(active.lightId, active);
    return [...drafts].filter(([id, d]) => {
      if (!hasDraftInput(d)) return false;
      if (!root.DGOffline.durable) return true;
      const content = draftContent(d);
      return content !== draftContent(draftBaselines.get(d)) && content !== draftContent(entries.get(id));
    }).map(([id]) => id);
  }
  function scheduleDraft() { if (suspended) return; clearTimeout(timer); timer = setTimeout(() => persistDraft().catch(warn), 160); }
  function patrolSnapshot() {
    const p = api.patrol(); if (!p.sessionId || !(p.track.length || p.marks.length || p.spots.length || p.passed.size || (p.targets || []).length)) return null;
    return { sessionId: p.sessionId, start: p.start, end: p.end || null, dong: p.dong, total: p.total, track: copy(p.track), passed: [...p.passed], marks: copy(p.marks), spots: copy(p.spots), undo: copy(p.undo || []), dist: p.dist, pos: p.pos && copy(p.pos), last: p.last && copy(p.last), heading: p.heading, savedPart: p.savedPart ? copy(p.savedPart) : null, targets: copy(p.targets || []), planId: p.planId || '', paused: true };
  }
  async function persistPatrol(owner = captureOwner()) {
    if (!ownsOwner(owner) || !canInspect()) return;
    const snapshot = patrolSnapshot(); if (!snapshot) return;
    const key = JSON.stringify(snapshot); if (key === patrolKey) return;
    await owner.offline.put('patrol', 'current', snapshot);
    if (ownsOwner(owner) && canInspect()) { patrolKey = key; memoryPending = true; }
  }
  async function restorePatrol() {
    const owner = captureOwner();
    if (!ownsOwner(owner) || !canInspect()) return;
    const saved = await owner.offline.get('patrol', 'current');
    if (!ownsOwner(owner) || !canInspect()) return;
    if (!saved) return api.toast('복구할 순찰 초안이 없어요.');
    const current = api.patrol();
    if (current.on && patrolSnapshot() && !await ask('현재 순찰을 기기에 보관한 초안으로 바꿀까요?', { ok: '초안으로 바꾸기', cancel: '현재 순찰 유지' })) return;
    if (!ownsOwner(owner) || !canInspect()) return;
    api.resumePatrol(saved); api.toast('이전 순찰을 불러왔어요. 이동 기록은 정지 상태로 시작해요.');
  }
  async function settleInspection(job, delivered, owner = captureOwner()) {
    const current = () => ownsOwner(owner) && (!Object.hasOwn(job.rec, 'inspector') || job.rec.inspector === owner.actor);
    if (!current()) return;
    if (finishing.has(job.id)) return finishing.get(job.id);
    const pending = queueDraftWrite(async () => {
      if (!current()) return;
      const id = job.rec.lightId, stored = await owner.offline.get('draft', id);
      if (!current()) return;
      const active = syncMemo(api.activeDraft()), local = active?.lightId === id ? active : api.drafts()[id];
      const localMatches = local?.__saveJob?.id === job.id;
      if (stored?.__saveJob?.id !== job.id) {
        if (localMatches) {
          delete local.__saveJob;
          settledDrafts.set(local, { id: job.id });
        }
        return;
      }
      const previous = localMatches && draftBaselines.get(local);
      // Keep an edit made while sending only when this view still owns the saved baseline.
      const localIsCurrent = !!previous && revision(previous) === revision(stored) && draftContent(previous) === draftContent(stored);
      const value = copy(localIsCurrent ? local : stored);
      delete value.__saveJob;
      const saved = await writeInspectionDraft(owner, id, delivered && api.inspectionDraftKey(value) === job.key ? null : value, stored);
      if (!current()) return;
      if (localMatches && local.__saveJob?.id === job.id) {
        delete local.__saveJob;
        settledDrafts.set(local, { id: job.id, removedContent: localIsCurrent && !saved ? draftContent(value) : undefined });
        if (localIsCurrent) {
          draftBaselines.set(local, saved);
          if (!saved && draftContent(local) === draftContent(value)) {
            if (api.drafts()[id] === local) delete api.drafts()[id];
            if (api.activeDraft() === local) { api.setDraft(null); api.closeSheet(); }
          }
        }
      }
      api.render(); await root.DGOperations.refreshQueue();
    });
    finishing.set(job.id, pending); try { await pending; } finally { finishing.delete(job.id); }
  }
  async function saveInspection() {
    const owner = captureOwner();
    const source = syncMemo(api.activeDraft()); if (!source) return;
    const light = api.byId(source.lightId); if (!light) return;
    const generation = api.navGen?.(), lightKey = JSON.stringify([light.id, light.code, light.dong, !!light.removed]);
    const permitted = () => ownsOwner(owner) && canInspect();
    const formCurrent = () => {
      if (!permitted() || api.activeDraft() !== source || source.lightId !== light.id || generation != null && !(api.navAlive ? api.navAlive(generation) : api.navGen?.() === generation)) return false;
      const latest = api.byId(light.id);
      return !!latest && !latest.removed && JSON.stringify([latest.id, latest.code, latest.dong, !!latest.removed]) === lightKey;
    };
    if (suspended || !canInspect()) return api.toast('점검 저장 권한을 확인해 주세요.');
    if (!root.DGOffline.ready) return api.toast('저장 대기함을 준비하는 중이에요. 잠시 뒤 다시 저장해 주세요.');
    if (busy.has(light.id)) return api.toast('이 시설의 저장 요청을 처리하는 중이에요.');
    let job = source.__saveJob;
    if (!job) {
      const missing = api.checks().filter(([key]) => !source.checks[key]);
      if (missing.length && !await ask('점검표 ' + missing.length + '개 항목이 비어 있어요. 미실시로 남기며 정식 점검일은 갱신하지 않아요. 메모에 미실시 사유를 적어 주세요.', { ok: '미실시로 기록하고 저장', cancel: '돌아가기' })) return;
      if (!formCurrent()) return;
      for (const [key] of missing) source.checks[key] = 'uninspected';
      if (!source.result) api.suggestResult();
      if (!source.result) return api.toast('점검 결과를 선택해 주세요.');
      try { job = api.newInspectionJob(light, source); source.__saveJob = job; } catch (error) { warn(error); return; }
    }
    if (!formCurrent() || Object.hasOwn(job.rec, 'inspector') && job.rec.inspector !== owner.actor) return;
    const button = Q('#saveInsp'); if (button) { button.disabled = true; button.textContent = '저장 확인 중…'; }
    busy.add(light.id); api.drafts()[light.id] = source;
    try {
      if (await persistDraft() === false || !permitted()) return;
      const result = await owner.offline.submit('inspection', job, { id: job.id, summary: '점검 · ' + light.code, retry: true });
      if (!ownsOwner(owner)) return;
      if (result.state === 'synced') { await settleInspection(job, true, owner); if (ownsOwner(owner)) api.toast('점검 결과를 저장했어요.' + (api.drafts()[light.id] ? ' 이후 입력은 점검 화면에서 확인해 주세요.' : '')); }
      else if (['failed', 'conflict'].includes(result.state)) api.toast(result.error + ' 저장 대기함에서 확인해 주세요.');
      else api.toast(root.DGOffline.durable ? '점검을 기기에 보관했어요. 저장 대기함에서 전송 상태를 확인할 수 있어요.' : '전송을 기다리고 있어요. 완료 전에는 이 창을 닫지 마세요.');
    } catch (error) { if (ownsOwner(owner)) warn(error); }
    finally { busy.delete(light.id); const current = Q('#saveInsp'); if (ownsOwner(owner) && api.activeDraft() === source && current) { current.disabled = false; current.textContent = '점검 결과 저장'; } }
  }
  async function savePatrol() {
    const owner = captureOwner(), permitted = () => ownsOwner(owner) && canInspect();
    if (suspended || !canInspect()) return api.toast('순찰 저장 권한을 확인해 주세요.');
    if (!owner.offline.ready) return api.toast('저장 대기함을 준비하는 중이에요.');
    const job = api.preparePatrolJob();
    const button = Q('#ptSave'); if (button) { button.disabled = true; button.textContent = '저장 확인 중…'; }
    try {
      await persistPatrol(owner);
      if (!permitted()) return;
      const result = await owner.offline.submit('patrol', job, { id: job.id, summary: '순찰 · ' + api.fmtDT(job.rec.start), retry: true });
      if (!permitted()) return;
      if (result.state === 'synced') { await finishPatrol(job, owner); if (permitted()) api.toast('순찰 결과를 저장했어요.'); }
      else api.toast(result.error || (owner.offline.durable ? '순찰을 기기에 보관했어요. 저장 대기함에서 이어서 전송해요.' : '전송을 기다리고 있어요. 완료 전에는 창을 닫지 마세요.'));
    } catch (error) { if (permitted()) warn(error); }
    finally { const current = Q('#ptSave'); if (permitted() && current) { current.disabled = false; current.textContent = '순찰 결과 저장'; } }
  }
  async function finishPatrol(job, owner = captureOwner()) {
    const current = () => ownsOwner(owner) && canInspect() && job.rec.by === owner.actor;
    if (!current()) return;
    api.finishPatrolJob(job);
    const saved = await owner.offline.get('patrol', 'current');
    if (!current()) return;
    if (saved && saved.sessionId === job.sessionId && api.patrolKey(saved) === job.key) {
      await owner.offline.remove('patrol', 'current');
      if (!current()) return;
      patrolKey = '';
    }
    await root.DGOperations.refreshQueue();
  }
  async function hasUnsaved() {
    if (suspended) return false;
    if (!root.DGOffline.ready) return hasUnsavedSync();
    const owner = captureOwner();
    const [jobs, ...drafts] = await Promise.all([root.DGOffline.jobs(), ...['draft', 'patrol', 'patrolTargets', 'inventoryDraft', 'workEdit', 'workDraft', 'workCompletion', 'assetDraft', 'preventiveDraft', 'lightingDraft', 'lightingTaskDraft', 'lightingAreaDraft'].map(k => root.DGOffline.list(k))]);
    if (!ownsOwner(owner)) return hasUnsavedSync();
    memoryPending = jobs.some(j => j.state !== 'synced') || drafts.some(values => values.length);
    return memoryPending || hasActiveDraft();
  }
  function hasActiveDraft() { return !!api.draftDirty(syncMemo(api.activeDraft())) || !!patrolSnapshot() || !!root.DGOperations?.hasActiveDraft?.() || !!root.DGAssetMaintenance?.hasActiveDraft?.() || !!root.DGPreventive?.hasActiveDraft?.() || !!root.DGLightingWorkflows?.hasActiveDraft?.() || !!root.DGLightingAreas?.hasActiveDraft?.(); }
  function hasUnsavedSync() { return !suspended && (memoryPending || hasActiveDraft()); }
  function stopActivity() {
    clearTimeout(timer); clearInterval(patrolTimer);
    if (operationsUnsubscribe) operationsUnsubscribe();
    operationsUnsubscribe = null;
  }
  function suspend() {
    suspended = true;
    initialized = false;
    memoryPending = false;
    stopActivity();
    resolveReady(false);
  }
  async function ready() {
    const start = captureOwner(), run = ++readyRun;
    const current = () => run === readyRun && ownsContext(start);
    if (!current()) return;
    try {
      if (!start.actor || !start.database) { initialized = true; resolveReady(false); return; }
      const namespace = (start.firebase ? 'firebase:' + root.FIREBASE_CONFIG.projectId : start.actor === 'local' ? 'local' : 'artifact') + ':' + start.actor;
      const options = { namespace, durable: start.actor === 'local' || root.DG_DEVICE_TRUSTED === true, networkRequired: start.actor !== 'local' };
      try { if (await start.offline.configure(options) === false) return; }
      catch (error) {
        if (!current()) return;
        warn(error);
        if (await start.offline.configure({ ...options, durable: false }) === false) return;
      }
      if (!current()) return;
      const owner = captureOwner(), active = () => current() && ownsOwner(owner);
      const saved = await owner.offline.list('draft');
      if (!active()) return;
      for (const entry of saved) if (entry.value && api.byId(entry.id) && !api.drafts()[entry.id]) {
        const d = copy(entry.value);
        draftBaselines.set(d, entry.value);
        api.drafts()[entry.id] = d;
      }
      const jobs = await owner.offline.jobs();
      if (!active()) return;
      for (const job of jobs) if (job.kind === 'patrol' && job.payload && job.state !== 'synced') api.rememberPatrolJob(job.payload);
      for (const module of [root.DGOperations, root.DGLighting, root.DGAssetMaintenance, root.DGPreventive, root.DGFieldKit]) {
        await module?.ready?.();
        if (!active()) return;
      }
      await hasUnsaved();
      if (!active()) return;
      const hasPatrol = !saved.length && (await owner.offline.list('patrol')).length;
      if (!active()) return;
      initialized = true; resolveReady(true); api.render();
      if (!active()) return;
      if (saved.length || hasPatrol) api.toast('작성하던 내용이 있어요. 저장 대기함에서 이어 쓸 수 있어요.');
      owner.offline.flush().catch(error => { if (active()) warn(error); });
      clearInterval(patrolTimer); patrolTimer = setInterval(() => {
        if (active()) persistPatrol(owner).catch(error => { if (active()) warn(error); });
      }, 2500);
      if (operationsUnsubscribe) operationsUnsubscribe();
      if (start.database.collection && supportedSubscriptions() && root.DGOperations.subscribeUpdates) operationsUnsubscribe = root.DGOperations.subscribeUpdates();
    } catch (error) {
      if (!current()) return;
      resolveReady(false);
      throw error;
    }
  }
  function supportedSubscriptions() { return api.state().me === 'local' || !!api.firebase(); }
  function captureForm(container) {
    const values = [], focus = document.activeElement;
    for (const el of container.querySelectorAll('input,textarea,select,[aria-pressed]')) {
      if (el.type === 'file') continue;
      // visit-plan picks ([data-plan-light]) are state-driven (DGOperations.state.planPick) and are redrawn from it, not restored here
      const key = el.id ? '#' + CSS.escape(el.id) : el.hasAttribute('data-ibissue') ? '[data-ibissue="' + CSS.escape(el.dataset.ibissue) + '"]' : null;
      if (!key) continue;
      values.push({ key, value: el.value, checked: el.checked, pressed: el.getAttribute('aria-pressed'), data: { ...el.dataset }, focused: el === focus, start: el.selectionStart, end: el.selectionEnd });
    }
    return values;
  }
  function restoreForm(container, values) {
    for (const saved of values) {
      const el = container.querySelector(saved.key); if (!el) continue;
      if (saved.value !== undefined) el.value = saved.value;
      if (saved.checked !== undefined) el.checked = saved.checked;
      if (saved.pressed != null) el.setAttribute('aria-pressed', saved.pressed);
      Object.assign(el.dataset, saved.data);
      if (saved.focused) { el.focus({ preventScroll: true }); if (typeof saved.start === 'number' && el.setSelectionRange) try { el.setSelectionRange(saved.start, saved.end); } catch (e) {} }
    }
  }
  function attach(context) {
    api = context; if (attached) return; attached = true;
    root.DGOperations.attach(context); root.DGManagement.attach(context); if (root.DGLighting) root.DGLighting.attach(context);
    root.DGOffline.register('inspection', job => api.commitInspectionJob(job));
    root.DGOffline.register('patrol', job => api.commitPatrolJob(job));
    root.DGOffline.subscribe(event => {
      if (suspended) return;
      if (event.type === 'synced') {
        if (event.job.kind === 'inspection') settleInspection(event.job.payload, true).catch(warn);
        if (event.job.kind === 'patrol') finishPatrol(event.job.payload).catch(warn);
      }
      if (event.type === 'discarded' && event.job?.kind === 'inspection' && event.job.payload) settleInspection(event.job.payload, false).catch(warn);
      if (event.type === 'discarded' && event.job && event.job.kind === 'patrol' && event.job.payload) api.forgetPatrolJob(event.job.payload);
      if (['draft', 'job', 'removed', 'discarded', 'synced', 'cleared'].includes(event.type)) hasUnsaved().catch(() => { if (!suspended) memoryPending = true; });
    });
    document.addEventListener('input', e => { if (e.target.closest('#sheetIn') && api.activeDraft()) scheduleDraft(); });
    document.addEventListener('click', e => { if (e.target.closest('#sheetIn') && api.activeDraft()) scheduleDraft(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { persistDraft().catch(warn); persistPatrol().catch(warn); } });
    root.addEventListener('pagehide', () => { persistDraft().catch(() => {}); persistPatrol().catch(() => {}); });
    root.DG_HAS_UNSAVED_WORK = hasUnsaved; root.DG_HAS_UNSAVED_WORK_SYNC = hasUnsavedSync;
  }
  root.DGIntegration = { attach, ready, suspend, persistDraft, discardInspectionDraft, restoreInspectionDraft, scheduleDraft, persistPatrol, restorePatrol, saveInspection, savePatrol, unpreservedInspectionDrafts, hasUnsaved, hasUnsavedSync, captureForm, restoreForm,
    whenReady: () => suspended ? Promise.resolve(false) : readyPromise, flushDraftWrites: () => draftWrite, get initialized() { return initialized; } };
})(globalThis);
