/* Contract-driven ledger preparation. No endpoint, login, network transport or live provider is configured. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./official-report-import-core.js') : root.DGOfficialReportImportCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGOfficialLedgerConnector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';
  const MAX_ROWS = 1000, MAX_PAGES = 50, DAY = 86400000;
  const FIELD_NAMES = ['externalId', 'lampId', 'issue', 'receivedAt', 'sourceStatus'];
  const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
  const fail = (message, code = 'invalid-argument') => { throw Object.assign(new Error(message), { code }); };
  const cancelled = () => Object.assign(new Error('조회 조건이나 화면이 바뀌어 접수대장 수신을 취소했어요.'), { code: 'ledger-cancelled' });
  const own = (value, key) => {
    if (value === null || typeof value !== 'object') return undefined;
    try { const property = Object.getOwnPropertyDescriptor(value, key); return property && Object.hasOwn(property, 'value') ? property.value : undefined; }
    catch (_) { return undefined; }
  };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('조회 기간은 올바른 날짜로 선택해 주세요.');
    const [year, month, day] = value.split('-').map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail('조회 기간의 달력 날짜를 확인해 주세요.');
    const at = Date.parse(value + 'T00:00:00+09:00');
    if (!Number.isSafeInteger(at)) fail('조회 기간을 확인해 주세요.');
    return at;
  }
  function validateQuery(value) {
    try {
      const from = own(value, 'from'), to = own(value, 'to'), fromAt = date(from), toAt = date(to) + DAY - 1;
      if (fromAt > toAt) fail('조회 시작일과 종료일을 확인해 주세요.');
      return Object.freeze({ from, to, fromAt, toAt });
    } catch (_) { fail('조회 시작일과 종료일을 올바른 날짜로 선택해 주세요.'); }
  }
  function path(value) {
    if (!Array.isArray(value) || !value.length || value.length > 8) fail('명세의 항목 경로를 확인해 주세요.');
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const key = own(value, String(i));
      if (!(typeof key === 'string' && key.length > 0 && key.length <= 100 && !/[\u0000-\u001f\u007f]/.test(key) && !FORBIDDEN.has(key)) && !(Number.isSafeInteger(key) && key >= 0)) fail('명세의 항목 경로를 확인해 주세요.');
      out.push(key);
    }
    return Object.freeze(out);
  }
  function at(value, keys) { for (const key of keys) value = own(value, key); return value; }
  function mapping(value, targets) {
    if (!object(value)) fail('명세의 코드 변환표를 확인해 주세요.');
    const keys = Object.keys(value), result = Object.create(null);
    if (!keys.length || keys.length > 100) fail('명세의 코드 변환표를 확인해 주세요.');
    for (const key of keys) {
      const target = own(value, key);
      if (!key || key.length > 100 || /[\u0000-\u001f\u007f]/.test(key) || FORBIDDEN.has(key) || typeof target !== 'string' || !Object.hasOwn(targets, target)) fail('명세의 코드 변환표를 확인해 주세요.');
      result[key] = target;
    }
    return Object.freeze(result);
  }
  function compile(value) {
    try {
      const name = own(value, 'name'), timeEncoding = own(value, 'timeEncoding'), fields = own(value, 'fields');
      if (own(value, 'schemaVersion') !== 1 || typeof name !== 'string' || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) || !['iso', 'epoch-ms', 'epoch-seconds'].includes(timeEncoding) || !object(fields)) fail('연계 명세를 확인해 주세요.');
      const out = { timeEncoding, fields: Object.create(null) };
      for (const key of ['itemsPath', 'totalPath', 'cursorPath', 'completePath']) out[key] = path(own(value, key));
      for (const key of FIELD_NAMES) out.fields[key] = path(own(fields, key));
      out.issueMap = mapping(own(value, 'issueMap'), Core.issues); out.statusMap = mapping(own(value, 'statusMap'), Core.statusLabels);
      Object.freeze(out.fields); return Object.freeze(out);
    } catch (_) { fail('공식 연계 명세의 항목 경로·코드·시각 형식을 확인해 주세요.'); }
  }
  function mapped(value, map) {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) fail('응답의 코드 변환을 확인해 주세요.');
    const key = String(value);
    if (!Object.hasOwn(map, key)) fail('응답의 코드 변환을 확인해 주세요.');
    return map[key];
  }
  function timestamp(value, encoding) {
    if (encoding === 'iso') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('응답 시각의 명시된 형식을 확인해 주세요.');
      return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    if (!Number.isSafeInteger(value) || value <= 0) fail('응답 시각의 명시된 형식을 확인해 주세요.');
    const milliseconds = encoding === 'epoch-seconds' ? value * 1000 : value;
    if (!Number.isSafeInteger(milliseconds)) fail('응답 시각의 범위를 확인해 주세요.');
    return milliseconds;
  }
  function ignoredFields(item, fields) {
    const tree = Object.create(null);
    for (const keys of Object.values(fields)) {
      let node = tree;
      for (let index = 0; index < keys.length; index++) { const key = keys[index]; if (!Object.hasOwn(node, key)) node[key] = { children: Object.create(null), terminal: false }; const entry = node[key]; node = entry.children; if (index === keys.length - 1) entry.terminal = true; }
    }
    const count = (value, node) => {
      if (value === null || typeof value !== 'object') return 0;
      let ignored = 0;
      for (const key of Object.keys(value)) { if (!Object.hasOwn(node, key)) ignored++; else if (!node[key].terminal) ignored += count(own(value, key), node[key].children); }
      return ignored;
    };
    return count(item, tree);
  }
  function convertPage(raw, profile) {
    try {
      const items = at(raw, profile.itemsPath), total = at(raw, profile.totalPath), nextCursor = at(raw, profile.cursorPath), complete = at(raw, profile.completePath);
      if (!Array.isArray(items) || items.length > MAX_ROWS || !Number.isSafeInteger(total) || total < 0 || total > MAX_ROWS || total < items.length || typeof complete !== 'boolean' || (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 512 || /[\u0000-\u001f\u007f]/.test(nextCursor))) || complete !== (nextCursor === null)) fail('응답의 전체 건수와 완료 정보를 확인해 주세요.');
      const rows = [], names = profile.fields; let ignoredFieldCount = 0;
      for (let i = 0; i < items.length; i++) {
        const item = own(items, String(i)); if (!object(item)) fail('응답의 신고 항목을 확인해 주세요.');
        const value = { externalId: at(item, names.externalId), lampId: at(item, names.lampId), issue: mapped(at(item, names.issue), profile.issueMap), receivedAt: timestamp(at(item, names.receivedAt), profile.timeEncoding), sourceStatus: mapped(at(item, names.sourceStatus), profile.statusMap) };
        rows.push(Core.normalizeRows([value])[0]); ignoredFieldCount += ignoredFields(item, names);
      }
      return { rows, ignoredFieldCount, total, nextCursor, complete };
    } catch (_) { fail('수신 응답의 필수 항목·전체 건수·완료 표시를 연계 명세와 대조해 주세요.'); }
  }
  function adaptPage(raw, profile) { return convertPage(raw, compile(profile)); }
  function transportError(error) {
    const status = own(error, 'status') ?? own(error, 'code');
    if ([401, 403, '401', '403'].includes(status)) return Object.assign(new Error('운영기관이 허용한 인증·조회 권한을 확인해 주세요. 인증 확인을 우회하지 않아요.'), { code: 'authentication-required' });
    return Object.assign(new Error('접수대장 수신을 완료하지 못했어요. 승인된 연결 상태를 확인한 뒤 다시 시도해 주세요.'), { code: 'ledger-unavailable' });
  }
  async function collect(queryValue, options = {}) {
    const query = validateQuery(queryValue), profile = compile(own(options, 'profile')), readPage = own(options, 'readPage'), isCurrent = own(options, 'isCurrent'), onProgress = own(options, 'onProgress');
    const timeoutMs = own(options, 'timeoutMs') ?? 5000, maxPages = own(options, 'maxPages') ?? MAX_PAGES, signal = own(options, 'signal');
    if (typeof readPage !== 'function' || typeof isCurrent !== 'function' || onProgress !== undefined && typeof onProgress !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES || signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail('접수대장 수신 인터페이스와 조회 한도를 확인해 주세요.');
    const controller = new AbortController();
    const active = () => { try { return !controller.signal.aborted && isCurrent() === true; } catch (_) { return false; } };
    const check = () => { if (!active()) throw cancelled(); };
    const abort = () => controller.abort(); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    function guarded(action, kind) {
      return new Promise((resolve, reject) => {
        let done = false, timer, interval;
        const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); clearInterval(interval); controller.signal.removeEventListener('abort', onAbort); fn(value); };
        const stop = error => { finish(reject, error); controller.abort(); };
        const onAbort = () => finish(reject, cancelled());
        try { check(); } catch (error) { finish(reject, error); return; }
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => stop(Object.assign(new Error('접수대장 응답 시간이 지나 수신을 취소했어요. 일부 자료는 가져오지 않았어요.'), { code: 'ledger-timeout' })), timeoutMs);
        interval = setInterval(() => { if (!active()) stop(cancelled()); }, Math.min(timeoutMs, 25));
        Promise.resolve().then(() => { check(); return action(); }).then(value => { if (done) return; try { check(); finish(resolve, value); } catch (error) { stop(error); } }, error => { if (done) return; stop(!active() || kind === 'progress' ? cancelled() : transportError(error)); });
      });
    }
    try {
      check(); const rows = [], seenIds = new Set(), cursors = new Set(); let cursor = null, total = null, pages = 0, ignoredFieldCount = 0;
      for (;;) {
        check(); if (pages >= maxPages) fail('조회 페이지 한도를 넘었어요. 기간을 나누어 다시 확인해 주세요.', 'ledger-incomplete');
        const request = Object.freeze({ ...query, cursor, signal: controller.signal });
        const raw = await guarded(() => readPage(request), 'read'); check();
        const response = convertPage(raw, profile); pages++;
        if (total !== null && response.total !== total || !response.complete && !response.rows.length) fail('조회 중 전체 건수나 페이지가 바뀌었어요. 일부 대장으로 완료하지 않아요.', 'ledger-incomplete');
        total = response.total;
        for (const row of response.rows) {
          if (row.receivedAt < query.fromAt || row.receivedAt > query.toAt || seenIds.has(row.externalId)) fail('조회 기간 밖의 신고 또는 반복된 신고번호가 있어요. 전체 대장을 다시 확인해 주세요.', 'ledger-incomplete');
          seenIds.add(row.externalId); rows.push(row);
        }
        if (rows.length > MAX_ROWS || rows.length > total) fail('받은 신고 수와 전체 건수가 맞지 않아요.', 'ledger-incomplete');
        ignoredFieldCount += response.ignoredFieldCount;
        if (onProgress) await guarded(() => onProgress(Object.freeze({ page: pages, received: rows.length, total })), 'progress');
        check();
        if (response.complete) {
          if (rows.length !== total) fail('전체 신고를 받지 못했어요. 일부 대장으로 완료하지 않아요.', 'ledger-incomplete');
          return { rows, ignoredFieldCount, pages, total, complete: true, query };
        }
        if (cursors.has(response.nextCursor)) fail('같은 페이지가 반복되어 수신을 중단했어요.', 'ledger-incomplete');
        cursors.add(response.nextCursor); cursor = response.nextCursor;
      }
    } catch (error) { controller.abort(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  const liveStatus = () => ({ connected: false, reason: '공식 API 명세와 승인된 연결정보가 아직 등록되지 않았어요.' });
  async function queryLive() { fail(liveStatus().reason, 'not-configured'); }
  function createFixture({ lampId, query: input } = {}) {
    const query = validateQuery(input), first = new Date(query.fromAt + 3600000).toISOString(), second = new Date(query.fromAt + 7200000).toISOString();
    const fixtureProfile = { schemaVersion: 1, name: '합성 명세 예제', itemsPath: ['data', 'items'], totalPath: ['data', 'total'], cursorPath: ['data', 'nextCursor'], completePath: ['data', 'complete'], fields: { externalId: ['ticketId'], lampId: ['assetId'], issue: ['fault'], receivedAt: ['received'], sourceStatus: ['state'] }, issueMap: { DARK: 'off', FLICKER: 'flicker' }, statusMap: { NEW: 'received', WORKING: 'processing', DONE: 'completed', CANCELLED: 'cancelled' }, timeEncoding: 'iso' };
    const checked = Core.normalizeRows([{ externalId: 'DEMO-LEDGER-001', lampId, issue: 'off', receivedAt: first, sourceStatus: 'received' }])[0].lampId;
    const item = (ticketId, received, fault, state) => ({ ticketId, assetId: checked, fault, received, state, name: 'LEDGER-PRIVATE-NAME', phone: 'LEDGER-PRIVATE-CONTACT', desc: 'LEDGER-PRIVATE-NOTE', photo: 'LEDGER-PRIVATE-PHOTO' });
    return { profile: fixtureProfile, readPage: async request => {
      if (request.signal?.aborted) throw cancelled();
      if (request.from !== query.from || request.to !== query.to) fail('합성 조회 조건이 바뀌었어요.');
      if (request.cursor === null) return { data: { items: [item('DEMO-LEDGER-001', first, 'DARK', 'NEW')], total: 2, nextCursor: 'demo-page-2', complete: false } };
      if (request.cursor === 'demo-page-2') return { data: { items: [item('DEMO-LEDGER-002', second, 'FLICKER', 'WORKING')], total: 2, nextCursor: null, complete: true } };
      fail('합성 페이지 경로를 확인해 주세요.');
    } };
  }
  return { validateQuery, adaptPage, collect, liveStatus, queryLive, createFixture };
});
