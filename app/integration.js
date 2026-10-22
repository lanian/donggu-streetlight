/* The legacy field UI is connected here; business commands stay in independent modules. */
(function (root) {
  'use strict';
  let api, attached = false, initialized = false, timer = null, patrolTimer = null, memoryPending = false, autosaveError = '', patrolKey = '', draftWrite = Promise.resolve(), resolveReady;
  const readyPromise = new Promise(resolve => { resolveReady = resolve; });
  const finishing = new Map(), busy = new Set();
  const Q = s => document.querySelector(s), copy = v => JSON.parse(JSON.stringify(v));
  function warn(error) { const message = error && error.message || '초안을 보관하지 못했어요. 저장 공간을 확인해 주세요.'; if (message !== autosaveError) api.toast(message); autosaveError = message; }
  function syncMemo(d) { const m = Q('#iMemo'); if (d && api.activeDraft() === d && m) d.memo = m.value; return d; }
  function persistDraft() {
    if (!root.DGOffline.ready) return Promise.resolve();
    const d = syncMemo(api.activeDraft());
    if (!d || !d.lightId) return Promise.resolve();
    const id = d.lightId, dirty = api.draftDirty(d), value = dirty ? copy(d) : null;
    if (dirty) api.drafts()[id] = d; else delete api.drafts()[id];
    memoryPending = memoryPending || dirty;
    draftWrite = draftWrite.catch(() => {}).then(async () => {
      if (value) await root.DGOffline.put('draft', id, value); else await root.DGOffline.remove('draft', id);
      autosaveError = '';
      const status = Q('#dgDraftState');
      if (status) status.textContent = value ? root.DGOffline.durable ? '이 기기에 초안을 보관했어요.' : '현재 창에 초안을 보관했어요. 창을 닫으면 지워져요.' : '';
    });
    return draftWrite;
  }
  function scheduleDraft() { clearTimeout(timer); timer = setTimeout(() => persistDraft().catch(warn), 160); }
  function patrolSnapshot() {
    const p = api.patrol(); if (!p.sessionId || !(p.track.length || p.marks.length || p.spots.length || p.passed.size)) return null;
    return { sessionId: p.sessionId, start: p.start, end: p.end || null, dong: p.dong, total: p.total, track: copy(p.track), passed: [...p.passed], marks: copy(p.marks), spots: copy(p.spots), dist: p.dist, pos: p.pos && copy(p.pos), last: p.last && copy(p.last), heading: p.heading, paused: true };
  }
  async function persistPatrol() {
    if (!root.DGOffline.ready) return;
    const snapshot = patrolSnapshot(); if (!snapshot) return;
    const key = JSON.stringify(snapshot); if (key === patrolKey) return;
    await root.DGOffline.put('patrol', 'current', snapshot); patrolKey = key; memoryPending = true;
  }
  async function restorePatrol() {
    const saved = await root.DGOffline.get('patrol', 'current'); if (!saved) return api.toast('복구할 순찰 초안이 없어요.');
    const current = api.patrol();
    if (current.on && patrolSnapshot() && !confirm('현재 순찰을 기기에 보관한 초안으로 바꿀까요?')) return;
    api.resumePatrol(saved); api.toast('이전 순찰을 불러왔어요. 이동 기록은 정지 상태로 시작해요.');
  }
  async function finishInspection(job) {
    if (finishing.has(job.id)) return finishing.get(job.id);
    const pending = (async () => {
      const id = job.rec.lightId, active = syncMemo(api.activeDraft()), d = api.drafts()[id] || (active && active.lightId === id ? active : null);
      if (d && d.__saveJob && d.__saveJob.id === job.id) delete d.__saveJob;
      if (d && api.inspectionDraftKey(d) === job.key) {
        if (api.drafts()[id] === d) delete api.drafts()[id];
        if (active === d) { api.setDraft(null); api.closeSheet(); }
      } else if (d) await root.DGOffline.put('draft', id, d);
      const stored = await root.DGOffline.get('draft', id);
      if (stored && api.inspectionDraftKey(stored) === job.key) await root.DGOffline.remove('draft', id);
      else if (stored && stored.__saveJob && stored.__saveJob.id === job.id) { delete stored.__saveJob; await root.DGOffline.put('draft', id, stored); }
      api.render(); await root.DGOperations.refreshQueue();
    })();
    finishing.set(job.id, pending); try { await pending; } finally { finishing.delete(job.id); }
  }
  async function saveInspection() {
    const source = syncMemo(api.activeDraft()); if (!source) return;
    const light = api.byId(source.lightId); if (!light) return;
    if (!api.can('inspect') || !api.state().canWrite) return api.toast('점검 저장 권한을 확인해 주세요.');
    if (!root.DGOffline.ready) return api.toast('저장 대기함을 준비하는 중이에요. 잠시 뒤 다시 저장해 주세요.');
    if (busy.has(light.id)) return api.toast('이 시설의 저장 요청을 처리하는 중이에요.');
    let job = source.__saveJob;
    if (!job) {
      const missing = api.checks().filter(([key]) => !source.checks[key]);
      if (missing.length && !confirm('점검표 ' + missing.length + '개 항목이 비어 있어요. 나머지를 양호로 기록하고 저장할까요?')) return;
      for (const [key] of missing) source.checks[key] = 'ok';
      if (!source.result) api.suggestResult();
      if (!source.result) return api.toast('점검 결과를 선택해 주세요.');
      job = api.newInspectionJob(light, source); source.__saveJob = job;
    }
    const button = Q('#saveInsp'); if (button) { button.disabled = true; button.textContent = '저장 확인 중…'; }
    busy.add(light.id); api.drafts()[light.id] = source;
    try {
      await persistDraft();
      const result = await root.DGOffline.submit('inspection', job, { id: job.id, summary: '점검 · ' + light.code, retry: true });
      if (result.state === 'synced') { await finishInspection(job); api.toast('점검 결과를 저장했어요.' + (api.drafts()[light.id] ? ' 이후 수정한 내용은 초안으로 유지돼요.' : '')); }
      else if (['failed', 'conflict'].includes(result.state)) api.toast(result.error + ' 저장 대기함에서 확인해 주세요.');
      else api.toast(root.DGOffline.durable ? '점검을 기기에 보관했어요. 저장 대기함에서 전송 상태를 확인할 수 있어요.' : '전송을 기다리고 있어요. 완료 전에는 이 창을 닫지 마세요.');
    } catch (error) { warn(error); }
    finally { busy.delete(light.id); const current = Q('#saveInsp'); if (api.activeDraft() === source && current) { current.disabled = false; current.textContent = '점검 결과 저장'; } }
  }
  async function savePatrol() {
    if (!root.DGOffline.ready) return api.toast('저장 대기함을 준비하는 중이에요.');
    const job = api.preparePatrolJob();
    const button = Q('#ptSave'); if (button) { button.disabled = true; button.textContent = '저장 확인 중…'; }
    try {
      await persistPatrol();
      const result = await root.DGOffline.submit('patrol', job, { id: job.id, summary: '순찰 · ' + api.fmtDT(job.rec.start), retry: true });
      if (result.state === 'synced') { await finishPatrol(job); api.toast('순찰 결과를 저장했어요.'); }
      else api.toast(result.error || (root.DGOffline.durable ? '순찰을 기기에 보관했어요. 저장 대기함에서 이어서 전송해요.' : '전송을 기다리고 있어요. 완료 전에는 창을 닫지 마세요.'));
    } catch (error) { warn(error); }
    finally { const current = Q('#ptSave'); if (current) { current.disabled = false; current.textContent = '순찰 결과 저장'; } }
  }
  async function finishPatrol(job) {
    api.finishPatrolJob(job);
    const saved = await root.DGOffline.get('patrol', 'current');
    if (saved && saved.sessionId === job.sessionId && api.patrolKey(saved) === job.key) { await root.DGOffline.remove('patrol', 'current'); patrolKey = ''; }
    await root.DGOperations.refreshQueue();
  }
  async function hasUnsaved() {
    if (!root.DGOffline.ready) return hasUnsavedSync();
    const [jobs, ...drafts] = await Promise.all([root.DGOffline.jobs(), ...['draft', 'patrol', 'workDraft', 'workCompletion', 'lightingDraft'].map(k => root.DGOffline.list(k))]);
    memoryPending = jobs.some(j => j.state !== 'synced') || drafts.some(values => values.length);
    return memoryPending || hasActiveDraft();
  }
  function hasActiveDraft() { return !!api.draftDirty(syncMemo(api.activeDraft())) || !!patrolSnapshot(); }
  function hasUnsavedSync() { return memoryPending || hasActiveDraft(); }
  async function ready() {
    try {
    if (!api.state().me || !api.database()) { initialized = true; resolveReady(false); return; }
    const namespace = (api.firebase() ? 'firebase:' + root.FIREBASE_CONFIG.projectId : api.state().me === 'local' ? 'local' : 'artifact') + ':' + api.state().me;
    const options = { namespace, durable: api.state().me === 'local' || root.DG_DEVICE_TRUSTED === true, networkRequired: api.state().me !== 'local' };
    try { await root.DGOffline.configure(options); }
    catch (error) { warn(error); await root.DGOffline.configure({ ...options, durable: false }); }
    const saved = await root.DGOffline.list('draft');
    for (const entry of saved) if (entry.value && api.byId(entry.id) && !api.drafts()[entry.id]) api.drafts()[entry.id] = entry.value;
    for (const job of await root.DGOffline.jobs()) if (job.kind === 'patrol' && job.payload && job.state !== 'synced') api.rememberPatrolJob(job.payload);
    await root.DGOperations.ready(); if (root.DGLighting) await root.DGLighting.ready(); await hasUnsaved(); initialized = true; resolveReady(true); api.render();
    if (saved.length || (await root.DGOffline.list('patrol')).length) api.toast('작성하던 내용이 있어요. 저장 대기함에서 이어 쓸 수 있어요.');
    root.DGOffline.flush().catch(warn);
    clearInterval(patrolTimer); patrolTimer = setInterval(() => persistPatrol().catch(warn), 2500);
    if (api.database().collection && supportedSubscriptions()) {
      for (const collection of ['workOrders', 'inventory', 'settings', 'reports']) {
        try { api.database().collection(collection).onSnapshot(() => { if (root.DGOperations.state.loaded) root.DGOperations.load(true); }, () => {}); } catch (e) { /* Explicit refresh remains available on adapters without live reads. */ }
      }
    }
    } catch (error) { resolveReady(false); throw error; }
  }
  function supportedSubscriptions() { return api.state().me === 'local' || !!api.firebase(); }
  function captureForm(container) {
    const values = [], focus = document.activeElement;
    for (const el of container.querySelectorAll('input,textarea,select,[aria-pressed]')) {
      if (el.type === 'file') continue;
      const key = el.id ? '#' + CSS.escape(el.id) : el.hasAttribute('data-plan-light') ? '[data-plan-light="' + CSS.escape(el.dataset.planLight) + '"]' : el.hasAttribute('data-ibissue') ? '[data-ibissue="' + CSS.escape(el.dataset.ibissue) + '"]' : null;
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
      if (event.type === 'synced') {
        if (event.job.kind === 'inspection') finishInspection(event.job.payload).catch(warn);
        if (event.job.kind === 'patrol') finishPatrol(event.job.payload).catch(warn);
      }
      if (event.type === 'discarded' && event.job && event.job.kind === 'inspection') {
        const job = event.job.payload, d = job && api.drafts()[job.rec.lightId];
        if (d && d.__saveJob && d.__saveJob.id === event.id) { delete d.__saveJob; root.DGOffline.put('draft', d.lightId, d).catch(warn); }
      }
      if (event.type === 'discarded' && event.job && event.job.kind === 'patrol' && event.job.payload) api.forgetPatrolJob(event.job.payload);
      if (['draft', 'job', 'removed', 'discarded', 'synced', 'cleared'].includes(event.type)) hasUnsaved().catch(() => { memoryPending = true; });
    });
    document.addEventListener('input', e => { if (e.target.closest('#sheetIn') && api.activeDraft()) scheduleDraft(); });
    document.addEventListener('click', e => { if (e.target.closest('#sheetIn') && api.activeDraft()) scheduleDraft(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { persistDraft().catch(warn); persistPatrol().catch(warn); } });
    root.addEventListener('pagehide', () => { persistDraft().catch(() => {}); persistPatrol().catch(() => {}); });
    root.DG_HAS_UNSAVED_WORK = hasUnsaved; root.DG_HAS_UNSAVED_WORK_SYNC = hasUnsavedSync;
  }
  root.DGIntegration = { attach, ready, persistDraft, scheduleDraft, persistPatrol, restorePatrol, saveInspection, savePatrol, hasUnsaved, hasUnsavedSync, captureForm, restoreForm,
    whenReady: () => readyPromise, flushDraftWrites: () => draftWrite, get initialized() { return initialized; } };
})(globalThis);
