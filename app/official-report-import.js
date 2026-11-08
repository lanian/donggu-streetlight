/* Preparation only: no operating-service transport and no server write queue. */
(function (root) {
  'use strict';
  const SECTION = 'officialreports';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const state = { rows: [], preview: null, selected: new Set(), ignoredFieldCount: 0, shown: 40, busy: false, applying: false, error: '', result: '' };
  Object.assign(state, { ledgerFrom: today.slice(0, 8) + '01', ledgerTo: today, ledgerProgress: '', ledgerSummary: null, source: '' });
  const STATUS = { received: '접수', processing: '처리 중', completed: '완료', cancelled: '취소' };
  const DECISION = { new: '신규', duplicate: '중복 · 제외', unmatched: '시설 미연결', ambiguous: '시설 중복', closed: '원본 종결 · 제외', conflict: '내용 충돌 · 제외' };
  let api, attached = false, owner = null, sequence = 0, activeLedger = null;
  const Q = selector => root.document.querySelector(selector), E = value => api.esc(String(value ?? ''));
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = message => { throw new Error(message); };
  const visible = () => api?.state().asec === SECTION && !!Q('#oirPanel');
  const allowed = () => !!api?.can('admin') && api.state().canWrite === true && api.state().me === 'local' && !api.firebase() && api.database()?.mode === 'local';
  const lights = () => api.state().lights || [];
  const lightSignature = () => JSON.stringify(lights().map(light => [light.id, light.lampId, !!light.removed, light.code, light.dong]));
  function identity() {
    return { actor: api.state().me, db: api.database(), fb: api.firebase(), namespace: root.DGOffline.namespace, navigation: api.navGen?.(), lights: lightSignature(), admin: api.can('admin'), write: api.state().canWrite };
  }
  function same(value) {
    return !!value && value.actor === api.state().me && value.db === api.database() && value.fb === api.firebase() && value.namespace === root.DGOffline.namespace && (value.navigation == null || api.navAlive(value.navigation)) && value.lights === lightSignature() && value.admin === api.can('admin') && value.write === api.state().canWrite;
  }
  function reset() {
    if (activeLedger) { activeLedger.controller.abort(); activeLedger = null; }
    sequence++; Object.assign(state, { rows: [], preview: null, selected: new Set(), ignoredFieldCount: 0, shown: 40, busy: false, applying: false, error: '', result: '', source: '', ledgerProgress: '', ledgerSummary: null });
  }
  function ensureOwner() { if (!same(owner)) { reset(); owner = identity(); } }
  function notify() { if (visible()) api.render(); }
  function requireLocal() { if (!allowed()) fail('연계 준비 기능은 관리자 체험 모드에서만 사용할 수 있어요. 운영 저장소 연결은 담당 부서 협의 뒤 별도로 준비해요.'); }
  function current(value, token) { return token === sequence && same(value) && allowed() && visible(); }
  async function previewRows(parsed, value, token) {
    if (!current(value, token)) return false;
    const reports = await value.db.readAll('reports');
    if (!current(value, token)) return false;
    const preview = root.DGOfficialReportImportCore.plan(parsed.rows, { lights: clone(lights()), reports });
    if (!current(value, token)) return false;
    state.rows = clone(parsed.rows); state.preview = preview; state.ignoredFieldCount = parsed.ignoredFieldCount || 0;
    state.selected = new Set(preview.rows.filter(row => row.decision === 'new').map(row => row.externalId)); state.shown = 40;
    return true;
  }
  async function loadText(text, format) {
    ensureOwner(); if (state.busy) return;
    try { requireLocal(); } catch (error) { state.error = error.message; notify(); return; }
    state.source = 'file'; state.ledgerProgress = ''; state.ledgerSummary = null;
    const token = ++sequence, value = identity(); state.busy = true; state.error = ''; state.result = ''; notify();
    try {
      const parsed = root.DGOfficialReportImportCore.parse(text, format);
      text = '';
      await previewRows(parsed, value, token);
    } catch (error) { if (current(value, token)) { state.rows = []; state.preview = null; state.selected.clear(); state.error = error.message || '준비 양식의 파일 내용을 확인해 주세요.'; } }
    finally { if (current(value, token)) { state.busy = false; notify(); } }
  }
  async function loadFile(file) {
    ensureOwner(); if (state.busy || !file) return;
    try { requireLocal(); } catch (error) { state.error = error.message; notify(); return; }
    state.rows = []; state.preview = null; state.selected.clear(); state.ignoredFieldCount = 0; state.result = '';
    state.source = 'file'; state.ledgerProgress = ''; state.ledgerSummary = null;
    const format = /\.csv$/i.test(file.name || '') ? 'csv' : /\.json$/i.test(file.name || '') ? 'json' : '';
    if (!format) { state.error = 'UTF-8 CSV 또는 JSON 준비 양식을 선택해 주세요.'; notify(); return; }
    if (!Number.isFinite(file.size) || file.size > 2 * 1024 * 1024) { state.error = '파일은 2MiB 이하로 나누어 주세요.'; notify(); return; }
    const token = ++sequence, value = identity(); state.busy = true; state.error = ''; state.result = ''; notify();
    try {
      let text;
      try { text = await file.text(); } catch (_) { throw new Error('파일을 읽지 못했어요. 준비 양식의 UTF-8 파일을 다시 선택해 주세요.'); }
      if (!current(value, token)) return;
      const parsed = root.DGOfficialReportImportCore.parse(text, format); text = '';
      await previewRows(parsed, value, token);
    } catch (error) { if (current(value, token)) { state.rows = []; state.preview = null; state.selected.clear(); state.error = error.message || '파일 내용을 확인해 주세요.'; } }
    finally { if (current(value, token)) { state.busy = false; notify(); } }
  }
  async function apply() {
    ensureOwner(); if (state.busy) return;
    try { requireLocal(); } catch (error) { state.error = error.message; notify(); return; }
    if (!state.preview || !state.selected.size) { state.error = '검토한 신규 신고를 선택해 주세요.'; notify(); return; }
    const token = ++sequence, value = identity(), selected = [...state.selected], selectedKey = JSON.stringify(selected);
    const rows = clone(state.rows); state.busy = true; state.applying = true; state.error = ''; state.result = ''; notify();
    const alive = () => current(value, token) && JSON.stringify([...state.selected]) === selectedKey;
    try {
      const result = await root.DGOfficialReportImportCommands.execute(rows, selected, { db: value.db, firebase: value.fb, actor: value.actor, admin: true, canWrite: true, isCurrent: alive, lights: () => clone(lights()) });
      if (!alive()) return;
      const reports = await value.db.readAll('reports'); if (!alive()) return;
      state.preview = root.DGOfficialReportImportCore.plan(rows, { lights: clone(lights()), reports }); state.selected.clear();
      state.result = '체험 신고함에 ' + result.imported + '건을 가져왔어요.' + (result.duplicates ? ' 이미 있던 ' + result.duplicates + '건은 유지했어요.' : '') + ' 운영서비스에는 연결하거나 전송하지 않았어요.';
    } catch (error) { if (current(value, token)) state.error = error.message || '가져오기를 완료하지 못했어요. 기존 신고는 덮어쓰지 않았어요.'; }
    finally { if (current(value, token)) { state.busy = false; state.applying = false; notify(); } }
  }
  function clear() { ensureOwner(); if (state.applying) return; reset(); owner = identity(); notify(); }
  async function loadLedger(mode = 'live') {
    ensureOwner(); if (state.busy) return;
    const connector = root.DGOfficialLedgerConnector;
    if (mode !== 'fixture') {
      const token = sequence, value = identity();
      try { await connector.queryLive(); }
      catch (_) { if (token === sequence && same(value) && visible()) { state.error = '실제 접수대장 연결정보가 아직 없어요. 담당 부서의 공식 명세와 허용된 연결 경로를 확인한 뒤 연결할 수 있어요.'; notify(); } }
      return;
    }
    try { requireLocal(); } catch (error) { state.error = error.message; notify(); return; }
    state.rows = []; state.preview = null; state.selected.clear(); state.ignoredFieldCount = 0; state.result = ''; state.ledgerSummary = null; state.ledgerProgress = '';
    let query;
    try { query = connector.validateQuery({ from: state.ledgerFrom, to: state.ledgerTo }); }
    catch (error) { state.error = error.message; notify(); return; }
    const token = ++sequence, value = identity(), controller = new AbortController();
    activeLedger = { token, controller }; state.busy = true; state.source = 'ledger-fixture'; state.error = ''; notify();
    const alive = () => current(value, token) && state.ledgerFrom === query.from && state.ledgerTo === query.to && Q('#oirLedgerFrom')?.value === query.from && Q('#oirLedgerTo')?.value === query.to;
    try {
      const active = lights().filter(light => !light.removed && light.lampId !== null && light.lampId !== undefined);
      const light = active.find(item => active.filter(other => String(other.lampId) === String(item.lampId)).length === 1);
      if (!light) fail('유일한 활성 운영 시설번호가 있는 대장이 필요해요.');
      const provider = connector.createFixture({ lampId: String(light.lampId), query });
      const collected = await connector.collect(query, { ...provider, signal: controller.signal, isCurrent: alive, onProgress: progress => {
        if (!alive()) return;
        state.ledgerProgress = '합성 응답 ' + progress.page + '쪽 · ' + progress.received + '/' + progress.total + '건 확인 중'; notify();
      } });
      if (!alive()) return;
      if (!collected || collected.complete !== true || !Array.isArray(collected.rows) || collected.rows.length !== collected.total) fail('전체 접수대장 응답이 확인되지 않아 검토 자료를 만들지 않았어요.');
      if (collected.rows.length) await previewRows({ rows: collected.rows, ignoredFieldCount: collected.ignoredFieldCount }, value, token);
      if (!alive()) return;
      state.ledgerSummary = { pages: collected.pages, total: collected.total, from: query.from, to: query.to, synthetic: true };
      state.ledgerProgress = '합성 응답 ' + collected.pages + '쪽 · ' + collected.total + '건을 모두 확인했어요. 실운영 조회 결과가 아니에요.';
      if (!collected.rows.length) state.result = '선택한 기간의 합성 응답은 0건이에요.';
    } catch (error) {
      if (current(value, token)) { state.rows = []; state.preview = null; state.selected.clear(); state.ledgerSummary = null; state.ledgerProgress = ''; state.error = error.message || '접수대장 연결 검증을 완료하지 못했어요. 일부 결과는 가져오지 않았어요.'; }
    } finally {
      if (activeLedger?.token === token) activeLedger = null;
      if (current(value, token)) { state.busy = false; notify(); }
    }
  }
  function ledgerView(local) {
    return '<div class="panel oir-ledger" id="oirLedgerPanel"><div class="oir-ledger-heading"><h4>실운영 접수대장 연결</h4><span class="oir-tag" id="oirLedgerConnection">연결정보 미등록</span></div><p class="muted">아직 공식 API 명세와 허용된 연결 경로가 없어 실제 조회는 사용할 수 없어요. 협의 후 연결할 기간 조회·전체 수신·항목 변환 흐름을 합성 자료로 확인해요.</p><div class="grid2"><div><label class="f" for="oirLedgerFrom">접수 시작일</label><input type="date" class="f-in" id="oirLedgerFrom" value="' + E(state.ledgerFrom) + '"' + (!local || state.busy ? ' disabled' : '') + '></div><div><label class="f" for="oirLedgerTo">접수 종료일</label><input type="date" class="f-in" id="oirLedgerTo" value="' + E(state.ledgerTo) + '"' + (!local || state.busy ? ' disabled' : '') + '></div></div><div class="split oir-ledger-actions"><button type="button" class="btn ghost" id="oirLedgerQuery" disabled aria-describedby="oirLedgerConnection">실제 접수대장 조회</button><button type="button" class="btn ghost" id="oirLedgerDemo"' + (!local || state.busy ? ' disabled' : '') + '>연계 흐름 확인 (합성 자료)</button></div><p class="muted" id="oirLedgerProgress" role="status" aria-live="polite">' + E(state.ledgerProgress || '전체 응답이 확인된 뒤에만 검토 표를 만들어요. 오류·누락·취소가 있으면 일부 자료를 적용하지 않아요.') + '</p></div>';
  }
  function sample() {
    ensureOwner(); if (state.busy) return;
    try {
      requireLocal();
      const active = lights().filter(light => !light.removed && light.lampId !== null && light.lampId !== undefined);
      const light = active.find(item => active.filter(other => String(other.lampId) === String(item.lampId)).length === 1);
      if (!light) fail('운영 시설번호가 유일하게 연결된 대장이 필요해요. 준비 양식을 내려받아 시설 연결부터 확인해 주세요.');
      return loadText(JSON.stringify({ schemaVersion: 1, reports: [{ external_report_id: 'SAMPLE-REPORT-001', lamp_id: String(light.lampId), issue: 'off', received_at: '2026-11-08T09:00:00+09:00', status: 'received' }] }), 'json');
    } catch (error) { state.error = error.message; notify(); }
  }
  async function downloadTemplate(format) {
    if (!api.can('admin') || !['csv', 'json'].includes(format)) return;
    try { const text = root.DGOfficialReportImportCore.template(format); await api.download({ filename: '운영신고_연계준비양식.' + format, data: new Blob([text], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' }) }); }
    catch (_) { if (visible()) { state.error = '준비 양식을 내려받지 못했어요. 다시 시도해 주세요.'; notify(); } }
  }
  function previewView() {
    const preview = state.preview; if (!preview) return '<p class="empty">합성 예제 또는 준비 양식 파일을 선택하면 신규·중복과 시설 연결을 확인할 수 있어요.</p>';
    const rows = preview.rows, fresh = rows.filter(row => row.decision === 'new').length;
    return '<div id="oirSummary" class="oir-counts" role="status"><span>전체 <b>' + rows.length + '</b>건</span><span>신규 <b>' + fresh + '</b>건</span><span>제외·확인 필요 <b>' + (rows.length - fresh) + '</b>건</span><span>선택 <b>' + state.selected.size + '</b>건</span></div>' +
      '<p class="muted">지정한 업무 열만 사용해요. 연락처·사진·위치·자유 설명 등의 추가 항목 ' + state.ignoredFieldCount + '개는 반입하지 않았어요. 업무 식별자까지 익명화한 자료라는 뜻은 아니에요.</p>' +
      '<div class="split"><button type="button" class="btn ghost sm" id="oirSelectAll"' + (!fresh || state.busy ? ' disabled' : '') + '>신규 전체 선택</button><button type="button" class="btn ghost sm" id="oirSelectNone"' + (state.busy ? ' disabled' : '') + '>선택 해제</button></div>' +
      '<p class="oir-scroll-hint muted">표를 옆으로 밀면 고장 유형과 검토 결과를 볼 수 있어요.</p><div class="oir-table" tabindex="0" role="region" aria-label="신고 파일 검토 표"><table id="oirPreview"><thead><tr><th>선택</th><th>신고번호</th><th>연결 시설</th><th>고장·접수일</th><th>검토 결과</th></tr></thead><tbody>' + rows.slice(0, state.shown).map(row => '<tr><td><input type="checkbox" data-oir-select="' + E(row.externalId) + '" aria-label="신고 ' + E(row.externalId) + ' 선택"' + (row.decision === 'new' && state.selected.has(row.externalId) ? ' checked' : '') + (row.decision !== 'new' || state.busy ? ' disabled' : '') + '></td><td><b>' + E(row.externalId) + '</b><small>원본 ' + E(STATUS[row.sourceStatus] || row.sourceStatus) + '</small></td><td>' + E(row.code || '연결 없음') + '<small>운영 시설번호 ' + E(row.lampId) + '</small></td><td>' + E(row.issue) + '<small>' + E(api.fmtDT(row.receivedAt)) + '</small></td><td><b class="oir-decision" data-decision="' + E(row.decision) + '">' + E(DECISION[row.decision] || row.decision) + '</b><small>' + E(row.reason || '') + '</small></td></tr>').join('') + '</tbody></table></div>' +
      (rows.length > state.shown ? '<button type="button" class="btn ghost block" id="oirMore">더 보기 · ' + (rows.length - state.shown) + '건 남음</button>' : '') +
      '<p class="muted">신규 신고만 이 기기에 「접수」로 생성해요. 기존 신고·보수 작업은 유지하며 운영서비스의 처리 상태를 자동 동기화하지 않아요.</p>';
  }
  function view() {
    ensureOwner(); const local = allowed();
    if (!api.can('admin')) return '<div class="notice">신고 파일 반입 준비는 관리자만 사용할 수 있어요.</div>';
    return '<section id="oirPanel" class="oir-panel"><div class="oir-heading"><span class="oir-tag">연계 준비 · 미연결</span><h3>운영 신고 파일 검토</h3><p>준비 양식으로 신규·중복과 시설 연결을 확인한 뒤 체험 신고함에 가져와요.</p></div>' +
      '<p id="oirNotice" class="notice">' + (local ? '담당 부서 협의 전의 합성 자료 검증 기능이에요. 실서비스에 접속하지 않으며 운영 자료는 협의 후 허용 범위를 확인해 주세요.' : '운영 저장소에서는 파일 검토·가져오기가 잠겨 있어요. 관리자 체험 모드에서만 준비 기능을 시험할 수 있어요.') + '</p>' +
      ledgerView(local) +
      '<div class="panel"><h4>1. 준비 양식 선택</h4><div class="split"><button type="button" class="btn ghost sm" id="oirTemplateCsv">CSV 준비 양식</button><button type="button" class="btn ghost sm" id="oirTemplateJson">JSON 준비 양식</button><button type="button" class="btn ghost sm" id="oirSample"' + (!local || state.busy ? ' disabled' : '') + '>합성 예제로 확인</button></div><label class="f" for="oirFile">신고 파일 (UTF-8 CSV·JSON, 최대 2MiB·1,000건)</label><input class="f-in" type="file" id="oirFile" accept=".csv,.json,text/csv,application/json"' + (!local || state.busy ? ' disabled' : '') + '><details class="oir-format"><summary>준비 양식에 들어가는 항목</summary><p>신고번호, 운영 시설번호, 정해진 고장 유형, 접수시각, 원본 처리 상태를 사용해요. 이 양식은 운영 업체의 공식 반출 규격이 아니에요.</p><p>시설번호가 없거나 여러 시설과 겹치면 반입하지 않아요. 원본 종결·취소와 중복·내용 충돌도 제외해요.</p></details></div>' +
      '<div class="panel"><h4>2. 내용·중복·시설 연결 확인</h4>' + previewView() + '</div>' +
      '<div id="oirError" class="notice oir-error" role="alert"' + (!state.error ? ' hidden' : '') + '>' + E(state.error) + '</div><p id="oirResult" class="notice" role="status"' + (!state.result ? ' hidden' : '') + '>' + E(state.result) + '</p>' +
      '<div class="oir-actions"><button type="button" class="btn sodium" id="oirApply"' + (!local || state.busy || !state.preview || !state.selected.size ? ' disabled' : '') + '>' + (state.busy ? '확인 중…' : '체험 신고함에 가져오기') + '</button><button type="button" class="btn ghost" id="oirClear"' + (state.applying ? ' disabled' : '') + '>' + (state.busy && !state.applying ? '검토 취소' : '검토 비우기') + '</button><button type="button" class="btn ghost" data-asec="roadlighting">운영 시스템 연계로</button></div></section>';
  }
  function attach(value) {
    api = value; if (attached) return; attached = true;
    root.document.addEventListener('change', event => {
      if (['oirLedgerFrom', 'oirLedgerTo'].includes(event.target.id)) {
        if (state.busy || !allowed()) return;
        state[event.target.id === 'oirLedgerFrom' ? 'ledgerFrom' : 'ledgerTo'] = event.target.value;
        if (state.source === 'ledger-fixture') { state.rows = []; state.preview = null; state.selected.clear(); state.result = ''; state.ledgerProgress = ''; state.ledgerSummary = null; state.error = ''; }
        notify(); return;
      }
      if (event.target.id === 'oirFile') { const file = event.target.files?.[0]; event.target.value = ''; loadFile(file); return; }
      if (event.target.matches('[data-oir-select]') && !state.busy && allowed()) { const id = event.target.dataset.oirSelect; if (!state.preview?.rows.some(row => row.externalId === id && row.decision === 'new')) return; event.target.checked ? state.selected.add(id) : state.selected.delete(id); notify(); }
    });
    root.document.addEventListener('click', event => {
      const button = event.target.closest('#oirPanel button'); if (!button) return;
      if (button.id === 'oirTemplateCsv') downloadTemplate('csv');
      else if (button.id === 'oirTemplateJson') downloadTemplate('json');
      else if (button.id === 'oirSample') sample();
      else if (button.id === 'oirLedgerQuery') loadLedger('live');
      else if (button.id === 'oirLedgerDemo') loadLedger('fixture');
      else if (button.id === 'oirApply') apply();
      else if (button.id === 'oirClear') clear();
      else if (button.id === 'oirMore') { state.shown += 40; notify(); }
      else if (!state.busy && allowed() && button.id === 'oirSelectAll') { state.selected = new Set((state.preview?.rows || []).filter(row => row.decision === 'new').map(row => row.externalId)); notify(); }
      else if (!state.busy && button.id === 'oirSelectNone') { state.selected.clear(); notify(); }
    });
  }
  root.DGOfficialReportImport = { attach, view, state, loadFile, loadText, loadLedger, apply, clear, sample, downloadTemplate };
})(globalThis);
