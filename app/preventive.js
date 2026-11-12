(function (root) {
  'use strict';
  const P = root.DGPreventiveCore, C = root.DGOperationsCore;
  let api, attached = false, request = 0, writes = Promise.resolve(), activeOwner;
  const draftOwners = new WeakMap(), draftVersions = new WeakMap(), editorTokens = new WeakMap(), cleared = new WeakSet();
  const state = { plans: [], loaded: false, loading: false, error: '', owner: '', draft: null, progress: '' };
  const clone = value => JSON.parse(JSON.stringify(value)), Q = selector => document.querySelector(selector), E = value => api.esc(value);
  const owner = () => ({ api, actor: api.state().me, backend: api.firebase(), database: api.database(), offline: root.DGOffline, namespace: root.DGOffline.namespace });
  const owns = value => value && value.api === api && value.actor === api.state().me && value.backend === api.firebase() && value.database === api.database() && value.offline === root.DGOffline && value.namespace === root.DGOffline.namespace;
  const ownDraft = d => d && owns(draftOwners.get(d)) && d.actor === api.state().me && !cleared.has(d);
  function bind(d, captured, key, exists) { d.storageId = key; draftOwners.set(d, captured); draftVersions.set(d, exists ? d.draftRevision || 0 : null); editorTokens.set(d, uuid('pm-editor')); return d; }
  const uuid = prefix => root.DGOperations.uuid(prefix), ask = (message, options) => root.DGDialog ? root.DGDialog.confirm(message, options) : Promise.resolve(confirm(message));
  const heading = (title, subtitle) => '<div class="sheet-head"><div><h3>' + E(title) + '</h3><p class="muted">' + E(subtitle || '') + '</p></div><button class="x" data-close aria-label="닫기">×</button></div>';
  const day = value => value ? C.kstDateKey(value) : '', atDay = value => value ? Date.parse(value + 'T00:00:00+09:00') : 0;
  const staff = selected => [...new Map([{ id: api.state().me, name: api.state().names[api.state().me] || '이 기기 관리자', role: 'admin' }, ...api.state().roles].filter(row => ['admin', 'inspector'].includes(row.role)).map(row => [row.id, row])).values()].map(row => '<option value="' + E(row.id) + '"' + (row.id === selected ? ' selected' : '') + '>' + E(row.name || api.state().names[row.id] || row.id) + '</option>').join('');
  function adopt() { if (!owns(activeOwner)) { activeOwner = owner(); state.owner = activeOwner.actor + '/' + activeOwner.namespace; state.loaded = false; state.plans = []; state.draft = null; state.error = ''; state.progress = ''; state.loading = false; request++; } }
  async function load() {
    adopt(); const token = ++request, captured = owner(); state.loading = true; state.error = '';
    try { const plans = await api.readAll('preventivePlans', { requireServer: !!api.firebase() }); if (token !== request || !owns(captured)) return; state.plans = plans.sort((a, b) => a.nextAt - b.nextAt); state.loaded = true; }
    catch (error) { if (token === request && owns(captured)) state.error = error.message; }
    finally { if (token === request && owns(captured)) { state.loading = false; api.render(); } }
  }
  function view() {
    adopt(); if (!state.loaded && !state.loading && !state.error) setTimeout(load, 0);
    return '<div class="panel"><h3>반복 정기점검</h3><p>시설을 정해 반복 주기와 담당자를 등록해요. 이번 회차를 생성하면 기존 미완료 작업을 연결하고, 나머지 시설의 작업을 만들어요. 앱을 닫은 동안 자동 생성하지 않아요.</p><button class="btn sodium" data-pm="new"' + (!api.can('admin') ? ' disabled' : '') + '>정기점검 계획 등록</button><button class="btn ghost" data-pm="refresh">다시 조회</button>' + (state.progress ? '<p role="status">' + E(state.progress) + '</p>' : '') + '</div>' + (state.loading ? '<p role="status">계획 조회 중…</p>' : '') + (state.error ? '<p class="notice" role="alert">' + E(state.error) + '</p>' : '') + state.plans.map(plan => '<div class="panel"><h3>' + E(plan.title) + '</h3><p>대상 ' + plan.lightIds.length + '곳 · ' + plan.intervalDays + '일 주기 · 회차 시작 후 ' + plan.completionDays + '일 이내 완료</p><p>다음 회차 ' + E(day(plan.nextAt)) + ' · ' + E(api.state().names[plan.assignedTo] || plan.assignedTo) + ' · ' + (plan.enabled ? plan.nextAt <= Date.now() ? '생성할 회차 있음' : '예정' : '중지') + '</p><div class="split"><button class="btn sodium" data-pm="generate" data-id="' + E(plan.id) + '"' + (!api.can('admin') || !plan.enabled || plan.nextAt > Date.now() ? ' disabled' : '') + '>이번 회차 생성 / 이어하기</button><button class="btn ghost" data-pm="runs" data-id="' + E(plan.id) + '">회차 이력</button>' + (api.can('admin') ? '<button class="btn ghost" data-pm="toggle" data-id="' + E(plan.id) + '">' + (plan.enabled ? '계획 중지' : '계획 재개') + '</button>' : '') + '</div></div>').join('') + (state.loaded && !state.plans.length ? '<p class="empty">등록한 반복 점검 계획이 없어요.</p>' : '');
  }
  async function open() { const captured = owner(), gen = api.navGen?.(); await persistActive(); if (!owns(captured)) return; await load(); if (!owns(captured) || gen != null && !api.navAlive(gen)) return; api.navigate(heading('정기점검 계획', '시설 종류·구역별 반복 작업') + '<div id="pmBody">' + view() + '</div>', { key: 'preventive:list', reopen: open }); }
  function capture() {
    const d = state.draft, form = Q('#pmEditor'); if (!ownDraft(d) || d.pending || !form || form.dataset.id !== d.id || form.dataset.editorToken !== editorTokens.get(d)) return d;
    for (const key of ['title', 'description', 'assignedTo', 'intervalDays', 'completionDays', 'startDate', 'priority', 'type', 'dong', 'kind', 'query']) { const el = Q('#pm_' + key); if (el) d[key] = el.value; }
    return d;
  }
  const dirty = d => !!(d && (d.pending || d.title?.trim() || d.description?.trim() || d.lightIds?.length));
  function hasActiveDraft() { return ownDraft(state.draft) && dirty(state.draft); }
  function persistActive(selected) {
    const d = selected || capture(); if (!ownDraft(d) || !root.DGOffline.ready) return Promise.resolve(); const snapshot = clone(d), captured = draftOwners.get(d), changed = dirty(d);
    writes = writes.catch(() => {}).then(async () => {
      if (!ownDraft(d)) return;
      const key = d.storageId, revision = draftVersions.get(d);
      if (!changed) { if (revision !== null) { await captured.offline.removeIfCurrent('preventiveDraft', key, revision); if (owns(captured)) { draftVersions.set(d, null); delete d.draftRevision; } } return; }
      try {
        const saved = await captured.offline.putIfCurrent('preventiveDraft', key, { ...snapshot, storageId: key }, revision);
        if (!owns(captured)) return; d.draftRevision = saved.draftRevision; draftVersions.set(d, saved.draftRevision);
      } catch (error) {
        if (error.code !== 'conflict' || !owns(captured)) throw error;
        const recovery = uuid('pm-recovery'), saved = await captured.offline.putIfCurrent('preventiveDraft', recovery, { ...snapshot, storageId: recovery, recoveryOf: key }, null);
        if (!owns(captured)) return; d.storageId = recovery; d.recoveryOf = key; d.draftRevision = saved.draftRevision; draftVersions.set(d, saved.draftRevision);
        api.toast('다른 탭의 변경을 유지하고 현재 내용은 별도 복구 초안에 보관했어요.');
      }
    }); return writes;
  }
  async function clear(d) {
    const captured = draftOwners.get(d); await writes.catch(() => {}); if (!ownDraft(d)) return false;
    const saved = await captured.offline.get('preventiveDraft', d.storageId); if (!ownDraft(d)) return false;
    if (saved && (saved.id !== d.id || saved.pending !== d.pending || (saved.draftRevision || 0) !== draftVersions.get(d))) { api.toast('다른 탭에서 변경한 초안은 유지했어요. 대기함에서 최신 내용을 확인해 주세요.'); return false; }
    try { if (saved) await captured.offline.removeIfCurrent('preventiveDraft', d.storageId, draftVersions.get(d)); }
    catch (error) { if (error.code !== 'conflict') throw error; if (owns(captured)) api.toast(error.message); return false; }
    if (!owns(captured)) return false; cleared.add(d); if (state.draft === d) state.draft = null; return true;
  }
  async function resumeDraft(id = 'current') {
    if (!api.can('admin')) return; adopt(); const captured = owner(), gen = api.navGen?.();
    await persistActive(); if (!owns(captured) || gen != null && !api.navAlive(gen)) return;
    const saved = await captured.offline.get('preventiveDraft', id); if (!owns(captured) || gen != null && !api.navAlive(gen)) return;
    if (saved && saved.actor !== captured.actor) return;
    state.draft = bind(saved || { id: uuid('pm-plan'), actor: captured.actor, title: '', description: '', assignedTo: captured.actor, priority: '보통', type: '재점검', intervalDays: '90', completionDays: '3', startDate: day(Date.now()), dong: '전체', kind: '전체', query: '', lightIds: [], pending: '' }, captured, id, !!saved);
    const d = state.draft;
    if (d.pending) { const job = (await captured.offline.jobs()).find(job => job.id === d.pending); if (!owns(captured) || gen != null && !api.navAlive(gen)) return; if (job?.state === 'synced') { await clear(d); if (owns(captured) && (gen == null || api.navAlive(gen))) return open(); return; } if (!job || ['failed', 'conflict'].includes(job.state)) { if (job) await captured.offline.discard(job.id); if (!owns(captured)) return; d.pending = ''; await persistActive(d); } }
    if (owns(captured) && state.draft === d && (gen == null || api.navAlive(gen))) renderDraft();
  }
  function candidates(d) { const query = (d.query || '').trim().toLowerCase(); return api.state().lights.filter(light => !light.removed && api.inDong(light, d.dong) && (d.kind === '전체' || light.kind === d.kind) && (!query || (light.code + ' ' + (light.address || '')).toLowerCase().includes(query))); }
  function renderTargets() { const d = state.draft, box = Q('#pmTargets'); if (!box || !ownDraft(d)) return; const rows = candidates(d); box.innerHTML = '<p><span id="pmSelectionCount">선택 ' + d.lightIds.length + '/200곳</span> · 조건 대상 ' + rows.length + '곳</p><button type="button" class="btn ghost sm" data-pm="pick">조건의 앞 200곳 선택</button><button type="button" class="btn ghost sm" data-pm="none">선택 해제</button>' + rows.slice(0, 100).map(light => '<label class="f"><input type="checkbox" data-pm-light="' + E(light.id) + '"' + (d.lightIds.includes(light.id) ? ' checked' : '') + '> ' + E(light.code) + ' · ' + E(light.dong) + '</label>').join('') + (rows.length > 100 ? '<p class="muted">목록은 앞 100곳이에요. 동·종류·번호로 범위를 좁히거나 조건 선택을 사용하세요.</p>' : ''); }
  function renderDraft() {
    const d = state.draft; if (!ownDraft(d)) return;
    api.navigate(heading('정기점검 계획 등록', '선택 시설 최대 200곳 · 입력 자동 보관') + '<div id="pmEditor" class="panel" data-id="' + E(d.id) + '" data-editor-token="' + E(editorTokens.get(d)) + '"><fieldset style="border:0;padding:0;min-width:0"' + (d.pending ? ' disabled' : '') + '><label class="f" for="pm_title">계획 제목</label><input class="f-in" id="pm_title" maxlength="120" value="' + E(d.title) + '"><label class="f" for="pm_description">점검 내용</label><textarea class="f-in" id="pm_description" maxlength="2000">' + E(d.description) + '</textarea><label class="f" for="pm_assignedTo">담당자</label><select class="f-in" id="pm_assignedTo">' + staff(d.assignedTo) + '</select><div class="grid2"><div><label class="f" for="pm_type">작업 종류</label><select class="f-in" id="pm_type">' + C.TYPES.map(type => '<option' + (type === d.type ? ' selected' : '') + '>' + E(type) + '</option>').join('') + '</select></div><div><label class="f" for="pm_priority">우선순위</label><select class="f-in" id="pm_priority">' + C.PRIORITIES.map(priority => '<option' + (priority === d.priority ? ' selected' : '') + '>' + E(priority) + '</option>').join('') + '</select></div></div><label class="f" for="pm_startDate">첫 회차 날짜</label><input class="f-in" id="pm_startDate" type="date" value="' + E(d.startDate) + '"><div class="grid2"><div><label class="f" for="pm_intervalDays">반복 주기 (일)</label><input class="f-in" id="pm_intervalDays" type="number" min="1" max="3650" value="' + E(d.intervalDays) + '"></div><div><label class="f" for="pm_completionDays">회차별 완료 기간 (일)</label><input class="f-in" id="pm_completionDays" type="number" min="1" max="3650" value="' + E(d.completionDays) + '"></div></div><h3>대상 시설</h3><div class="grid2"><select class="f-in" id="pm_dong" aria-label="점검 대상 동">' + api.dongOptions(d.dong) + '</select><select class="f-in" id="pm_kind" aria-label="시설 종류">' + ['전체', '가로등', '보안등'].map(kind => '<option' + (kind === d.kind ? ' selected' : '') + '>' + kind + '</option>').join('') + '</select></div><input class="f-in" id="pm_query" placeholder="표찰 번호·주소로 대상 찾기" aria-label="점검 대상 검색" value="' + E(d.query) + '"><div id="pmTargets"></div><button class="btn sodium block" data-pm="save">계획 저장</button></fieldset><p id="pmSaveState" role="status">' + (d.pending ? '저장 대기함에서 전송 결과를 확인해 주세요.' : '') + '</p><button class="btn ghost block" data-pm="check">저장 결과 확인</button><button class="btn ghost block" data-pm="discard">초안 버리기</button></div>', { key: 'preventive:new', reopen: () => resumeDraft(d.storageId) }); renderTargets();
  }
  async function saveDraft(button) {
    const d = capture(), captured = draftOwners.get(d), form = Q('#pmEditor'), gen = api.navGen?.(); if (!ownDraft(d) || d.pending || !form || form.dataset.editorToken !== editorTokens.get(d) || !api.can('admin')) return;
    const data = P.normalize({ ...d, startAt: atDay(d.startDate), intervalDays: Number(d.intervalDays), completionDays: Number(d.completionDays), enabled: true });
    const job = { id: uuid('pm-command'), kind: 'save', planId: d.id, actor: captured.actor, at: Date.now(), expectedRevision: 0, data };
    d.pending = job.id; await persistActive(d); if (!owns(captured)) return; button.disabled = true;
    try { const result = await captured.offline.submit('preventive', job, { id: job.id, summary: '정기점검 계획 · ' + data.title }); if (!owns(captured)) return; if (result.state === 'synced') { await clear(d); if (gen == null || api.navAlive(gen)) await open(); } else if (['failed', 'conflict'].includes(result.state)) { await captured.offline.discard(job.id); if (!owns(captured)) return; d.pending = ''; await persistActive(); const box = Q('#pmSaveState'); if (box?.isConnected) box.textContent = result.error; } else { const box = Q('#pmSaveState'); if (box) box.textContent = '기기에 보관했어요. 저장 결과 확인 또는 대기함에서 전송을 확인해 주세요.'; } }
    catch (error) { if (owns(captured)) { d.pending = ''; await persistActive(); api.toast(error.message); } }
    finally { if (owns(captured) && form.isConnected) { form.querySelector('fieldset').disabled = !!d.pending; button.disabled = !!d.pending; } }
  }
  async function discardDraft(id, options = {}) {
    if (typeof id === 'object') { options = id; id = undefined; }
    const captured = owner(); await writes.catch(() => {}); if (!owns(captured)) return false;
    let d = ownDraft(state.draft) && (!id || state.draft.storageId === id) ? state.draft : null;
    if (!d) { const key = id || 'current', saved = await captured.offline.get('preventiveDraft', key); if (!owns(captured) || !saved || saved.actor !== captured.actor) return false; d = bind(saved, captured, key, true); }
    const expected = draftVersions.get(d), pending = d.pending;
    const job = d.pending && (await captured.offline.jobs()).find(job => job.id === d.pending); if (!owns(captured)) return false;
    if (job && ['queued', 'sending'].includes(job.state)) { api.toast('전송 대기 작업의 결과를 먼저 확인해 주세요.'); return false; }
    if (!options.confirmed && !await ask('입력한 정기점검 계획 초안을 버릴까요?', { ok: '초안 버리기', danger: true })) return false;
    if (!owns(captured)) return false;
    await writes.catch(() => {}); if (!owns(captured)) return false;
    const latest = await captured.offline.get('preventiveDraft', d.storageId); if (!owns(captured)) return false;
    if (pending !== d.pending || expected !== draftVersions.get(d) || latest && ((latest.draftRevision || 0) !== expected || latest.pending !== pending || latest.id !== d.id)) { api.toast('확인하는 동안 초안이 바뀌었어요. 최신 내용을 확인해 주세요.'); return false; }
    const currentJob = pending && (await captured.offline.jobs()).find(item => item.id === pending); if (!owns(captured)) return false;
    if (currentJob && ['queued', 'sending'].includes(currentJob.state)) { api.toast('전송 대기 작업의 결과를 먼저 확인해 주세요.'); return false; }
    if (currentJob && ['failed', 'conflict'].includes(currentJob.state)) await captured.offline.discard(currentJob.id); if (!owns(captured)) return false;
    return clear(d);
  }
  async function generate(id, button) {
    const captured = owner(), gen = api.navGen?.(), plan = clone(state.plans.find(plan => plan.id === id)); if (!plan || !api.can('admin')) return;
    button.disabled = true;
    try {
      const all = await api.readAll('workOrders', { where: [['status', 'in', ['draft', 'assigned', 'in_progress', 'completed']]], requireServer: !!api.firebase() }); if (!owns(captured)) return;
      const selected = plan.lightIds.map(lightId => { const light = api.byId(lightId); if (!light || light.removed) throw new Error('계획 대상 시설을 확인할 수 없어요. 대장과 계획을 확인해 주세요.'); const active = all.filter(work => work.lightId === lightId && work.type === plan.type).sort((a, b) => a.createdAt - b.createdAt)[0]; return { light: { id: light.id, code: light.code, dong: light.dong }, candidateWorkId: active?.id || '' }; });
      for (let index = 0; index < selected.length; index += P.CHUNK) {
        if (!owns(captured)) return; const job = { id: uuid('pm-generate'), kind: 'generate', planId: id, actor: captured.actor, at: Date.now(), expectedRevision: plan.revision, scheduledAt: plan.nextAt, targets: selected.slice(index, index + P.CHUNK) };
        const result = await captured.offline.submit('preventive', job, { id: job.id, summary: '정기점검 회차 생성 · ' + plan.title }); if (!owns(captured)) return;
        if (result.state !== 'synced') throw new Error(result.error || '생성 명령을 대기함에 보관했어요. 전송 후 이번 회차 생성을 이어 주세요.');
        state.progress = Math.min(index + P.CHUNK, selected.length) + '/' + selected.length + '곳 회차 연결';
      }
      if (!owns(captured)) return; const advance = { id: uuid('pm-advance'), kind: 'advance', planId: id, actor: captured.actor, at: Date.now(), expectedRevision: plan.revision, scheduledAt: plan.nextAt };
      const result = await captured.offline.submit('preventive', advance, { id: advance.id, summary: '정기점검 다음 회차 · ' + plan.title }); if (!owns(captured)) return;
      if (result.state !== 'synced') throw new Error(result.error || '다음 회차 반영을 대기함에서 확인해 주세요.'); state.progress = '이번 회차 ' + selected.length + '곳 연결 완료 · 다음 예정일을 갱신했어요.';
      await root.DGOperations.load(true); if (owns(captured) && (gen == null || api.navAlive(gen))) await open();
    } catch (error) { if (owns(captured)) { state.progress = error.message + ' 이미 생성한 대상은 유지돼요. 같은 회차를 다시 누르면 중복 없이 이어가요.'; api.toast(state.progress); if (gen == null || api.navAlive(gen)) await open(); } }
    finally { if (button.isConnected) button.disabled = false; }
  }
  async function runs(id) { const captured = owner(), gen = api.navGen?.(), plan = state.plans.find(plan => plan.id === id); if (!plan) return; const rows = await api.readAll('preventiveRuns', { where: [['planId', '==', id]], requireServer: !!api.firebase() }); if (!owns(captured) || gen != null && !api.navAlive(gen)) return; rows.sort((a, b) => b.scheduledAt - a.scheduledAt || a.lightId.localeCompare(b.lightId)); api.navigate(heading(plan.title + ' 회차 이력', '기존 미완료 작업 연결과 신규 생성을 구분해요.') + rows.map(row => '<button class="light-row" data-dg="open-work" data-id="' + E(row.workId) + '"><b>' + E(api.byId(row.lightId)?.code || row.lightId) + '</b><small>' + E(day(row.scheduledAt)) + ' · ' + (row.carried ? '기존 미완료 작업 연결' : '이번 회차 신규 작업') + '</small></button>').join(''), { key: 'preventive:runs:' + id, reopen: () => runs(id) }); }
  async function handle(button) {
    const action = button.dataset.pm; if (action === 'open' || action === 'refresh') return open(); if (action === 'new' || action === 'check') return resumeDraft(); if (action === 'save') return saveDraft(button); if (action === 'generate') return generate(button.dataset.id, button); if (action === 'runs') return runs(button.dataset.id);
    if (action === 'discard') { if (await discardDraft()) return open(); return; }
    if (action === 'pick' || action === 'none') { capture(); if (!ownDraft(state.draft) || state.draft.pending) return; state.draft.lightIds = action === 'pick' ? candidates(state.draft).slice(0, 200).map(light => light.id) : []; renderTargets(); return persistActive(); }
    if (action === 'toggle') { if (!api.can('admin')) return; const captured = owner(), plan = state.plans.find(plan => plan.id === button.dataset.id); if (!plan) return; const job = { id: uuid('pm-toggle'), kind: 'save', planId: plan.id, actor: captured.actor, at: Date.now(), expectedRevision: plan.revision, data: { ...plan, enabled: !plan.enabled } }; const result = await captured.offline.submit('preventive', job, { id: job.id, summary: '정기점검 계획 상태 · ' + plan.title }); if (!owns(captured)) return; if (result.state !== 'synced') api.toast(result.error || '저장 대기함에서 처리 상태를 확인해 주세요.'); return open(); }
  }
  function attach(context) {
    api = context; root.DGOffline.register('preventive', job => root.DGPreventiveCommands.execute(job, { db: api.database(), fb: api.firebase(), user: api.state().me, admin: api.can('admin') })); if (attached) return; attached = true;
    document.addEventListener('click', event => { const button = event.target.closest('[data-pm]'); if (button) Promise.resolve().then(() => handle(button)).catch(error => api.toast(error.message)); });
    document.addEventListener('input', event => { if (!event.target.closest('#pmEditor')) return; capture(); if (event.target.id === 'pm_query') renderTargets(); persistActive().catch(error => api.toast(error.message)); });
    document.addEventListener('change', event => { if (!event.target.closest('#pmEditor')) return; const d = capture(); if (!ownDraft(d) || d.pending) return; if (event.target.dataset.pmLight) { const id = event.target.dataset.pmLight; if (event.target.checked && !d.lightIds.includes(id)) { if (d.lightIds.length >= 200) { event.target.checked = false; return api.toast('한 계획은 200곳까지 선택할 수 있어요.'); } d.lightIds.push(id); } else if (!event.target.checked) d.lightIds = d.lightIds.filter(value => value !== id); } if (['pm_dong', 'pm_kind'].includes(event.target.id)) renderTargets(); const count = Q('#pmSelectionCount'); if (count) count.textContent = '선택 ' + d.lightIds.length + '/200곳'; persistActive().catch(error => api.toast(error.message)); });
  }
  root.DGPreventive = { attach, open, view, load, resumeDraft, discardDraft, persistActive, hasActiveDraft, state };
})(globalThis);
