/* Unofficial field-data handoff. The operational system is updated outside this app. */
(function (root) {
  'use strict';
  const KIND = 'roadlighting-batch', SECTION = 'roadlighting';
  const TYPES = [['inspections', '점검'], ['reports', '신고'], ['workOrders', '보수 작업'], ['patrols', '순찰']];
  const ENTITY_LABELS = { ...Object.fromEntries(TYPES), workEvents: '보수 처리 이력' };
  // index.html loads roadlighting-core.js first; a page without it still loads and only the range starts empty.
  const range0 = root.DGRoadlightingCore?.defaultRange?.() || { from: '', to: '' };
  const state = { from: range0.from, to: range0.to, dong: '전체', types: Object.fromEntries(TYPES.map(([key]) => [key, true])), includePhotos: true, includeContacts: false, loading: false, preparing: false, downloading: false, progress: '', error: '', snapshot: null, package: null, history: [], historyRequested: false, historyLoading: false, historyError: '', selectedBatch: '', selectedEntry: '', receiptDraft: { status: 'registered', externalId: '', note: '' }, receiptSaving: false };
  let api, attached = false, owner = null, sequence = 0, active = null, historySequence = 0, historyActive = null, historyContext = null, prepared = null;
  const receiptDrafts = new Map();
  const photoSources = new WeakMap(), noFirebase = {};
  const Q = selector => root.document.querySelector(selector), E = value => api.esc(value), clone = value => JSON.parse(JSON.stringify(value));
  const fail = (message, code) => Object.assign(new Error(message), { code });
  const cancelled = () => fail('화면·조건·계정이 바뀌어 준비를 취소했어요. 현재 조건으로 다시 조회해 주세요.', 'bridge-cancelled');
  const visible = () => api?.state().asec === SECTION && !!Q('#dgRoadlightingBridge');
  const sameOwner = value => !!value && value.actor === api.state().me && value.database === api.database() && value.firebase === api.firebase() && value.namespace === root.DGOffline.namespace && api.can('admin');
  const signature = () => JSON.stringify([state.from, state.to, state.dong, TYPES.map(([key]) => !!state.types[key]), state.includePhotos, state.includeContacts]);
  function context() { return { actor: api.state().me, database: api.database(), firebase: api.firebase(), namespace: root.DGOffline.namespace, generation: api.navGen?.(), signature: signature() }; }
  function current(value) { return sameOwner(value) && visible() && (value.generation == null || api.navAlive(value.generation)) && value.signature === signature(); }
  function photoSource(identity) {
    let firebaseSources = photoSources.get(identity.database);
    if (!firebaseSources) { firebaseSources = new WeakMap(); photoSources.set(identity.database, firebaseSources); }
    const firebaseKey = identity.firebase || noFirebase;
    let accounts = firebaseSources.get(firebaseKey);
    if (!accounts) { accounts = new Map(); firebaseSources.set(firebaseKey, accounts); }
    const key = JSON.stringify([identity.actor, identity.namespace]);
    if (!accounts.has(key)) {
      const source = { actor: identity.actor, database: identity.database, firebase: identity.firebase, namespace: identity.namespace };
      const session = { resolvePhoto: async id => {
        if (!sameOwner(source)) throw cancelled();
        const ref = source.firebase ? source.firebase.doc('photos/' + id) : source.database.doc('photos/' + id);
        const snapshot = await (source.firebase ? ref.get({ source: 'server' }) : ref.get());
        if (!sameOwner(source)) throw cancelled();
        if (!snapshot || snapshot.exists === false) return null;
        const value = typeof snapshot.data === 'function' ? snapshot.data() : typeof snapshot.data === 'object' ? snapshot.data : snapshot;
        if (!value || typeof value.data !== 'string') return null;
        return { id, ...value, ...(snapshot.id ? { id: snapshot.id } : {}) };
      } };
      accounts.set(key, session);
    }
    return accounts.get(key);
  }
  function ensureOwner() {
    if (sameOwner(owner)) return;
    if (active) abort(active, false);
    abortHistory(); sequence++; historySequence++; owner = context(); prepared = null; historyContext = null; receiptDrafts.clear();
    Object.assign(state, { snapshot: null, package: null, loading: false, preparing: false, downloading: false, error: '', progress: '', history: [], historyRequested: false, historyLoading: false, historyError: '', selectedBatch: '', selectedEntry: '', receiptSaving: false, receiptDraft: { status: 'registered', externalId: '', note: '' } });
  }
  function notify(receipt) {
    if (visible()) api.render();
    if (receipt && visible()) {
      for (const [id, value] of [['rlReceiptEntry', state.selectedEntry], ['rlReceiptStatus', state.receiptDraft.status], ['rlExternalId', state.receiptDraft.externalId], ['rlReceiptNote', state.receiptDraft.note]]) { const el = Q('#' + id); if (el) el.value = value; }
    }
  }
  function finish(job) {
    root.clearInterval(job.timer);
    if (active !== job) return;
    active = null; state.loading = state.preparing = state.downloading = state.receiptSaving = false; state.progress = '';
  }
  function abort(job, redraw = true) {
    if (!job || active !== job) return;
    job.cancelled = true; job.release(); finish(job); sequence++;
    if (redraw && visible()) { state.error = '준비를 취소했어요. 조건을 확인하고 다시 진행할 수 있어요.'; notify(); }
  }
  function begin(kind) {
    ensureOwner();
    if (!api.can('admin')) throw fail('관리자 권한이 필요해요.', 'permission-denied');
    if (!root.DGOffline.ready) throw fail('기기 저장소를 준비한 뒤 다시 시도해 주세요.', 'storage-unavailable');
    if (active) throw fail('자료를 처리하는 중이에요. 취소하거나 잠시 기다려 주세요.', 'bridge-busy');
    const job = { id: ++sequence, context: context(), cancelled: false };
    job.cancellation = new Promise(resolve => { job.release = resolve; }); active = job;
    state.error = ''; state.progress = ''; state[kind] = true;
    job.timer = root.setInterval(() => { if (!valid(job)) abort(job, false); }, 200);
    return job;
  }
  const valid = job => active === job && !job.cancelled && job.id === sequence && current(job.context);
  const check = job => { if (!valid(job)) throw cancelled(); };
  async function wait(job, promise) { const result = await Promise.race([promise, job.cancellation.then(() => { throw cancelled(); })]); check(job); return result; }
  function invalidate() {
    if (active) abort(active, false); sequence++; state.snapshot = null; state.package = null; prepared = null; state.error = ''; state.progress = ''; notify();
  }
  function range() {
    const correct = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
    if (!correct(state.from) || !correct(state.to)) throw new Error('올바른 시작일과 종료일을 입력해 주세요.');
    const from = new Date(state.from + 'T00:00:00+09:00').getTime(), to = new Date(state.to + 'T23:59:59.999+09:00').getTime();
    if (from > to) throw new Error('시작일이 종료일보다 늦어요.'); return { from, to };
  }
  const sourceText = metadata => ({ local: '이 기기 저장 자료', server: '서버 조회 자료', artifact: '공유 저장소 자료', cache: '기기 캐시 자료', mixed: '출처가 섞인 자료', unknown: '자료 출처 미확인' }[metadata.source] || '자료 출처 미확인') + (metadata.complete ? ' · 전체 조회 확인' : ' · 전체 여부 미확인');
  function scoped(input, dong) {
    if (dong === '전체') return input;
    const byId = new Map(input.lights.map(light => [light.id, light]));
    const inDong = row => api.inDong(byId.get(row.lightId) || { dong: row.dong || '' }, dong);
    input.inspections = input.inspections.filter(inDong); input.reports = input.reports.filter(inDong); input.workOrders = input.workOrders.filter(inDong);
    const works = new Set(input.workOrders.map(row => row.id)); input.workEvents = input.workEvents.filter(row => works.has(row.workId) || inDong(row));
    input.patrols = input.patrols.filter(row => row.dong === dong || [...(row.passed || []), ...(row.marks || []).map(mark => mark.id)].some(id => api.inDong(byId.get(typeof id === 'string' ? id : id?.id) || {}, dong)));
    return input;
  }
  async function load() {
    const bounds = range(), job = begin('loading'), metadata = [];
    state.snapshot = null; state.package = null; prepared = null; notify();
    try {
      const request = { requireServer: !!api.firebase(), onPage: () => check(job), onMetadata: value => { check(job); metadata.push(value); } }, selected = TYPES.filter(([key]) => state.types[key]).map(([key]) => key);
      if (!selected.length) throw new Error('전달할 자료를 하나 이상 선택해 주세요.');
      const lights = clone(api.state().allLights || api.state().lights);
      const read = (collection, options) => selected.includes(collection) || collection === 'workEvents' && selected.includes('workOrders') ? api.readAll(collection, { ...request, ...options }) : Promise.resolve([]);
      const [inspections, reports, workOrders, workEvents, patrols] = await wait(job, Promise.all([
        read('inspections', { where: [['date', '>=', bounds.from], ['date', '<=', bounds.to]], orderBy: [['date', 'desc']] }), read('reports'), read('workOrders'),
        read('workEvents', { where: [['at', '>=', bounds.from], ['at', '<=', bounds.to]], orderBy: [['at', 'desc']] }),
        read('patrols', { where: [['start', '>=', bounds.from], ['start', '<=', bounds.to]], orderBy: [['start', 'desc']] })
      ]));
      const sources = [...new Set(metadata.map(value => value.source))], expected = selected.length + (selected.includes('workOrders') ? 1 : 0);
      const source = sources.length === 1 ? sources[0] : sources.length ? 'mixed' : 'unknown';
      const provenance = { source, complete: ['local', 'server'].includes(source) && metadata.length === expected && metadata.every(value => value.complete === true), fetchedAt: Date.now() };
      const input = scoped({ ...bounds, types: selected, dong: state.dong, lights, inspections, reports, workOrders, workEvents, patrols, includePhotos: state.includePhotos, includeContacts: state.includeContacts, provenance }, state.dong);
      Object.assign(input, root.DGRoadlightingCore.selectRecords(input));
      check(job); state.snapshot = { input, context: job.context, at: Date.now(), provenance }; state.progress = '조회 완료';
    } catch (error) { if (active === job && current(job.context)) state.error = error.message || '자료를 조회하지 못했어요.'; }
    finally { finish(job); notify(); }
  }
  const ready = () => !!state.snapshot && current(state.snapshot.context) && !active;
  function historyReplace(value) { state.history = [value, ...state.history.filter(item => item.batchId !== value.batchId)].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)); }
  async function savePackage(job, result) {
    const prior = await wait(job, root.DGOffline.get(KIND, result.batchId)); check(job);
    if (prior && !validLedger(prior)) throw new Error('이 묶음의 기기 연계 이력 형식을 읽지 못했어요. 기존 이력은 덮어쓰지 않았어요.');
    if (prior && prior.contentHash !== result.contentHash) throw new Error('같은 묶음 번호의 내용이 달라요. 다시 조회해 주세요.');
    const value = prior ? { ...prior, updatedAt: Date.now() } : { schemaVersion: 1, batchId: result.batchId, contentHash: result.contentHash, filename: result.filename, createdAt: Date.now(), updatedAt: Date.now(), by: job.context.actor, status: 'prepared', unofficial: true, targetSystem: 'roadlighting', targetTenant: 'gjd', range: { from: state.from, to: state.to, dong: state.dong }, summary: clone(result.summary), entries: clone(result.entries), receipts: {}, provenance: clone(state.snapshot.provenance) };
    check(job); const saved = await wait(job, root.DGOffline.putIfCurrent(KIND, value.batchId, value, prior?.draftRevision ?? null)); historyReplace(saved); return saved;
  }
  async function prepare() {
    if (!ready()) throw new Error('현재 조건의 자료를 먼저 조회해 주세요.');
    const snapshot = state.snapshot, job = begin('preparing'); state.package = null; prepared = null; notify();
    try {
      const photoSession = photoSource(job.context);
      const result = await wait(job, root.DGRoadlightingCore.buildPackage({ ...snapshot.input, generatedAt: Date.now() }, { photoSession, resolvePhoto: photoSession.resolvePhoto, isCurrent: () => valid(job), onProgress: progress => { if (valid(job)) { state.progress = progress.phase === 'photos' ? '사진 준비 ' + progress.done + '/' + progress.total : '전달 파일 구성 중…'; const el = Q('#rlProgress'); if (el) el.textContent = state.progress; } } }));
      check(job); await savePackage(job, result); check(job); state.package = result; prepared = { result, context: job.context }; if (!selectedLedger()) selectBatch(result.batchId, false);
    } catch (error) { if (active === job && current(job.context)) state.error = error.message || '전달 파일을 준비하지 못했어요.'; }
    finally { finish(job); notify(true); }
  }
  async function download() {
    if (!prepared || !current(prepared.context) || !state.package) throw new Error('현재 자료의 전달 묶음을 먼저 준비해 주세요.');
    const result = prepared.result, job = begin('downloading'); notify();
    try {
      check(job); await wait(job, api.download({ filename: result.filename, data: new Blob([result.bytes], { type: 'application/zip' }) })); check(job);
      const prior = await wait(job, root.DGOffline.get(KIND, result.batchId)); if (!validLedger(prior)) throw new Error('연계 이력을 확인하지 못해 다운로드 기록을 보관하지 못했어요. 이력을 새로고침해 주세요.');
      const saved = await wait(job, root.DGOffline.putIfCurrent(KIND, prior.batchId, { ...prior, status: 'exported', exportedAt: Date.now(), updatedAt: Date.now(), exportCount: (prior.exportCount || 0) + 1 }, prior.draftRevision)); historyReplace(saved);
    } catch (error) { if (active === job && current(job.context) && !['cancelled', 'declined', 'bridge-cancelled'].includes(error.code)) state.error = error.message || '파일을 내려받지 못했어요.'; }
    finally { finish(job); notify(); }
  }
  function selectedLedger() { return state.history.find(item => item.batchId === state.selectedBatch); }
  function stashReceipt() { if (state.selectedBatch && state.selectedEntry) receiptDrafts.set(state.selectedBatch + '/' + state.selectedEntry, clone(state.receiptDraft)); }
  function selectBatch(id, redraw = true) {
    stashReceipt();
    state.selectedBatch = id; const ledger = selectedLedger(); state.selectedEntry = ''; chooseEntry(ledger?.entries?.[0]?.key || '', false); if (redraw) notify(true);
  }
  function chooseEntry(key, redraw = true) {
    stashReceipt();
    const ledger = selectedLedger(), receipt = ledger?.receipts?.[key]; state.selectedEntry = key;
    state.receiptDraft = clone(receiptDrafts.get(state.selectedBatch + '/' + key) || { status: receipt?.status || 'registered', externalId: receipt?.externalId || '', note: receipt?.note || '' }); if (redraw) notify(true);
  }
  async function saveReceipt() {
    const ledger = selectedLedger(), entry = ledger?.entries?.find(item => item.key === state.selectedEntry);
    if (!entry) throw new Error('등록 확인을 남길 기록을 선택해 주세요.');
    const draft = clone(state.receiptDraft), text = value => String(value || '').trim(); draft.externalId = text(draft.externalId); draft.note = text(draft.note);
    if (!['registered', 'rejected'].includes(draft.status)) throw new Error('확인 상태를 선택해 주세요.');
    if (draft.status === 'registered' && !draft.externalId) throw new Error('운영 사이트에서 확인한 등록번호를 입력해 주세요.');
    if (draft.status === 'rejected' && !draft.note) throw new Error('미반영·실패 사유를 입력해 주세요.');
    if (draft.externalId.length > 180 || draft.note.length > 2000 || /[\u0000-\u001f\u007f]/.test(draft.externalId)) throw new Error('등록번호는 180자, 사유는 2,000자 이내로 입력해 주세요.');
    const job = begin('receiptSaving'); notify();
    try {
      const previous = ledger.receipts?.[entry.key], at = Date.now();
      const receipt = { ...draft, itemHash: entry.hash, at, by: job.context.actor, verifiedByService: false, events: [...(previous?.events || []), { ...draft, itemHash: entry.hash, at, by: job.context.actor, verifiedByService: false }] };
      const value = { ...ledger, updatedAt: at, receipts: { ...(ledger.receipts || {}), [entry.key]: receipt } };
      check(job); const saved = await wait(job, root.DGOffline.putIfCurrent(KIND, ledger.batchId, value, ledger.draftRevision)); historyReplace(saved);
    } catch (error) { if (active === job && current(job.context)) state.error = error.code === 'conflict' ? '다른 탭에서 연계 이력을 변경했어요. 이력을 새로고침한 뒤 확인하고 다시 기록해 주세요.' : error.message || '등록 확인을 저장하지 못했어요.'; }
    finally { finish(job); notify(); }
  }
  function abortHistory() {
    if (!historyActive) return;
    const job = historyActive; historyActive = null; historySequence++; root.clearInterval(job.timer); job.release(); state.historyRequested = false; state.historyLoading = false;
  }
  function validLedger(value) {
    if (!value || value.schemaVersion !== 1 || typeof value.batchId !== 'string' || typeof value.contentHash !== 'string' || value.targetTenant !== 'gjd' || !value.range || typeof value.range.from !== 'string' || typeof value.range.to !== 'string' || !Array.isArray(value.entries) || !value.receipts || typeof value.receipts !== 'object' || Array.isArray(value.receipts)) return false;
    const keys = new Set();
    for (const item of value.entries) { if (!item || typeof item.key !== 'string' || typeof item.internalId !== 'string' || typeof item.hash !== 'string' || keys.has(item.key)) return false; keys.add(item.key); }
    return Object.entries(value.receipts).every(([key, receipt]) => keys.has(key) && receipt && ['registered','rejected'].includes(receipt.status) && typeof receipt.externalId === 'string');
  }
  async function loadHistory() {
    ensureOwner(); if (!root.DGOffline.ready || !api.can('admin') || !visible()) { state.historyRequested = false; return; }
    abortHistory();
    const identity = context(), token = ++historySequence, job = { identity, token };
    job.cancellation = new Promise(resolve => { job.release = resolve; }); historyActive = job; historyContext = identity;
    state.historyRequested = true; state.historyLoading = true; state.historyError = '';
    job.timer = root.setInterval(() => { if (!current(identity)) abortHistory(); }, 200);
    try {
      const rows = await Promise.race([root.DGOffline.list(KIND), job.cancellation.then(() => { throw cancelled(); })]);
      if (historyActive !== job || token !== historySequence || !current(identity)) return;
      const values = rows.map(row => row.value), invalid = values.filter(value => !validLedger(value));
      state.history = values.filter(validLedger).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      if (invalid.length) state.historyError = '연계 이력 ' + invalid.length + '개의 형식을 읽을 수 없어요. 기기 원본은 삭제하지 않았어요.';
      if (state.selectedBatch && !selectedLedger()) state.selectedBatch = '';
    } catch (error) { if (token === historySequence && current(identity)) state.historyError = error.message || '기기 연계 이력을 읽지 못했어요.'; }
    finally { root.clearInterval(job.timer); if (historyActive === job) { historyActive = null; state.historyLoading = false; notify(); } }
  }
  function receiptView() {
    const ledger = selectedLedger(); if (!ledger) return '';
    const entry = ledger.entries.find(item => item.key === state.selectedEntry), receipt = ledger.receipts?.[state.selectedEntry], draft = state.receiptDraft;
    return '<div class="rl-receipt"><h4>기록별 운영 등록 확인</h4><p class="muted">운영 화면을 확인한 사용자의 기록이에요. 운영 시스템의 응답을 자동 검증하거나 원래 작업 상태를 바꾸지 않아요.</p><label class="f" for="rlReceiptEntry">확인할 기록</label><select class="f-in" id="rlReceiptEntry">' + ledger.entries.map(item => '<option value="' + E(item.key) + '"' + (item.key === state.selectedEntry ? ' selected' : '') + '>' + E((ENTITY_LABELS[item.entity] || '기록') + ' · ' + (item.code || item.internalId) + ' · ' + item.internalId) + '</option>').join('') + '</select>' + (entry ? '<p class="muted small">시설 ID ' + E(entry.lightId || '연결 없음') + ' · 운영 시설번호 ' + E(entry.lampId || '연결 없음') + (entry.statusLabel ? ' · ' + E(entry.statusLabel) : '') + '</p>' : '') + '<div class="grid2"><div><label class="f" for="rlReceiptStatus">확인 상태</label><select class="f-in" id="rlReceiptStatus"><option value="registered"' + (draft.status === 'registered' ? ' selected' : '') + '>사용자 등록 확인</option><option value="rejected"' + (draft.status === 'rejected' ? ' selected' : '') + '>미반영·등록 실패</option></select></div><div><label class="f" for="rlExternalId">운영 등록번호</label><input class="f-in" id="rlExternalId" maxlength="180" value="' + E(draft.externalId) + '" placeholder="운영 화면에서 확인한 번호"></div></div><label class="f" for="rlReceiptNote">확인 메모·실패 사유</label><textarea class="f-in" id="rlReceiptNote" rows="2" maxlength="2000">' + E(draft.note) + '</textarea><div class="split"><button class="btn sodium" data-rl="receipt-save"' + (active ? ' disabled' : '') + '>확인 내용 기록</button>' + (receipt ? '<span class="muted">' + E(api.fmtDT(receipt.at)) + ' · ' + E(receipt.externalId || '미반영') + '</span>' : '') + '</div></div>';
  }
  function previewView(snapshot, pkg, canPrepare, canDownload) {
    const counts = snapshot ? TYPES.filter(([key]) => state.types[key]).map(([key, label]) => [label, snapshot.input[key].length]) : [];
    return '<div class="panel rl-preview"><h4><span class="rl-step">2</span>내용 확인·전달 파일</h4>' +
      (snapshot ? '<div class="rl-counts">' + counts.map(([label, value]) => '<div><b>' + value.toLocaleString() + '</b><span>' + label + '</span></div>').join('') + '</div><p class="muted">' + E(sourceText(snapshot.provenance)) + ' · ' + E(api.fmtDT(snapshot.at)) + '</p>' + (!current(snapshot.context) ? '<p class="notice">조건이나 화면이 바뀌었어요. 다시 조회해 주세요.</p>' : '') : '<p class="muted">위에서 선택한 자료를 조회하면 건수와 출처를 확인할 수 있어요.</p>') +
      '<p class="muted small">시설 고유번호·점검 내용·사진 관계를 담은 ZIP이에요. 운영 업체의 공식 업로드 양식은 아직 확인되지 않아 담당자 검토·수동 등록에 사용해요. 최대 200MB이며 넘으면 기간을 나누거나 사진을 제외해 주세요.</p>' +
      '<div class="split"><button class="btn sodium" data-rl="prepare"' + (!canPrepare ? ' disabled' : '') + '>' + (state.preparing ? '전달 묶음 준비 중…' : '전달 묶음 준비') + '</button><button class="btn ghost" data-rl="download"' + (!canDownload ? ' disabled' : '') + '>ZIP 파일 내보내기</button></div><p id="rlProgress" role="status" class="muted">' + E(state.progress) + '</p>' +
      (pkg ? '<div class="rl-package"><b>전달 묶음 준비됨</b><span>' + E(pkg.batchId) + '</span><p>기록 ' + pkg.entries.length + '건 · 사진 ' + (pkg.summary.photos || 0) + '장' + (pkg.missingPhotos ? ' · 누락 사진 ' + pkg.missingPhotos + '장' : '') + (pkg.fallbackPhotos ? ' · 미리보기 대체 ' + pkg.fallbackPhotos + '장' : '') + (pkg.summary.unmapped ? ' · 운영 시설번호 연결 없음 ' + pkg.summary.unmapped + '건' : '') + '</p></div>' : '') + '</div>';
  }
  function view() {
    ensureOwner(); if (!api.can('admin')) return '<div class="notice">운영 시스템 연계는 관리자만 사용할 수 있어요.</div>';
    if (state.historyRequested && historyContext && !current(historyContext)) { abortHistory(); state.historyRequested = false; }
    if (!state.historyRequested && root.DGOffline.ready) { state.historyRequested = true; root.setTimeout(() => loadHistory(), 0); }
    const snapshot = state.snapshot, pkg = state.package, busy = !!active, canPrepare = ready(), canDownload = !!prepared && current(prepared.context) && !busy;
    return '<section id="dgRoadlightingBridge" class="dg-roadlighting"><div class="rl-intro"><div class="rl-eyebrow">GJD · 현장 자료 전달</div><h3>운영 시스템 연계</h3><p>점검과 사진을 모아 운영 담당자에게 전달하고, 실제 등록 확인을 따로 남겨요.</p><div class="rl-status-line"><span class="rl-tag">비공식 보조 자료</span><span>파일 준비·내보내기는 운영 사이트 등록 완료가 아니에요.</span></div></div><div class="rl-start"><div><b>시설 대장부터 맞추기</b><p class="muted">getPoint.json 원본을 비교하고 현장 수정값을 보존해요.</p><button class="btn ghost" data-rl="registry">운영 대장 가져오기</button></div><a class="btn ghost" href="https://gjd.roadlighting.kr/slamp/" target="_blank" rel="noopener noreferrer">운영 사이트 열기 ↗</a></div><div class="panel"><h4>운영 신고 반입 준비</h4><p class="muted">담당 부서 협의 전, 준비 양식과 합성 자료로 검토·중복 방지·시설 연결을 확인해요.</p><button type="button" class="btn ghost" id="rlExternalReports" data-asec="officialreports">운영 신고 파일 검토</button></div><div class="panel rl-selection"><h4><span class="rl-step">1</span>전달할 자료 선택</h4><div class="grid2"><div><label class="f" for="rlFrom">시작일</label><input class="f-in" type="date" id="rlFrom" value="' + E(state.from) + '"></div><div><label class="f" for="rlTo">종료일</label><input class="f-in" type="date" id="rlTo" value="' + E(state.to) + '"></div></div><label class="f" for="rlDong">시설 동</label><select class="f-in" id="rlDong">' + api.dongOptions(state.dong, '모든 동') + '</select><div class="rl-types">' + TYPES.map(([key, label]) => '<label><input type="checkbox" id="rlType-' + key + '" data-rl-type="' + key + '"' + (state.types[key] ? ' checked' : '') + '>' + label + '</label>').join('') + '</div><div class="rl-options"><label><input type="checkbox" id="rlPhotos"' + (state.includePhotos ? ' checked' : '') + '>사진 포함</label><label><input type="checkbox" id="rlContacts"' + (state.includeContacts ? ' checked' : '') + '>신고 연락처 필드 포함</label></div><p class="muted small">점검은 정상 기록을 포함해요. 보수는 기간 중 생성·변경·완료·검수 기록을 전달해요. 순찰은 선택 동이 포함된 전체 세션이에요. 메모·사진 내용은 전달 전에 확인해 주세요.</p><div class="split"><button class="btn sodium" data-rl="load"' + (busy || !root.DGOffline.ready ? ' disabled' : '') + '>' + (state.loading ? '전체 자료 조회 중…' : '선택한 자료 조회') + '</button>' + (busy ? '<button class="btn ghost" data-rl="cancel">준비 취소</button>' : '') + '</div></div>' + (state.error ? '<div class="notice rl-error" role="alert">' + E(state.error) + '</div>' : '') + previewView(snapshot, pkg, canPrepare, canDownload) + '<div class="panel rl-history"><div class="rl-history-heading"><h4><span class="rl-step">3</span>이 기기의 연계 이력</h4><button class="btn ghost sm" data-rl="history"' + (state.historyLoading || busy ? ' disabled' : '') + '>이력 새로고침</button></div><p class="muted small">이 계정·이 브라우저에 저장해요. 다른 기기로 자동 공유되지 않아요.' + (!root.DGOffline.durable ? ' 현재 창에서만 보관되므로 창을 닫으면 이력이 사라져요.' : '') + '</p>' + (state.historyError ? '<p class="notice" role="alert">' + E(state.historyError) + '</p>' : '') + (state.historyLoading ? '<p role="status">연계 이력 불러오는 중…</p>' : '') + (state.history.length ? '<div class="rl-batches">' + state.history.map(batch => { const receipts = Object.values(batch.receipts || {}), confirmed = receipts.filter(item => item.status === 'registered'); return '<button type="button" class="rl-batch' + (batch.batchId === state.selectedBatch ? ' selected' : '') + '" data-rl="batch" data-id="' + E(batch.batchId) + '"><span><b>' + E(batch.range.from + ' ~ ' + batch.range.to) + '</b><small>' + E(batch.batchId) + '</small></span><span>' + (batch.status === 'exported' ? '파일 내보냄' : '준비됨') + ' · 사용자 등록 확인 ' + confirmed.length + '/' + batch.entries.length + (confirmed.length ? '<small>' + E(confirmed.slice(0, 3).map(item => item.externalId).join(' · ')) + '</small>' : '') + '</span></button>'; }).join('') + '</div>' : '<p class="muted">아직 준비한 전달 묶음이 없어요.</p>') + receiptView() + '</div></section>';
  }
  async function handle(button) {
    ensureOwner(); if (!api.can('admin')) throw new Error('관리자 권한이 필요해요.');
    switch (button.dataset.rl) {
      case 'registry': return api.openSection('registryupdate');
      case 'load': return load(); case 'prepare': return prepare(); case 'download': return download();
      case 'cancel': return abort(active); case 'history': return loadHistory();
      case 'batch': return selectBatch(button.dataset.id); case 'receipt-save': return saveReceipt();
    }
  }
  function attach(contextApi) {
    api = contextApi; if (attached) return; attached = true;
    root.document.addEventListener('click', event => { const button = event.target.closest('[data-rl]'); if (button) Promise.resolve().then(() => handle(button)).catch(error => { if (visible()) { state.error = error.message || '처리하지 못했어요.'; notify(); } }); });
    root.document.addEventListener('change', event => {
      const el = event.target; if (!el.closest('#dgRoadlightingBridge')) return;
      if (el.id === 'rlReceiptEntry') return chooseEntry(el.value);
      if (el.id === 'rlReceiptStatus') { state.receiptDraft.status = el.value; return; }
      if (el.id === 'rlFrom' || el.id === 'rlTo') state[el.id === 'rlFrom' ? 'from' : 'to'] = el.value;
      else if (el.id === 'rlDong') state.dong = el.value;
      else if (el.id === 'rlPhotos') state.includePhotos = el.checked;
      else if (el.id === 'rlContacts') state.includeContacts = el.checked;
      else if (el.dataset.rlType) state.types[el.dataset.rlType] = el.checked;
      else return;
      invalidate();
    });
    root.document.addEventListener('input', event => { if (event.target.id === 'rlExternalId') state.receiptDraft.externalId = event.target.value; if (event.target.id === 'rlReceiptNote') state.receiptDraft.note = event.target.value; });
  }
  root.DGRoadlightingBridge = { attach, view, state, load, prepare, download, loadHistory };
})(globalThis);
