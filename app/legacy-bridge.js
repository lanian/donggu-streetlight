/* Small compatibility boundary while the original field views move into modules. */
function initializeOperations() {
  const api = {
    esc, fmtDT, can, state: () => S, firebase: () => FB && FB.fs, database: () => db,
    byId, inDong, dongValues: () => ADONGS.map(d => 'a:' + d), dongOptions,
    render: () => render(), toast, readAll: (...args) => listAllRecords(...args), readPage: (collection, options) => DGData.readPage(db, collection, { requireServer: !!FB, ...options }), getPhoto,
    openSection: key => openAdminSection(key),
    lightingReview: () => rvFresh(), lightingCandidates: rv => rvList(rv), lightingGrid: () => lightGrid(),
    lightingModel: () => ({ model: LIGHT_MODEL, calibration: CALIB }), lightingRoads: () => ROADS,
    returnLightingReview: () => returnLightingReview(),
    rememberLightingCandidate: index => rememberLightingReviewCandidate(index),
    registry: () => BASE, overrides: () => OV,
    invalidateLighting: reason => invalidateLightingReview(reason),
    download: async options => {
      if (dl) return dl.save(options);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([options.data], { type: 'text/csv;charset=utf-8' })); a.download = options.filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
    // route = { key, reopen, back?, replace? }: how to rebuild this screen when the user comes back to it
    navigate: (html, route) => { DGIntegration.persistDraft().catch(e => toast(e.message)); stashDraft(); draft = null; S.asec = null; if (route) navRoute(route.key, route.reopen, route); openSheet(html); },
    navGen: () => navGen(), navAlive: g => navAlive(g), navDepth: () => navDepth(),
    closeSheet: () => closeSheet(), openLight: id => openLight(id), openMap: (...args) => { DGIntegration.persistDraft().catch(e => toast(e.message)); stashDraft(); draft = null; S.asec = null; openMap(...args); },
    removeDraft: async id => { delete DRAFTS[id]; if (draft && draft.lightId === id) { draft = null; closeSheet(); } await DGIntegration.flushDraftWrites().catch(() => {}); await DGOffline.remove('draft', id); },
    removePatrolDraft: sessionId => { if (pt.sessionId === sessionId) { ptReset(); if ($('#ptSumm')) closeSheet(); } },
    restorePatrol: () => DGIntegration.restorePatrol(),
    print: html => { S.asec = null; navRoute('print', null, { replace: true }); openSheet('<div class="sheet-head noprint"><h3>업무 현황 인쇄</h3><button class="x" data-close aria-label="닫기">×</button></div><div class="rep">' + html + '</div>'); window.print(); },
    processPhoto: async file => {
      const result = await compressBlob(file, 1000, .72); let data = result.url;
      if (data.length > 700000) data = result.canvas.toDataURL('image/jpeg', .45);
      if (data.length > 700000) throw new Error('사진 크기가 너무 커요. 더 작은 사진을 선택해 주세요.');
      const sample = document.createElement('canvas'); sample.width = 64; sample.height = 64; const ctx = sample.getContext('2d'); ctx.drawImage(result.canvas, 0, 0, 64, 64);
      const pixels = ctx.getImageData(0, 0, 64, 64).data; let sum = 0, square = 0;
      for (let i = 0; i < pixels.length; i += 4) { const y = .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]; sum += y; square += y * y; }
      const mean = sum / 4096, contrast = Math.sqrt(Math.max(0, square / 4096 - mean * mean));
      const warning = mean < 25 ? '사진이 매우 어두워요. 시설과 조치 부위가 식별되는지 확인해 주세요.' : mean > 240 ? '사진이 매우 밝아요. 반사광에 증빙이 가려지지 않았는지 확인해 주세요.' : contrast < 10 ? '사진 대비가 낮아요. 초점과 조치 부위를 확인해 주세요.' : '';
      return { data, w: result.canvas.width, h: result.canvas.height, warning };
    },
    activeDraft: () => draft, setDraft: value => { draft = value; }, drafts: () => DRAFTS, draftDirty, inspectionDraftKey,
    checks: () => CHECKS, suggestResult, newInspectionJob, commitInspectionJob,
    patrol: () => pt, preparePatrolJob, commitPatrolJob, finishPatrolJob,
    patrolKey: value => patrolDraftKey({ ...value, passed: new Map(value.passed || []) }),
    rememberPatrolJob: job => PATROL_JOBS.set(job.sessionId, job),
    forgetPatrolJob: job => { if (PATROL_JOBS.get(job.sessionId)?.id === job.id) PATROL_JOBS.delete(job.sessionId); },
    resumePatrol: saved => {
      closeSheet(true); openPatrol(saved.dong);
      Object.assign(pt, saved, { on: true, paused: true, passed: new Map(saved.passed), last: null, pos: saved.pos || null });
      const button = $('#ptPause'); if (button) { button.textContent = '재개'; button.setAttribute('aria-pressed', 'true'); }
      if (typeof ptDraw === 'function') ptDraw(true);
    }
  };
  DGIntegration.attach(api);
  DGWorkflows.attach(api);
  const originalClose = closeSheet;
  closeSheet = function (fromHistory) { DGOperations.persistActive().catch(e => toast(e.message)); globalThis.DGLightingAreas?.persistActive().catch(e => toast(e.message)); DGIntegration.persistDraft().catch(e => toast(e.message)); DGIntegration.persistPatrol().catch(e => toast(e.message)); return originalClose(fromHistory); };
  const originalLight = openLight;
  openLight = async function (id) {
    if (!DGIntegration.initialized && !(await DGIntegration.whenReady())) return toast('초안 복구와 저장소 연결을 마친 뒤 다시 열어 주세요.');
    DGIntegration.persistDraft().catch(e => toast(e.message)); stashDraft(); S.asec = null;
    const result = originalLight(id), memo = $('#iMemo'), head = $('#lightNav');
    if (memo) memo.insertAdjacentHTML('afterend', '<div id="dgDraftState" class="dg-save-state" role="status">' + (DGOffline.durable ? '입력한 점검 내용은 이 기기에 자동 보관돼요.' : '현재 창에서만 초안을 보관해요.') + '</div>');
    if (head) {
      head.insertAdjacentHTML('beforeend', '<button type="button" data-fw="facility" data-id="' + esc(id) + '">통합 업무 이력</button>' + (can('admin') ? '<button type="button" data-dg="new-work" data-light-id="' + esc(id) + '">보수 작업 지시</button>' : ''));
      head.insertAdjacentHTML('afterend', '<div id="dgFacilityWorkSummary" class="panel" aria-live="polite">진행 중인 작업을 확인해요…</div>');
      DGWorkflows.renderSummary(id, document.getElementById('dgFacilityWorkSummary')).catch(e => toast(e.message));
    }
    return result;
  };
  const originalPhotos = renderPhotoStrip;
  renderPhotoStrip = function () { originalPhotos(); DGIntegration.scheduleDraft(); };
  const originalAdmin = openAdminSection;
  openAdminSection = function (key) { DGIntegration.persistDraft().catch(e => toast(e.message)); stashDraft(); draft = null; if (key === 'outbox') DGOperations.refreshQueue().catch(e => toast(e.message)); return originalAdmin(key); };
  refreshAdminSection = function () {
    const key = S.asec, body = $('#asecBody'); if (!key || !body || !$('#sheet').classList.contains('open')) return;
    const section = ADMIN_SECTIONS[key]; if (!section || globalThis.rvQueryComposing && document.activeElement?.id === "rvQuery") return;
    // Snapshot form fields and selection, even when a real-time event arrives while focus is elsewhere.
    const fields = DGIntegration.captureForm(body), scroll = $('#sheet').scrollTop;
    // Restored-draft guidance is outside the captured form fields; keep it across live redraws.
    const restoredDraftNotice = body.querySelector('[data-fdclear]')?.closest('.notice') || null;
    // A live refresh can arrive while the native file chooser is open. Keep its target alive.
    const fileInputs = [...body.querySelectorAll('input[type="file"][id]')];
    const previews = [...body.querySelectorAll('img[id]')].map(el => ({ id: el.id, src: el.getAttribute('src'), hidden: el.hidden }));
    // Keep a visible location picker and its marker handlers when realtime data redraws the section.
    const regMapHost = key === 'reg' ? body.querySelector('#regMapPick:not([hidden])') : null;
    const regLocationHelp = key === 'reg' ? body.querySelector('#regLocHelp')?.textContent : null;
    body.innerHTML = section.body(); DGIntegration.restoreForm(body, fields);
    if (regLocationHelp) { const help = body.querySelector('#regLocHelp'); if (help) help.textContent = regLocationHelp; }
    if (regMapHost) {
      const fresh = body.querySelector('#regMapPick');
      if (fresh) { fresh.replaceWith(regMapHost); const pick = body.querySelector('#regMapPickBtn'); if (pick) { pick.textContent = '지도 닫기'; pick.setAttribute('aria-expanded', 'true'); } }
      setTimeout(() => { if (typeof regPickMap !== 'undefined' && regPickMap?.getContainer() === regMapHost && regMapHost.isConnected) regPickMap.invalidateSize(); }, 50);
    }
    if (restoredDraftNotice && typeof FD !== 'undefined' && FD.state['asec:' + key]?.persisted) body.prepend(restoredDraftNotice);
    for (const input of fileInputs) { const replacement = document.getElementById(input.id); if (replacement && body.contains(replacement)) replacement.replaceWith(input); }
    for (const item of previews) { const el = document.getElementById(item.id); if (el && item.src) { el.src = item.src; el.hidden = item.hidden; } }
    $('#sheet').scrollTop = scroll;
  };
  saveInspection = () => DGIntegration.saveInspection();
  ptSave = () => DGIntegration.savePatrol();
  const originalFinish = ptFinish;
  ptFinish = function () { originalFinish(); DGIntegration.persistPatrol().catch(e => toast(e.message)); };
  const originalReportCard = reportCard;
  reportCard = function (report, admin) {
    const html = originalReportCard(report, admin);
    if (!admin || !can('admin')) return html;
    const at = html.lastIndexOf('</div>');
    return html.slice(0, at) + '<div class="split"><button class="btn ghost sm" data-fw="report-facility" data-id="' + esc(report.id) + '">' + (report.lightId ? '시설 연결 정정' : '시설 연결하기') + '</button>' + (report.status !== '완료' ? '<button class="btn ghost sm" data-fw="report-work" data-id="' + esc(report.id) + '">보수 작업으로 연결</button>' : '') + '</div>' + html.slice(at);
  };
  Object.assign(ADMIN_SECTIONS, {
    health: { t: '공유 운영 상태', d: '접수·감사·보관 정리와 처리 대기', body: () => DGManagement.healthView() },
    lightingtasks: { t: '밝기 재확인 업무', d: '자료 부족·현장 확인 배정과 완료', write: true, body: () => DGLightingWorkflows.tasksView() },
    lightinghistory: { t: '밝기 검토 이력', d: '검토 조건·근거·비교 이력', body: () => DGLightingWorkflows.historyView() },
    lightingareas: { t: '밝기 검토 제외 구역', d: '산·숲 등 제외 범위와 보행로 예외', body: () => DGLightingAreas.view() },
    lightingimport: { t: '외부 광원 가져오기', d: '다른 기관 자료 비교·확인', admin: true, body: () => DGLightingWorkflows.importView() },
    works: { t: '보수 작업', d: '담당 배정·조치 전후 사진·완료 검수', write: true, body: () => DGOperations.view() },
    due: { t: '미점검·방문 계획', d: '정기 점검 기한·재점검·현장 방문 순서', write: true, body: () => DGOperations.dueView() },
    outbox: { t: '저장 대기함·초안', d: '미전송 작업 재시도·작성 내용 복구', write: true, n: () => DGOperations.state.jobs.filter(j => j.state !== 'synced').length || null, body: () => DGOperations.queueView() },
    dashboard: { t: '업무 현황', d: '기간 실적·기한 초과·반복 고장·자재비', body: () => DGManagement.dashboard() },
    registryupdate: { t: '대장 갱신 비교', d: '새 대장 비교·현장 수정 보존·번호 변경 추적', admin: true, body: () => DGManagement.registryView() },
    inventory: { t: '자재·재고', d: '입출고 이력·보수 검수와 재고 연동', admin: true, body: () => DGManagement.inventoryView() },
    operationsettings: { t: '업무 기준·보관 기간', d: '점검 주기·연락처 파기·기기 저장', admin: true, body: () => DGManagement.settingsView() },
    audit: { t: '변경 감사 기록', d: '서버 변경 이벤트·행위자·처리 이력', admin: true, body: () => DGManagement.auditView() }
  });
  ADMIN_SECTIONS.lightingcontext = { t: '대장 밖 광원·현장 밝기', d: '다른 기관 조명·상가 조명·현장 관찰·실측', write: true, body: () => DGLighting.view() };
  // Never turn the discarded patrol into a hidden recovery draft.
  document.addEventListener('click', e => {
    if (e.target.closest('#ptDiscard') && !pt.track.length && !pt.marks.length && !pt.spots.length && DGOffline.ready) DGOffline.remove('patrol', 'current').catch(error => toast(error.message));
  });
}
