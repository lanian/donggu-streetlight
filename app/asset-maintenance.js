/* Confirmed topology, grouped outages and independent component replacement history. */
(function (root) {
  'use strict';
  const C = root.DGAssetMaintenanceCore, Commands = root.DGAssetMaintenanceCommands, KIND = 'assetDraft', JOB = 'asset-maintenance';
  const state = { attached: false, loaded: false, loading: false, error: '', cabinets: [], circuits: [], links: [], incidents: [], replacements: [], drafts: [], draft: null, search: '', at: 0, complete: false, facilities: {} };
  const keys = { cabinet: 'cabinets', circuit: 'circuits', link: 'links', incident: 'incidents', replacement: 'replacements' };
  const titles = { cabinet: '분전함', circuit: '회로', link: '시설 회로 연결', incident: '집단 장애', replacement: '부품 교체 이력' };
  const Q = selector => document.querySelector(selector), copy = C.clone;
  const ask = (message, options) => root.DGDialog ? root.DGDialog.confirm(message, options) : Promise.resolve(confirm(message));
  let api, attached = false, scope = null, sequence = 0, loadSequence = 0, refSequence = 0, writes = Promise.resolve(), loading = null, reloadRequested = false, unsubscribe;
  const owners = new WeakMap(), versions = new WeakMap();
  const E = value => api.esc(value == null ? '' : value), uid = prefix => root.DGData.newId(prefix);
  const capture = () => ({ api, actor: api.state().me, db: api.database(), fb: api.firebase(), offline: root.DGOffline, namespace: root.DGOffline.namespace });
  const owns = value => value && value.api === api && value.actor === api.state().me && value.db === api.database() && value.fb === api.firebase() && value.offline === root.DGOffline && value.namespace === root.DGOffline.namespace;
  function requireOwner(value) { if (!owns(value)) throw Object.assign(new Error('계정이나 저장소가 바뀌어 이전 작업을 처리하지 않았어요.'), { code: 'account-changed' }); }
  const writable = () => api.can('admin') && (api.state().me === 'local' || !!api.firebase());
  function ownerScope() {
    if (!owns(scope)) { scope = capture(); loadSequence++; refSequence++; loading = null; reloadRequested = false; state.loaded = false; state.loading = false; state.error = ''; state.draft = null; state.drafts = []; state.facilities = {}; for (const name of Object.values(keys)) state[name] = []; }
    return scope;
  }
  const record = (entity, id) => state[keys[entity]].find(row => row.id === id);
  const cabinetName = id => { const row = record('cabinet', id); return row ? row.code + ' · ' + row.label : id ? '확인되지 않은 분전함' : '미연결'; };
  const circuitName = id => { const row = record('circuit', id); return row ? row.code + ' · ' + row.label : id ? '확인되지 않은 회로' : '미연결'; };
  const lightName = id => api.byId(id)?.code || id;
  const name = (entity, row) => entity === 'link' ? lightName(row.lightId) : entity === 'replacement' ? lightName(row.lightId) + ' · ' + C.COMPONENTS[row.component] : row.title || row.code + ' · ' + row.label;
  const date = at => at ? new Date(at + 9 * 3600000).toISOString().slice(0, 10) : '';
  const dateValue = (value, end = false) => value ? Date.parse(value + (end ? 'T23:59:59.999+09:00' : 'T00:00:00+09:00')) : 0;
  const heading = title => '<div class="sheet-head"><div><h3>' + E(title) + '</h3><p class="muted">현장에서 확인한 연결과 이력을 관리해요.</p></div><button class="x" data-close aria-label="닫기">×</button></div>';
  const option = (values, selected, blank = '선택하지 않음') => '<option value="">' + E(blank) + '</option>' + values.map(([id, label]) => '<option value="' + E(id) + '"' + (id === selected ? ' selected' : '') + '>' + E(label) + '</option>').join('');
  function replacementWorkOptions(works, selected) {
    const values = works.map(row => [row.id, row.title || row.id]);
    if (selected && !values.some(([id]) => id === selected)) values.push([selected, '연결된 작업 · ' + selected]);
    return option(values, selected, '연결하지 않음');
  }
  function notify() { api.render(); refreshLightSummary(); }
  function load(force = false) {
    const owner = ownerScope(); if (force) forgetFacilities(); // 새로고침 also re-reads the reused facility summaries
    if (loading) { if (force) reloadRequested = true; return loading; } if (state.loaded && !force) return Promise.resolve(state);
    const request = ++loadSequence, current = () => owns(owner) && request === loadSequence;
    state.loading = true; state.error = '';
    loading = (async () => {
      try {
        do {
          reloadRequested = false; const metadata = [];
          const rows = await Promise.all(Object.entries(C.COLLECTIONS).map(async ([entity, collection]) => [entity, await api.readAll(collection, { requireServer: !!owner.fb, onMetadata: value => metadata.push(value) })]));
          if (!current()) return;
          for (const [entity, values] of rows) state[keys[entity]] = values;
          state.loaded = true; state.at = Date.now(); state.complete = metadata.length ? metadata.every(value => value.complete) : owner.actor === 'local' || !!owner.fb;
          state.drafts = owner.offline.ready ? await owner.offline.list(KIND) : []; if (!current()) return;
        } while (reloadRequested);
      } catch (error) { if (current()) state.error = error.message || '시설 관리 자료를 읽지 못했어요.'; }
      finally { if (current()) { state.loading = false; loading = null; notify(); } }
      return state;
    })();
    return loading;
  }
  function circuitOf(lightId) {
    ownerScope(); if (!state.loaded || state.error) return null;
    const link = state.links.find(row => row.lightId === lightId), circuit = link && record('circuit', link.circuitId);
    return circuit && circuit.cabinetId === link.cabinetId && record('cabinet', link.cabinetId) ? circuit.id : null;
  }
  function summary(entity, row) {
    if (entity === 'cabinet') return row.dong + (row.lat == null ? ' · 위치 미등록' : ' · ' + row.lat + ', ' + row.lng) + (row.disabled ? ' · 사용 종료' : '') + (row.note ? ' · ' + row.note : '');
    if (entity === 'circuit') return cabinetName(row.cabinetId) + (row.disabled ? ' · 사용 종료' : '') + (row.note ? ' · ' + row.note : '');
    if (entity === 'link') return cabinetName(row.cabinetId) + ' / ' + circuitName(row.circuitId) + ' · ' + row.confirmationNote;
    if (entity === 'replacement') return date(row.replacedAt) + ' 교체 · ' + [row.manufacturer, row.model].filter(Boolean).join(' ') + (row.warrantyEnd ? ' · 보증 종료 ' + date(row.warrantyEnd) : ' · 보증일 미등록') + (row.note ? ' · ' + row.note : '');
    return (row.status === 'resolved' ? '복구 확인 완료' : '진행 중') + ' · 시설 ' + row.lightIds.length + '곳 · 복구 확인 ' + row.confirmedLightIds.length + '곳 · 연결 작업 ' + row.workIds.length + '건' + (row.note ? ' · ' + row.note : '') + (row.resolutionNote ? ' · ' + row.resolutionNote : '');
  }
  function list(entity, rows) {
    return '<h3>' + E(titles[entity]) + ' ' + rows.length + '건</h3>' + (rows.length ? rows.slice(0, 80).map(row => '<article class="panel"><b>' + E(name(entity, row)) + '</b><p>' + E(summary(entity, row)) + '</p><p class="muted">' + api.fmtDT(row.updatedAt) + ' · ' + E(api.state().names?.[row.updatedBy] || row.updatedBy) + '</p><button class="btn ghost sm" data-am="edit" data-entity="' + entity + '" data-id="' + E(row.id) + '">' + (writable() && entity !== 'replacement' && !(entity === 'incident' && row.status === 'resolved') ? '확인·수정' : '내용 보기') + '</button></article>').join('') + (rows.length > 80 ? '<p class="muted">처음 80건을 표시해요. 이름·시설 번호로 검색해 범위를 좁혀 주세요.</p>' : '') : '<p class="empty">등록한 자료가 없어요.</p>');
  }
  function view() {
    ownerScope(); if (!state.loaded && !state.loading && !state.error) queueMicrotask(() => load());
    const search = state.search.trim().toLocaleLowerCase(), filter = entity => state[keys[entity]].filter(row => !search || [name(entity, row), summary(entity, row)].join(' ').toLocaleLowerCase().includes(search));
    return '<div id="amList"><div class="panel"><h3>분전함·회로·시설 이력</h3><p>실제 분전함과 회로를 등록한 뒤 시설을 연결해요. 전자식·GPS 같은 점멸기 종류와 구분하며, 연결하지 않은 시설은 미등록으로 남아요.</p><div class="split">' + (writable() ? '<button class="btn sodium" data-am="new-cabinet">분전함 등록</button><button class="btn ghost" data-am="new-circuit">회로 등록</button><button class="btn ghost" data-am="new-link">시설 연결</button><button class="btn ghost" data-am="new-incident">집단 장애 등록</button><button class="btn ghost" data-am="new-replacement">부품 교체 기록</button>' : '') + '<button class="btn ghost" data-am="reload">새로고침</button></div><label class="f" for="amSearch">이름·시설 번호 검색</label><input class="f-in" id="amSearch" type="search" value="' + E(state.search) + '">' + (state.loading ? '<p role="status">시설 관리 자료를 조회하는 중…</p>' : '') + (state.error ? '<p class="notice" role="alert">' + E(state.error) + ' 새로고침 후 다시 확인해 주세요.</p>' : state.at ? '<p class="muted">조회 ' + api.fmtDT(state.at) + (state.complete ? '' : ' · 일부 자료일 수 있음') + '</p>' : '') + '</div>' + (state.drafts.length ? '<div class="panel"><h3>작성 중인 초안</h3>' + state.drafts.map(d => '<p>' + E(titles[d.value.entity]) + ' · ' + E(d.value.data.label || d.value.data.title || lightName(d.value.data.lightId)) + ' <button class="btn ghost sm" data-am="resume" data-id="' + E(d.id) + '">이어쓰기</button></p>').join('') + '</div>' : '') + list('cabinet', filter('cabinet')) + list('circuit', filter('circuit')) + list('link', filter('link')) + list('incident', filter('incident').sort((a, b) => b.updatedAt - a.updatedAt)) + list('replacement', filter('replacement').sort((a, b) => b.replacedAt - a.replacedAt)) + '</div>';
  }
  async function open() { const owner = ownerScope(), gen = api.navGen?.(), request = ++sequence, current = () => owns(owner) && request === sequence && (gen == null || api.navAlive(gen)); await persistActive(); if (!current()) return; await load(true); if (!current()) return; api.navigate(heading('분전함·회로·시설 이력') + view(), { key: 'assets', reopen: open }); }
  function lightBody(lightId) {
    const entry = state.facilities[lightId] || { loading: true }, link = entry.link, rows = entry.replacements || [], label = (row, id, missing) => row ? row.code + ' · ' + row.label : id ? missing : '미연결';
    return '<h3>분전함·회로와 부품 이력</h3>' + (entry.error ? '<p class="notice">' + E(entry.error) + '</p>' : entry.loading ? '<p role="status">연결 정보를 조회하는 중…</p>' : '<p>' + E(link ? label(entry.cabinet, link.cabinetId, '확인되지 않은 분전함') + ' / ' + label(entry.circuit, link.circuitId, '확인되지 않은 회로') + ' · ' + link.confirmationNote : '확인된 분전함·회로 연결이 없어요.') + '</p>') + '<div class="split"><button class="btn ghost sm" data-am="light-history" data-id="' + E(lightId) + '">연결·부품 이력 보기</button>' + (writable() ? '<button class="btn ghost sm" data-am="light-link" data-id="' + E(lightId) + '">회로 연결 확인</button><button class="btn ghost sm" data-am="light-replacement" data-id="' + E(lightId) + '">부품 교체 기록</button>' : '') + '</div>' + (rows.length ? '<p class="muted">최근 교체: ' + E(C.COMPONENTS[rows[0].component] + ' · ' + date(rows[0].replacedAt)) + '</p>' : '');
  }
  // A facility screen needs only that facility's link, its cabinet and circuit, and its replacements. Reading them
  // directly keeps every facility open from loading whole collections that grow toward one record per facility.
  async function loadFacility(lightId) {
    const owner = ownerScope(), entry = { loading: true }; state.facilities[lightId] = entry;
    const current = () => owns(owner) && state.facilities[lightId] === entry, source = owner.fb ? { source: 'server' } : undefined;
    const doc = async path => { const snap = await api.database().doc(path).get(source); return snap && snap.exists !== false && snap.data?.() ? { ...snap.data(), id: path.split('/')[1] } : null; };
    try {
      const [link, replacements] = await Promise.all([doc('assetLinks/' + lightId), api.readAll('assetReplacements', { where: [['lightId', '==', lightId]], requireServer: !!owner.fb })]);
      const [cabinet, circuit] = await Promise.all([link?.cabinetId ? doc('cabinets/' + link.cabinetId) : null, link?.circuitId ? doc('circuits/' + link.circuitId) : null]);
      if (!current()) return; Object.assign(entry, { loading: false, link, cabinet, circuit, replacements: replacements.sort((a, b) => b.replacedAt - a.replacedAt) });
    } catch (error) { if (current()) Object.assign(entry, { loading: false, error: error.message || '연결 정보를 읽지 못했어요.' }); }
    if (current()) refreshLightSummary();
  }
  function forgetFacilities() { state.facilities = {}; for (const el of document.querySelectorAll?.('[data-am-light]') || []) loadFacility(el.dataset.amLight); }
  function lightHTML(lightId) { ownerScope(); if (state.facilities[lightId]?.error) delete state.facilities[lightId]; /* a failed read is retried on the next open */ if (!state.facilities[lightId]) queueMicrotask(() => { if (!state.facilities[lightId]) loadFacility(lightId); }); return '<div class="panel" data-am-light="' + E(lightId) + '">' + lightBody(lightId) + '</div>'; }
  function refreshLightSummary() { for (const el of document.querySelectorAll?.('[data-am-light]') || []) el.innerHTML = lightBody(el.dataset.amLight); }
  function defaults(entity, prefill = {}) {
    if (entity === 'cabinet') return { code: '', label: '', dong: '', lat: null, lng: null, note: '', disabled: false, ...prefill };
    if (entity === 'circuit') return { cabinetId: '', code: '', label: '', note: '', disabled: false, ...prefill };
    if (entity === 'link') return { lightId: '', cabinetId: '', circuitId: '', confirmationNote: '', ...prefill };
    if (entity === 'incident') return { title: '', cabinetId: '', circuitId: '', lightIds: [], reportIds: [], workIds: [], confirmedLightIds: [], status: 'open', note: '', resolutionNote: '', ...prefill };
    return { lightId: '', component: 'lamp', replacedAt: dateValue(date(Date.now())), manufacturer: '', model: '', warrantyEnd: 0, workId: '', note: '', ...prefill };
  }
  function payload(entity, value) { const data = { ...value }; delete data.id; for (const key of C.META) delete data[key]; return C.normalize(entity, data); }
  function editor() { const d = state.draft, el = Q('#amForm'); return d && el && el.dataset.token === d.token ? el : null; }
  function readForm() {
    const d = state.draft, form = editor(); if (!d || !form || d.pending || d.readonly) return d;
    const value = id => Q('#' + id)?.value || '', b = d.data;
    if (['cabinet', 'circuit'].includes(d.entity)) { b.code = value('amCode'); b.label = value('amLabel'); b.note = value('amNote'); b.disabled = !!Q('#amDisabled')?.checked; }
    if (d.entity === 'cabinet') Object.assign(b, { dong: value('amDong'), lat: value('amLat') === '' ? null : Number(value('amLat')), lng: value('amLng') === '' ? null : Number(value('amLng')) });
    if (['circuit', 'link', 'incident'].includes(d.entity)) b.cabinetId = value('amCabinet');
    if (['link', 'incident'].includes(d.entity)) b.circuitId = value('amCircuit');
    if (['link', 'replacement'].includes(d.entity)) {
      const raw = value('amLight').trim(), match = /\[([A-Za-z0-9_-]+)\]$/.exec(raw), exact = (api.state().allLights || api.state().lights || []).filter(light => light.code === raw);
      b.lightId = match ? match[1] : api.byId(raw)?.id || (exact.length === 1 ? exact[0].id : raw);
    }
    if (d.entity === 'link') b.confirmationNote = value('amConfirmation');
    if (d.entity === 'incident') Object.assign(b, { title: value('amTitle'), status: value('amStatus'), note: value('amNote'), resolutionNote: value('amResolution') });
    if (d.entity === 'replacement') Object.assign(b, { component: value('amComponent'), replacedAt: dateValue(value('amReplaced')), manufacturer: value('amManufacturer'), model: value('amModel'), warrantyEnd: dateValue(value('amWarranty'), true), workId: value('amWork'), note: value('amNote') });
    return d;
  }
  function dirty(d) { return !!d && (!!d.pending || JSON.stringify(d.data) !== d.baseline); }
  function writeDraft(d) {
    if (!d || d.readonly || !root.DGOffline.ready) return writes;
    const owner = owners.get(d), snapshot = copy(d); delete snapshot.token; delete snapshot.readonly;
    writes = writes.catch(() => {}).then(async () => {
      requireOwner(owner);
      if (!dirty(snapshot)) { const old = await owner.offline.get(KIND, d.storageId); requireOwner(owner); if (old && versions.get(d) === old.draftRevision) { await owner.offline.removeIfCurrent(KIND, d.storageId, old.draftRevision); versions.set(d, null); } return; }
      let key = d.storageId, expected = versions.get(d) ?? null;
      try { const saved = await owner.offline.putIfCurrent(KIND, key, { ...snapshot, storageId: key }, expected); requireOwner(owner); versions.set(d, saved.draftRevision); d.draftRevision = saved.draftRevision; }
      catch (error) {
        if (error.code !== 'conflict') throw error;
        requireOwner(owner); key = uid('asset-recovery');
        const saved = await owner.offline.putIfCurrent(KIND, key, { ...snapshot, storageId: key }, null); requireOwner(owner); d.storageId = key; d.draftRevision = saved.draftRevision; versions.set(d, saved.draftRevision); api.toast('다른 탭의 초안을 유지하고 현재 입력은 별도 복구 초안으로 보관했어요.');
      }
    });
    return writes;
  }
  const persistActive = () => { const d = readForm(); return d ? writeDraft(d) : writes; };
  function input(id, label, value, type = 'text', attrs = '') { return '<label class="f" for="' + id + '">' + label + '</label><input class="f-in" id="' + id + '" type="' + type + '" value="' + E(value == null ? '' : value) + '" ' + attrs + '>'; }
  const note = (id, label, value, max = 1000) => '<label class="f" for="' + id + '">' + label + '</label><textarea class="f-in" id="' + id + '" maxlength="' + max + '">' + E(value) + '</textarea>';
  function parentForm(d) {
    const b = d.data;
    return '<label class="f" for="amCabinet">분전함</label><select class="f-in" id="amCabinet"' + (d.entity === 'circuit' && d.expectedRevision > 0 ? ' disabled' : '') + '>' + option(state.cabinets.filter(c => !c.disabled || c.id === b.cabinetId).map(c => [c.id, c.code + ' · ' + c.label]), b.cabinetId) + '</select>' + (d.entity === 'circuit' ? '<p class="muted">회로의 분전함은 등록 후 바꾸지 않아요. 연결 정정은 새 회로를 등록한 뒤 시설에서 처리해요.</p>' : '<label class="f" for="amCircuit">회로</label><select class="f-in" id="amCircuit">' + option(state.circuits.filter(c => c.cabinetId === b.cabinetId && (!c.disabled || c.id === b.circuitId)).map(c => [c.id, c.code + ' · ' + c.label]), b.circuitId) + '</select>');
  }
  function lightForm(d) { return input('amLight', '시설 번호 또는 시설 선택', d.data.lightId ? lightName(d.data.lightId) + ' [' + d.data.lightId + ']' : '', 'text', 'list="amLights" autocomplete="off"') + '<datalist id="amLights"></datalist>'; }
  function renderEditor() {
    const d = state.draft; if (!d || !owns(owners.get(d))) return;
    const b = d.data, last = record(d.entity, d.recordId), stale = last && last.revision !== d.expectedRevision;
    let html = '';
    if (['cabinet', 'circuit'].includes(d.entity)) html += input('amCode', titles[d.entity] + ' 번호', b.code, 'text', 'maxlength="100"') + input('amLabel', titles[d.entity] + ' 이름', b.label, 'text', 'maxlength="100"');
    if (d.entity === 'cabinet') html += input('amDong', '행정동', b.dong, 'text', 'maxlength="80"') + '<div class="grid2"><div>' + input('amLat', '위도 (선택)', b.lat, 'number', 'step="any" min="-90" max="90"') + '</div><div>' + input('amLng', '경도 (선택)', b.lng, 'number', 'step="any" min="-180" max="180"') + '</div></div>';
    if (['circuit', 'link', 'incident'].includes(d.entity)) html += parentForm(d);
    if (['link', 'replacement'].includes(d.entity)) html += lightForm(d);
    if (d.entity === 'link') html += note('amConfirmation', '연결을 확인한 근거 / 해제 사유', b.confirmationNote) + '<p class="muted">연결을 해제할 때는 분전함과 회로를 모두 비우고 사유를 남겨 주세요. 점멸기 종류에서 실제 회로를 추정하지 않아요.</p>';
    if (d.entity === 'incident') html += input('amTitle', '장애 제목', b.title, 'text', 'maxlength="120"') + input('amTargetSearch', '시설 검색', d.targetSearch || '', 'search') + '<div id="amTargets"></div><h4>관련 신고·작업</h4><div id="amRefs"></div><label class="f" for="amStatus">전체 장애 상태</label><select class="f-in" id="amStatus">' + [['open', '진행 중'], ['resolved', '전체 복구 확인']].map(([value, label]) => '<option value="' + value + '"' + (b.status === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select><div id="amConfirmations"></div>' + note('amResolution', '전체 복구 확인 내용', b.resolutionNote) + '<p class="muted">연결된 작업의 검수가 끝나고 모든 시설의 복구를 확인해야 완료돼요. 시설 상태·신고·자재 재고는 여기서 자동 변경하지 않아요.</p>';
    if (d.entity === 'replacement') html += '<label class="f" for="amComponent">교체 부품</label><select class="f-in" id="amComponent">' + Object.entries(C.COMPONENTS).map(([key, label]) => '<option value="' + key + '"' + (b.component === key ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>' + input('amReplaced', '교체한 날짜', date(b.replacedAt), 'date') + input('amManufacturer', '제조사 (선택)', b.manufacturer, 'text', 'maxlength="100"') + input('amModel', '모델 (선택)', b.model, 'text', 'maxlength="100"') + input('amWarranty', '보증 종료일 (선택)', date(b.warrantyEnd), 'date') + '<label class="f" for="amWork">관련 보수 작업 (선택)</label><select class="f-in" id="amWork">' + replacementWorkOptions([], b.workId) + '</select><p class="muted">이력만 기록하며 재고를 차감하지 않아요. 잘못 기록한 이력은 별도의 정정 이력으로 남겨 주세요.</p>';
    if (['cabinet', 'circuit', 'incident', 'replacement'].includes(d.entity)) html += note('amNote', d.entity === 'incident' ? '장애 내용' : '내용 / 메모', b.note, d.entity === 'incident' ? 1500 : 1000);
    if (['cabinet', 'circuit'].includes(d.entity) && d.expectedRevision > 0) html += '<label class="f"><input id="amDisabled" type="checkbox"' + (b.disabled ? ' checked' : '') + '> 사용 종료 (기록은 유지)</label>';
    api.navigate(heading(titles[d.entity] + (d.readonly ? ' 보기' : d.expectedRevision ? ' 확인·수정' : ' 등록')) + '<div class="panel" id="amForm" data-token="' + E(d.token) + '"><fieldset style="border:0;padding:0;margin:0;min-width:0"' + (d.pending || d.readonly ? ' disabled' : '') + '>' + html + (!d.readonly ? '<button class="btn sodium block" data-am="save">저장</button>' : '') + '</fieldset><div id="amSaveState" role="status">' + (d.error ? '<p class="notice">' + E(d.error) + '</p>' : '') + (d.pending ? '<p class="notice">저장 대기함에서 처리 결과를 확인해 주세요.</p><button class="btn ghost" data-am="check">저장 결과 확인</button>' : '') + '</div>' + (stale || d.error ? '<details><summary>최신 저장 내용 확인</summary><p>' + E(last ? name(d.entity, last) + ' · ' + summary(d.entity, last) : '최신 자료를 다시 조회해 주세요.') + '</p></details><button class="btn ghost block" data-am="rebase">최신 자료와 비교 후 입력 유지</button>' : '') + (!d.readonly ? '<button class="btn ghost block" data-am="discard-draft">수정 초안 버리기</button>' : '') + '</div>', { key: 'asset:' + d.entity + ':' + d.recordId, reopen: () => resumeDraft(d.storageId, d) });
    if (d.entity === 'incident') renderTargets(); if (['incident', 'replacement'].includes(d.entity)) loadReferences(d).catch(error => { if (state.draft === d && editor()) Q('#amRefs') && (Q('#amRefs').textContent = error.message); });
    if (Q('#amLights')) fillLightChoices();
  }
  async function edit(entity, recordId, prefill = {}, resumed) {
    const owner = ownerScope(), request = ++sequence, gen = api.navGen?.(), current = () => request === sequence && owns(owner) && (gen == null || api.navAlive(gen));
    // A confirmed save may still be cleaning its draft while the next editor opens.
    // Join an in-flight read with a fresh pass so old circuit options cannot win.
    await persistActive(); if (!current()) return; await load(true); if (!current()) return;
    const old = recordId && record(entity, recordId); if (recordId && !old && !prefill.lightId && !resumed) throw new Error('자료를 찾을 수 없어요. 새로고침 후 다시 확인해 주세요.');
    const id = recordId || uid('asset-' + entity), stored = resumed || await root.DGOffline.get(KIND, entity + '-' + id); if (!current()) return;
    const data = old ? payload(entity, old) : defaults(entity, prefill);
    const d = stored?.actor === owner.actor && stored.entity === entity && stored.recordId === id ? copy(stored) : { actor: owner.actor, entity, recordId: id, storageId: entity + '-' + id, expectedRevision: old?.revision || 0, data, baseline: JSON.stringify(data), pending: '', error: '' };
    d.token = String(++sequence); d.readonly = !writable() || !!old && (entity === 'replacement' || entity === 'incident' && old.status === 'resolved');
    owners.set(d, owner); versions.set(d, stored?.draftRevision || null); state.draft = d; state.references = { works: [], reports: [] }; renderEditor();
  }
  function fillLightChoices() {
    const el = Q('#amLight'), box = Q('#amLights'); if (!el || !box) return;
    const value = el.value.trim().toLowerCase(); box.innerHTML = (api.state().allLights || api.state().lights || []).filter(light => !light.removed && (!value || light.code.toLowerCase().includes(value) || light.id === value)).slice(0, 80).map(light => '<option value="' + E(light.code + ' [' + light.id + ']') + '"></option>').join('');
  }
  function renderTargets() {
    const d = state.draft, box = Q('#amTargets'), conf = Q('#amConfirmations'); if (!d || d.entity !== 'incident' || !box) return;
    const search = d.targetSearch || '', b = d.data;
    const available = (api.state().allLights || api.state().lights || []).filter(light => !light.removed && (!b.circuitId || state.links.some(link => link.lightId === light.id && link.circuitId === b.circuitId && link.cabinetId === b.cabinetId)) && (!search || [light.code, light.id, light.dong].join(' ').includes(search)));
    const selected = b.lightIds.map(id => api.byId(id) || { id, code: id }); const rows = [...new Map([...selected, ...available.slice(0, 40)].map(light => [light.id, light])).values()];
    box.innerHTML = '<p class="muted">선택 ' + b.lightIds.length + '곳 · 검색 대상 ' + available.length + '곳 · 처음 40곳과 선택한 시설을 표시해요.</p>' + rows.map(light => '<label class="f"><input type="checkbox" data-am-pick="' + E(light.id) + '"' + (b.lightIds.includes(light.id) ? ' checked' : '') + '> ' + E(light.code) + '</label>').join('');
    if (conf) conf.innerHTML = '<h4>시설별 복구 확인</h4>' + b.lightIds.map(id => '<label class="f"><input type="checkbox" data-am-confirm="' + E(id) + '"' + (b.confirmedLightIds.includes(id) ? ' checked' : '') + '> ' + E(lightName(id)) + ' 현장 복구 확인</label>').join('');
  }
  async function loadReferences(d) {
    const owner = owners.get(d), request = ++refSequence, targets = d.entity === 'incident' ? d.data.lightIds.slice() : [d.data.lightId].filter(Boolean);
    const current = () => owns(owner) && request === refSequence && state.draft === d && !!editor();
    const works = [], reports = [];
    for (let at = 0; at < targets.length; at += 10) {
      const where = [['lightId', 'in', targets.slice(at, at + 10)]];
      works.push(...await api.readAll('workOrders', { where, requireServer: !!owner.fb })); if (!current()) return;
      if (d.entity === 'incident') { reports.push(...await api.readAll('reports', { where, requireServer: !!owner.fb })); if (!current()) return; }
    }
    if (!current()) return;
    state.references = { works, reports };
    if (d.entity === 'replacement') { const el = Q('#amWork'); if (el) el.innerHTML = replacementWorkOptions(works, d.data.workId); return; }
    const box = Q('#amRefs'); if (box) box.innerHTML = ['reports', 'works'].map(key => '<h5>' + (key === 'reports' ? '관련 신고' : '관련 작업') + '</h5>' + state.references[key].map(row => '<label class="f"><input type="checkbox" data-am-ref="' + key + '" data-id="' + E(row.id) + '"' + ((key === 'reports' ? d.data.reportIds : d.data.workIds).includes(row.id) ? ' checked' : '') + '> ' + E(row.title || row.issue || lightName(row.lightId)) + (row.status ? ' · ' + E(root.DGOperationsCore.STATES[row.status] || row.status) : '') + '</label>').join('')).join('');
  }
  async function removeDraft(d) {
    const owner = owners.get(d); await writes.catch(() => {}); requireOwner(owner);
    const saved = await owner.offline.get(KIND, d.storageId); requireOwner(owner);
    if (saved && saved.pending === d.pending) await owner.offline.removeIfCurrent(KIND, d.storageId, versions.get(d) || saved.draftRevision);
    requireOwner(owner); if (state.draft === d) state.draft = null;
  }
  async function save(button) {
    const d = readForm(), form = editor(); if (!d || !form || d.pending || d.readonly || !writable()) return;
    const owner = owners.get(d), token = d.token, navigationSequence = sequence;
    const data = C.normalize(d.entity, d.data), job = { id: uid('asset-operation'), entity: d.entity, recordId: d.recordId, expectedRevision: d.expectedRevision, data, actor: owner.actor, at: Date.now() };
    if (['cabinet', 'circuit'].includes(d.entity) && data.disabled) {
      // A retired cabinet/circuit cannot parent an outage update, so an open outage would become unresolvable.
      button.disabled = true;
      try { await load(true); } finally { if (button.isConnected) button.disabled = false; }
      requireOwner(owner); if (sequence !== navigationSequence || Q('#amForm')?.dataset.token !== token) return;
      const open = C.openIncidentsOn(d.entity, d.recordId, state.incidents);
      if (open.length) { d.error = '열린 장애 ' + open.length + '건(' + open.slice(0, 3).map(row => row.title || row.id).join(', ') + (open.length > 3 ? ' 외' : '') + ')이 연결돼 있어 사용 종료할 수 없어요. 장애를 먼저 복구 처리해 주세요.'; await writeDraft(d); requireOwner(owner); if (Q('#amForm')?.dataset.token === token) renderEditor(); return; }
    }
    d.pending = job.id; d.error = ''; await writeDraft(d); requireOwner(owner); form.querySelector('fieldset').disabled = true; button.disabled = true;
    try {
      const result = await owner.offline.submit(JOB, job, { id: job.id, summary: titles[d.entity] + ' · ' + (data.label || data.title || lightName(data.lightId)) }); requireOwner(owner);
      if (result.state === 'synced') { await removeDraft(d); await load(true); if (owns(owner) && sequence === navigationSequence && Q('#amForm')?.dataset.token === token) await open(); api.toast('시설 관리 기록을 저장했어요.'); }
      else { d.error = result.error || '저장 대기함에서 전송 결과를 확인해 주세요.'; await writeDraft(d); await load(true); if (owns(owner) && sequence === navigationSequence && Q('#amForm')?.dataset.token === token) renderEditor(); }
    } catch (error) {
      if (!owns(owner)) return;
      const job = (await owner.offline.jobs()).find(value => value.id === d.pending); requireOwner(owner); if (!job) d.pending = ''; d.error = error.message; await writeDraft(d);
      if (sequence === navigationSequence && Q('#amForm')?.dataset.token === token) renderEditor();
    }
  }
  async function checkPending(rebase = false) {
    const d = readForm(); if (!d) return; const owner = owners.get(d), token = d.token;
    const jobs = await owner.offline.jobs(); requireOwner(owner); const job = jobs.find(value => value.id === d.pending);
    if (job && ['queued', 'sending'].includes(job.state)) return api.toast('저장 작업의 전송 결과를 먼저 확인해 주세요.');
    if (job?.state === 'synced') { await removeDraft(d); if (owns(owner) && Q('#amForm')?.dataset.token === token) await open(); return; }
    await load(true); requireOwner(owner); if (Q('#amForm')?.dataset.token !== token) return;
    const latest = record(d.entity, d.recordId);
    if (rebase && await ask('최신 저장 내용을 확인했나요? 지금 입력은 유지하고 최신 자료를 기준으로 다시 저장해요.', { ok: '입력 유지하고 다시 수정' })) {
      requireOwner(owner); if (job) await owner.offline.discard(job.id); requireOwner(owner);
      d.pending = ''; d.expectedRevision = latest?.revision || 0; d.error = ''; await writeDraft(d); requireOwner(owner);
    } else d.error = job?.error || '최신 저장 내용과 입력을 비교해 주세요.';
    if (Q('#amForm')?.dataset.token === token) renderEditor();
  }
  async function resumeDraft(id, memory) {
    const owner = ownerScope(), gen = api.navGen?.(); await writes.catch(() => {}); requireOwner(owner);
    const value = memory || await owner.offline.get(KIND, id); requireOwner(owner); if (gen != null && !api.navAlive(gen)) return;
    if (!value || value.actor !== owner.actor) return api.toast('이 계정의 초안을 찾지 못했어요.');
    return edit(value.entity, value.recordId, value.data, { ...value, storageId: id });
  }
  async function discardDraft(id, options = {}) {
    const owner = ownerScope(), d = state.draft?.storageId === id ? readForm() : null;
    const stored = d || await owner.offline.get(KIND, id); requireOwner(owner); if (!stored || stored.actor !== owner.actor) return false;
    const job = stored.pending && (await owner.offline.jobs()).find(row => row.id === stored.pending); requireOwner(owner);
    if (job && ['queued', 'sending'].includes(job.state)) { api.toast('전송 중이거나 대기 중인 기록은 결과를 먼저 확인해 주세요.'); return false; }
    if (!options.confirmed && !await ask('입력한 시설 관리 초안을 버릴까요? 이미 저장된 시설과 이력은 유지돼요.', { ok: '초안 버리기', danger: true })) return false;
    requireOwner(owner); if (job && ['failed', 'conflict'].includes(job.state)) await owner.offline.discard(job.id); requireOwner(owner);
    const target = d || stored; if (!d) { owners.set(target, owner); versions.set(target, stored.draftRevision); }
    await removeDraft(target); return true;
  }
  async function handle(button) {
    const action = button.dataset.am;
    if (action === 'reload') return open();
    if (action.startsWith('new-')) return edit(action.slice(4));
    if (action === 'edit') return edit(button.dataset.entity, button.dataset.id);
    if (action === 'save') return save(button);
    if (action === 'check' || action === 'rebase') return checkPending(action === 'rebase');
    if (action === 'resume') return resumeDraft(button.dataset.id);
    if (action === 'discard-draft') { const d = state.draft, token = d?.token; if (d && await discardDraft(d.storageId) && Q('#amForm')?.dataset.token === token) return open(); return; }
    if (action === 'light-link') return edit('link', button.dataset.id, { lightId: button.dataset.id });
    if (action === 'light-replacement') return edit('replacement', null, { lightId: button.dataset.id });
    if (action === 'light-history') { await open(); const el = Q('#amSearch'); if (el) { state.search = lightName(button.dataset.id); el.value = state.search; api.navigate(heading('시설 연결·부품 이력') + view(), { key: 'assets:light:' + button.dataset.id, reopen: () => handle(button) }); } }
  }
  async function ready() { ownerScope(); if (!root.DGOffline.ready) return; state.drafts = await root.DGOffline.list(KIND); }
  function attach(context) {
    api = context; state.attached = true;
    root.DGOffline.register(JOB, job => Commands.execute(job, { db: api.database(), fb: api.firebase(), user: api.state().me, admin: api.can('admin'), byId: api.byId }));
    if (attached) return; attached = true;
    document.addEventListener('click', event => { const button = event.target.closest('[data-am]'); if (button) Promise.resolve().then(() => handle(button)).catch(error => api.toast(error.message || '처리하지 못했어요.')); });
    document.addEventListener('input', event => {
      if (event.target.id === 'amSearch') { state.search = event.target.value; const caret = event.target.selectionStart; api.navigate(heading('분전함·회로·시설 이력') + view(), { key: 'assets', reopen: open, replace: true }); Q('#amSearch')?.focus(); Q('#amSearch')?.setSelectionRange(caret, caret); return; }
      const d = state.draft; if (!d || !editor() || d.pending || d.readonly || !event.target.closest('#amForm')) return;
      readForm(); if (event.target.id === 'amTargetSearch') { d.targetSearch = event.target.value; renderTargets(); } if (event.target.id === 'amLight') fillLightChoices(); writeDraft(d).catch(error => api.toast(error.message));
    });
    document.addEventListener('change', event => {
      const d = state.draft; if (!d || !editor() || d.pending || d.readonly || !event.target.closest('#amForm')) return;
      readForm(); const el = event.target;
      if (el.id === 'amCabinet' && d.entity !== 'circuit') { d.data.circuitId = ''; const select = Q('#amCircuit'); if (select) select.innerHTML = option(state.circuits.filter(row => row.cabinetId === d.data.cabinetId && !row.disabled).map(row => [row.id, row.code + ' · ' + row.label]), ''); }
      if (el.dataset.amPick) { const values = new Set(d.data.lightIds); el.checked ? values.add(el.dataset.amPick) : values.delete(el.dataset.amPick); d.data.lightIds = [...values]; d.data.confirmedLightIds = d.data.confirmedLightIds.filter(id => values.has(id)); renderTargets(); }
      if (el.dataset.amConfirm) { const values = new Set(d.data.confirmedLightIds); el.checked ? values.add(el.dataset.amConfirm) : values.delete(el.dataset.amConfirm); d.data.confirmedLightIds = [...values]; }
      if (el.dataset.amRef) { const key = el.dataset.amRef === 'works' ? 'workIds' : 'reportIds', values = new Set(d.data[key]); el.checked ? values.add(el.dataset.id) : values.delete(el.dataset.id); d.data[key] = [...values]; }
      if (d.entity === 'incident' && (el.id === 'amCabinet' || el.id === 'amCircuit')) renderTargets();
      if ((d.entity === 'incident' && el.dataset.amPick) || (d.entity === 'replacement' && el.id === 'amLight')) loadReferences(d).catch(error => api.toast(error.message));
      writeDraft(d).catch(error => api.toast(error.message));
    });
    unsubscribe = root.DGOffline.subscribe(event => { if (event.type === 'synced' && event.job?.kind === JOB) forgetFacilities(); /* a queued asset save was sent later */ if (['ready', 'draft', 'removed', 'discarded', 'synced', 'cleared'].includes(event.type)) { const owner = ownerScope(); owner.offline.list(KIND).then(values => { if (owns(owner)) state.drafts = values; }).catch(() => {}); } });
  }
  root.DGAssetMaintenance = { attach, ready, load, view, open, edit, lightHTML, circuitOf, persistActive, hasActiveDraft: () => dirty(readForm()), resumeDraft, discardDraft, state, KIND, JOB };
})(globalThis);
