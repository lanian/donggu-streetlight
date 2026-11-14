/* Unofficial, file-based handoff. This module never sends records or changes operational state. */
(function (root, factory) {
  const crypto = typeof module === 'object' && module.exports ? require('node:crypto').webcrypto : root.crypto;
  const api = factory(root, crypto);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGRoadlightingCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, crypto) {
  'use strict';
  const encoder = new TextEncoder(), TYPES = ['inspections', 'reports', 'workOrders', 'patrols'];
  const STATES = { draft: '배정 대기', assigned: '배정됨', in_progress: '작업 중', completed: '검수 대기', verified: '완료', cancelled: '취소' };
  const MAX_BYTES = 200 * 1024 * 1024, MAX_FILES = 65535, PHOTO_WAIT = 8000;
  // Only in-flight requests are shared. An opaque owner token must remain stable across retries and change with the account/backend.
  const photoSessions = new WeakMap();
  const fail = (message, code = 'invalid-argument') => { throw Object.assign(new Error(message), { code }); };
  const string = value => value == null ? '' : String(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const time = value => typeof value === 'number' && Number.isFinite(value) ? value : value && typeof value.seconds === 'number' && Number.isFinite(value.seconds) ? value.seconds * 1000 + (Number(value.nanoseconds) || 0) / 1e6 : null;
  const canonical = value => value == null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const sorted = rows => rows.slice().sort((a, b) => compare(string(a.internalId), string(b.internalId)));
  function identifier(value, label) {
    if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) fail((label || '기록') + ' 식별자를 확인해 주세요.');
    return value;
  }
  function safeValue(value) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.map(safeValue);
    if (typeof value === 'object') {
      const result = {};
      for (const key of Object.keys(value).sort()) if (!['__proto__', 'prototype', 'constructor'].includes(key) && typeof value[key] !== 'function' && value[key] !== undefined) Object.defineProperty(result, key, { value: safeValue(value[key]), enumerable: true, configurable: true, writable: true });
      return result;
    }
    return null;
  }
  const STRUCTURED = {
    parts: ['id', 'inventoryId', 'name', 'qty', 'quantity', 'unitCost', 'unit'],
    measurements: ['lux', 'at', 'by', 'note'],
    marks: ['id', 'code', 'result', 'at', 'pos'],
    spots: ['id', 'lat', 'lng', 'acc', 'fixAt', 'at', 'near', 'nearD']
  };
  const TIME_FIELDS = new Set(['date', 'at', 'fixAt', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'verifiedAt', 'cancelledAt', 'dueAt', 'reviewedAt', 'start', 'end']);
  function fieldValue(key, value) {
    if (TIME_FIELDS.has(key)) return time(value);
    if (STRUCTURED[key]) return (Array.isArray(value) ? value : []).filter(item => item && typeof item === 'object' && !Array.isArray(item)).map(item => take(item, STRUCTURED[key]));
    if (['reportIds', 'passed', 'faults'].includes(key)) return (Array.isArray(value) ? value : []).filter(item => typeof item === 'string');
    if (key === 'track') return (Array.isArray(value) ? value : []).filter(Array.isArray).map(point => point.map(number => typeof number === 'number' && Number.isFinite(number) ? number : null));
    if (key === 'pos') return Array.isArray(value) ? value.map(number => typeof number === 'number' && Number.isFinite(number) ? number : null) : null;
    if (key === 'checks') return Object.fromEntries(['lamp', 'flicker', 'fixture', 'pole', 'base', 'cabinet', 'leak', 'tree'].filter(field => value && own(value, field) && ['string', 'boolean', 'number'].includes(typeof value[field])).map(field => [field, safeValue(value[field])]));
    return value == null || ['string', 'number', 'boolean'].includes(typeof value) ? safeValue(value) : null;
  }
  function take(row, fields) { const result = {}; for (const key of fields) if (own(row, key) && row[key] !== undefined) result[key] = fieldValue(key, row[key]); return result; }
  function unique(rows, entity) {
    if (!Array.isArray(rows)) fail(entity + ' 자료 배열을 확인해 주세요.');
    const seen = new Set();
    return rows.map(row => { if (!row || typeof row !== 'object' || Array.isArray(row)) fail(entity + ' 기록 형식을 확인해 주세요.'); const id = identifier(row.id, entity); if (seen.has(id)) fail('중복 기록 ID가 있어요: ' + entity + '/' + id); seen.add(id); return row; });
  }
  function check(deps) {
    if (typeof deps.isCurrent === 'function') { let current = false; try { current = !!deps.isCurrent(); } catch (_) {} if (!current) fail('계정·화면이나 조회 조건이 바뀌어 전달 자료 준비를 취소했어요.', 'bridge-cancelled'); }
  }
  async function hash(value, deps) {
    check(deps);
    if (!crypto?.subtle) fail('전달 자료를 확인하려면 HTTPS 연결을 사용해 주세요.', 'unsupported-backend');
    const bytes = value instanceof Uint8Array ? value : encoder.encode(typeof value === 'string' ? value : canonical(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes); check(deps);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const jsonBytes = value => encoder.encode(JSON.stringify(value, null, 2) + '\n');
  const csvCell = value => {
    let result = value == null ? '' : typeof value === 'object' ? canonical(value) : string(value);
    if (typeof value !== 'number' && /^[\s\uFEFF]*[=+\-@\t\r]/.test(result)) result = "'" + result;
    return '"' + result.replace(/"/g, '""') + '"';
  };
  function csv(columns, rows) { return encoder.encode('\ufeff' + [columns.map(column => column[0]), ...rows.map(row => columns.map(column => row[column[1]]))].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'); }
  function picture(value) {
    if (typeof value !== 'string') return null;
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
    if (!match || !match[2] || match[2].length % 4 !== 0 || match[2].length * .75 > MAX_BYTES) return null;
    let raw; try { raw = root.atob(match[2]); } catch (_) { return null; }
    const bytes = Uint8Array.from(raw, char => char.charCodeAt(0)), mime = match[1].toLowerCase();
    const valid = mime === 'png' ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) : mime === 'jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.length >= 12 && raw.slice(0, 4) === 'RIFF' && raw.slice(8, 12) === 'WEBP';
    return valid ? { bytes, mime: 'image/' + mime, extension: mime === 'jpeg' ? 'jpg' : mime } : null;
  }
  const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let n = 0; n < 8; n++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; return value >>> 0; });
  function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
  function zipStore(files, limit) {
    if (files.length > MAX_FILES) fail('사진 파일이 너무 많아요. 기간이나 자료 종류를 나눠 주세요.', 'package-too-large');
    let total = 22;
    const prepared = files.map(file => {
      if (!file.path || /(?:^|\/)\.\.(?:\/|$)|\\|^\/|[\u0000-\u001f]/.test(file.path)) fail('전달 파일 경로가 올바르지 않아요.');
      const name = encoder.encode(file.path); if (name.length > 65535) fail('전달 파일 이름이 너무 길어요.');
      total += file.bytes.length + 30 + name.length + 46 + name.length;
      return { ...file, name, crc: crc32(file.bytes) };
    });
    if (total > limit || total > 0xffffffff) fail('전달 묶음 크기가 한도를 넘었어요. 기간이나 사진 포함 범위를 나눠 주세요.', 'package-too-large');
    const output = new Uint8Array(total), view = new DataView(output.buffer); let offset = 0;
    for (const file of prepared) {
      file.offset = offset; view.setUint32(offset, 0x04034b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 0x800, true); view.setUint16(offset + 8, 0, true); view.setUint16(offset + 12, 33, true); view.setUint32(offset + 14, file.crc, true); view.setUint32(offset + 18, file.bytes.length, true); view.setUint32(offset + 22, file.bytes.length, true); view.setUint16(offset + 26, file.name.length, true); output.set(file.name, offset + 30); output.set(file.bytes, offset + 30 + file.name.length); offset += 30 + file.name.length + file.bytes.length;
    }
    const centralStart = offset;
    for (const file of prepared) {
      view.setUint32(offset, 0x02014b50, true); view.setUint16(offset + 4, 20, true); view.setUint16(offset + 6, 20, true); view.setUint16(offset + 8, 0x800, true); view.setUint16(offset + 14, 33, true); view.setUint32(offset + 16, file.crc, true); view.setUint32(offset + 20, file.bytes.length, true); view.setUint32(offset + 24, file.bytes.length, true); view.setUint16(offset + 28, file.name.length, true); view.setUint32(offset + 42, file.offset, true); output.set(file.name, offset + 46); offset += 46 + file.name.length;
    }
    view.setUint32(offset, 0x06054b50, true); view.setUint16(offset + 8, prepared.length, true); view.setUint16(offset + 10, prepared.length, true); view.setUint32(offset + 12, offset - centralStart, true); view.setUint32(offset + 16, centralStart, true);
    return output;
  }
  function references(row, entity) {
    const values = [];
    const add = (item, phase, index) => {
      if (item == null) return;
      const source = typeof item === 'string' ? item.startsWith('data:') ? { inline: item } : { id: item } : item;
      if (!source || typeof source !== 'object') return;
      const id = source.id == null ? '' : identifier(string(source.id), '사진');
      const inline = source.inline || source.data || '', thumbnail = source.t || source.thumb || source.thumbnail || '';
      if (!id && !inline && !thumbnail) return;
      const explicitPhase = entity === 'inspections' ? source.label === '조치 전' ? 'before' : source.label === '조치 후' ? 'after' : phase : phase;
      values.push({ sourceId: id, inline, thumbnail, phase: explicitPhase, label: string(source.label || (phase === 'before' ? '조치 전' : phase === 'after' ? '조치 후' : '현장 사진')), index, sourceLightId: string(source.lightId || ''), capturedAt: time(source.at || source.date) });
    };
    if (entity === 'inspections') { const thumbnails = Array.isArray(row.thumbs) ? row.thumbs : []; thumbnails.forEach((item, n) => add(item, 'inspection', n)); if (!thumbnails.length && row.photo) add({ inline: row.photo, label: '현장 사진' }, 'inspection', 0); }
    if (entity === 'reports') { if (row.photo) add({ inline: row.photo, label: '신고 사진' }, 'report', 0); if (Array.isArray(row.photos)) row.photos.forEach((item, n) => add(item, 'report', n + 1)); }
    if (entity === 'workOrders') { (row.beforePhotos || []).forEach((item, n) => add(item, 'before', n)); (row.afterPhotos || []).forEach((item, n) => add(item, 'after', n)); }
    return values;
  }
  function photoSession(deps) {
    if (typeof deps.resolvePhoto !== 'function') return null;
    const key = deps.photoSession == null ? deps.resolvePhoto : deps.photoSession;
    if ((!key || typeof key !== 'object') && typeof key !== 'function') fail('사진 조회의 계정 범위를 확인해 주세요.', 'invalid-photo-session');
    let session = photoSessions.get(key);
    if (session && session.resolver !== deps.resolvePhoto) fail('사진 조회의 계정 또는 저장소가 바뀌었어요. 전달 화면을 다시 열어 주세요.', 'photo-session-changed');
    if (!session) { session = { resolver: deps.resolvePhoto, pending: new Map(), listeners: new Set() }; photoSessions.set(key, session); }
    return session;
  }
  function signalPhotos(session) { for (const listener of [...session.listeners]) listener(); }
  function expiredPool(session) {
    const now = Date.now();
    for (const request of session.pending.values()) if (now >= request.deadline) request.expired = true;
    return session.pending.size >= 3 && [...session.pending.values()].every(request => request.expired);
  }
  function waitPhotos(session, deps, deadline, predicate, timeoutReason) {
    check(deps); const ready = predicate(); if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      let done = false, timer, interval;
      const finish = (complete, value) => { if (done) return; done = true; root.clearTimeout(timer); root.clearInterval(interval); session.listeners.delete(poll); complete(value); };
      const poll = () => { try { check(deps); const result = predicate(); if (result !== undefined) finish(resolve, result); } catch (error) { finish(reject, error); } };
      session.listeners.add(poll);
      timer = root.setTimeout(() => { poll(); if (!done) finish(resolve, { reason: timeoutReason }); }, Math.max(1, deadline - Date.now()));
      interval = root.setInterval(poll, 100); poll();
    });
  }
  async function lookup(id, deps, session) {
    check(deps);
    if (!session) return { reason: 'missing-original' };
    const duration = Number.isFinite(deps.photoTimeoutMs) ? Math.max(1, Math.min(30000, deps.photoTimeoutMs)) : PHOTO_WAIT;
    const deadline = Date.now() + duration;
    while (true) {
      check(deps); let request = session.pending.get(id);
      if (!request && session.pending.size >= 3) {
        if (expiredPool(session)) return { reason: 'lookup-capacity' };
        const wake = await waitPhotos(session, deps, deadline, () => session.pending.has(id) || session.pending.size < 3 ? { slot: true } : expiredPool(session) ? { reason: 'lookup-capacity' } : undefined, 'lookup-capacity');
        check(deps); if (!wake.slot) return wake; continue;
      }
      if (!request) {
        // No awaited or queued callback separates this scope check from starting the owner-bound backend read.
        check(deps); request = { id, deadline, expired: false, outcome: undefined }; session.pending.set(id, request);
        const settle = outcome => {
          request.outcome = outcome;
          if (session.pending.get(id) === request) session.pending.delete(id);
          signalPhotos(session);
        };
        try { Promise.resolve(session.resolver(id)).then(value => settle({ value }), () => settle({ reason: 'lookup-failed' })); }
        catch (_) { settle({ reason: 'lookup-failed' }); }
      }
      const result = await waitPhotos(session, deps, Math.min(deadline, request.deadline), () => {
        if (request.outcome !== undefined) return request.outcome;
        if (request.expired || Date.now() >= request.deadline) { request.expired = true; return { reason: 'lookup-timeout' }; }
        return undefined;
      }, 'lookup-timeout');
      check(deps); return result;
    }
  }
  function selection(input) {
    if (!input || typeof input !== 'object') fail('전달할 자료를 확인해 주세요.');
    const from = time(input.from), to = time(input.to); if (from == null || to == null || from > to) fail('내보낼 기간과 날짜를 확인해 주세요.');
    if (input.types != null && !Array.isArray(input.types)) fail('내보낼 자료 종류를 선택해 주세요.');
    const types = [...new Set(input.types == null ? TYPES : input.types)]; if (!types.length || types.some(type => !TYPES.includes(type))) fail('내보낼 자료 종류를 선택해 주세요.'); types.sort();
    const inRange = value => { const at = time(value); return at != null && at >= from && at <= to; };
    const source = Object.fromEntries([...TYPES, 'workEvents'].map(entity => [entity, unique(input[entity] || [], entity)]));
    const eventsInRange = source.workEvents.filter(event => inRange(event.at)), activeWorkIds = new Set(eventsInRange.map(event => event.workId));
    const selected = {
      inspections: types.includes('inspections') ? source.inspections.filter(row => inRange(row.date)) : [],
      reports: types.includes('reports') ? source.reports.filter(row => inRange(row.createdAt) || inRange(row.updatedAt)) : [],
      workOrders: types.includes('workOrders') ? source.workOrders.filter(row => ['createdAt', 'updatedAt', 'completedAt', 'verifiedAt', 'cancelledAt'].some(field => inRange(row[field])) || activeWorkIds.has(row.id)) : [],
      patrols: types.includes('patrols') ? source.patrols.filter(row => inRange(row.start)) : []
    };
    const workIds = new Set(selected.workOrders.map(row => row.id)); selected.workEvents = types.includes('workOrders') ? eventsInRange.filter(event => workIds.has(event.workId)) : [];
    return { from, to, types, selected };
  }
  function selectRecords(input) { return selection(input).selected; }
  async function buildPackage(input, deps = {}) {
    check(deps);
    const { from, to, types, selected } = selection(input), lights = unique(input.lights || [], 'lights'), byLight = new Map(lights.map(light => [light.id, light])), byLamp = new Map();
    for (const light of lights) {
      const lampId = string(light.lampId).trim(); if (!lampId) continue; identifier(lampId, '운영 시설');
      if (byLamp.has(lampId) && byLamp.get(lampId) !== light.id) fail('같은 운영 시설 번호가 여러 시설에 중복 연결돼 있어요: ' + lampId, 'ambiguous-facility'); byLamp.set(lampId, light.id);
    }
    if (!Object.values(selected).some(rows => rows.length)) fail('선택한 기간에 내보낼 기록 자료가 없어요.', 'empty-package');
    const byWork = new Map(selected.workOrders.map(work => [work.id, work])), records = {}, pendingPhotos = [];
    const fields = {
      inspections: ['date', 'result', 'inspector', 'memo', 'checks', 'faults', 'tiltDeg', 'posDist', 'patrol', 'reviewedAt', 'reviewedBy', 'redo', 'redoNote', 'revision', 'updatedAt', 'workId'],
      reports: ['createdAt', 'updatedAt', 'status', 'issue', 'desc', 'location', 'via', 'receipt', 'revision', 'workId'],
      workOrders: ['title', 'description', 'type', 'priority', 'status', 'assignedTo', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'verifiedAt', 'cancelledAt', 'dueAt', 'revision', 'completionNote', 'verificationNote', 'rejectionReason', 'parts', 'measurements', 'reportIds', 'costTotal', 'accountedCost'],
      workEvents: ['workId', 'at', 'by', 'type', 'fromStatus', 'toStatus', 'note', 'reason', 'revision', 'requestHash', 'costDelta', 'costTotal', 'parts', 'createdAt', 'verifiedAt'],
      patrols: ['start', 'end', 'dist', 'by', 'dong', 'passed', 'marks', 'spots', 'track', 'continues', 'revision', 'updatedAt']
    };
    for (const entity of [...TYPES, 'workEvents']) {
      records[entity] = sorted(selected[entity].map(row => {
        const work = entity === 'workEvents' ? byWork.get(row.workId) : null;
        const lightId = entity === 'patrols' ? '' : string(row.lightId || work?.lightId), light = byLight.get(lightId);
        const lampId = light?.lampId == null ? '' : string(light.lampId).trim();
        const dto = { entity, internalId: row.id, lightId, lampId, code: string(row.code || light?.code || work?.code), registryCode: string(light?.code), dong: string(row.dong || light?.dong), mappingStatus: entity === 'patrols' ? 'not-applicable' : lampId ? 'external-id-present' : 'unmapped', ...take(row, fields[entity]) };
        if (entity === 'reports' && input.includeContacts === true) Object.assign(dto, take(row, ['contact', 'name', 'phone', 'email']));
        if (entity === 'workOrders') dto.statusLabel = STATES[row.status] || string(row.status);
        if (entity === 'workEvents') dto.statusLabel = STATES[row.toStatus] || string(row.toStatus);
        dto.photoKeys = [];
        for (const ref of references(row, entity)) { const key = entity + ':' + row.id + ':photo:' + ref.phase + ':' + ref.index; dto.photoKeys.push(key); pendingPhotos.push({ ...ref, key, entity, internalId: row.id, lightId, lampId, workId: entity === 'workOrders' ? row.id : row.workId || '' }); }
        return dto;
      }));
    }
    pendingPhotos.sort((a, b) => compare(a.key, b.key));
    const photoFiles = new Map(), photos = new Array(pendingPhotos.length), cache = new Map(); let photoBytes = 0, cursor = 0, done = 0, session;
    const limit = Number.isFinite(deps.maxPackageBytes) ? Math.max(1, Math.min(MAX_BYTES, deps.maxPackageBytes)) : MAX_BYTES;
    const resolve = id => { if (!cache.has(id)) { if (session === undefined) session = photoSession(deps); cache.set(id, lookup(id, deps, session)); } return cache.get(id); };
    await Promise.all(Array.from({ length: Math.min(3, pendingPhotos.length) }, async () => {
      while (cursor < pendingPhotos.length) {
        check(deps); const index = cursor++, ref = pendingPhotos[index];
        const meta = { key: ref.key, entity: ref.entity, internalId: ref.internalId, lightId: ref.lightId, lampId: ref.lampId, sourceId: ref.sourceId, phase: ref.phase, label: ref.label, capturedAt: ref.capturedAt, sourceKind: 'excluded', filename: '', sha256: '', bytes: 0, reason: 'photos-excluded' };
        if (input.includePhotos !== false) {
          let original = picture(ref.inline), reason = '', doc;
          if (!original && ref.sourceId) { const resolved = await resolve(ref.sourceId); check(deps); doc = resolved.value; reason = resolved.reason || ''; const sourceData = typeof doc === 'string' ? doc : doc?.data;
            if (doc && typeof doc === 'object' && doc.id && doc.id !== ref.sourceId) { reason = 'wrong-photo'; doc = null; }
            else if (doc && typeof doc === 'object' && ((doc.lightId && ref.lightId && doc.lightId !== ref.lightId) || (doc.workId && ref.workId && doc.workId !== ref.workId))) { reason = 'wrong-facility'; doc = null; }
            else { original = picture(sourceData); if (!original) reason = reason || 'missing-original'; }
          }
          if (ref.sourceLightId && ref.lightId && ref.sourceLightId !== ref.lightId) { original = null; reason = 'wrong-facility'; }
          const wrongReference = ['wrong-photo', 'wrong-facility'].includes(reason) || ref.sourceLightId && ref.lightId && ref.sourceLightId !== ref.lightId;
          const fallback = original || wrongReference ? null : picture(ref.thumbnail), chosen = original || fallback;
          meta.sourceKind = original ? 'original' : fallback ? 'thumbnail' : 'missing'; meta.reason = reason || (chosen ? '' : 'missing-original');
          if (doc && typeof doc === 'object') meta.capturedAt = time(doc.at) ?? meta.capturedAt;
          if (chosen) {
            meta.sha256 = await hash(chosen.bytes, deps); meta.filename = 'photos/' + meta.sha256 + '.' + chosen.extension; meta.bytes = chosen.bytes.length; meta.mime = chosen.mime;
            if (!photoFiles.has(meta.filename)) { photoBytes += chosen.bytes.length; if (photoBytes > limit) fail('사진을 포함한 전달 묶음 크기가 한도를 넘었어요. 기간을 나눠 주세요.', 'package-too-large'); photoFiles.set(meta.filename, chosen.bytes); }
          }
        }
        photos[index] = meta; done++; if (typeof deps.onProgress === 'function') deps.onProgress({ phase: 'photos', done, total: pendingPhotos.length });
      }
    }));
    check(deps);
    const entries = [], byRecordPhotos = new Map();
    for (const item of photos) { const key = item.entity + ':' + item.internalId; if (!byRecordPhotos.has(key)) byRecordPhotos.set(key, []); byRecordPhotos.get(key).push(item); }
    for (const entity of [...TYPES, 'workEvents']) for (const row of records[entity]) {
      const related = byRecordPhotos.get(entity + ':' + row.internalId) || [];
      const digest = await hash({ row, photos: related }, deps), at = time(row.date) ?? time(row.at) ?? time(row.updatedAt) ?? time(row.createdAt) ?? time(row.start);
      entries.push({ key: entity + ':' + row.internalId, entity, internalId: row.internalId, lightId: row.lightId, lampId: row.lampId, code: row.code, at, hash: digest, status: string(row.status || row.result || row.toStatus), statusLabel: string(row.statusLabel || row.status || row.result || row.toStatus), mappingStatus: row.mappingStatus });
    }
    entries.sort((a, b) => compare(a.key, b.key));
    const sourceName = string(input.provenance?.source || 'unknown'), sourceKind = ['server', 'local', 'artifact', 'cache', 'mixed', 'unknown'].includes(sourceName) ? sourceName : 'unknown';
    const provenance = { source: sourceKind, complete: ['server', 'local'].includes(sourceKind) && input.provenance?.complete === true, fetchedAt: time(input.provenance?.fetchedAt) };
    const options = { from, to, dong: string(input.dong || '전체'), types, includePhotos: input.includePhotos !== false, includeContacts: input.includeContacts === true };
    const contentHash = await hash({ schemaVersion: 1, sourceSystem: 'donggu-streetlight', targetSystem: 'roadlighting', targetTenant: 'gjd', options, provenance: { source: provenance.source, complete: provenance.complete }, records, photos }, deps);
    const batchId = 'gjd-' + contentHash.slice(0, 32), missingPhotos = photos.filter(item => item.sourceKind === 'missing').length, fallbackPhotos = photos.filter(item => item.sourceKind === 'thumbnail').length;
    const summary = { inspections: records.inspections.length, reports: records.reports.length, workOrders: records.workOrders.length, workEvents: records.workEvents.length, patrols: records.patrols.length, photos: photos.filter(item => ['original', 'thumbnail'].includes(item.sourceKind)).length, photoReferences: photos.length, photoFiles: photoFiles.size, unmapped: entries.filter(entry => entry.mappingStatus === 'unmapped').length };
    const common = [['자료 종류', 'entity'], ['내부 기록 ID', 'internalId'], ['시설 ID', 'lightId'], ['운영 시설 번호', 'lampId'], ['표찰', 'code'], ['행정동', 'dong'], ['연결 상태', 'mappingStatus']];
    const files = [{ path: 'records.json', bytes: jsonBytes(records) },
      { path: 'inspections.csv', bytes: csv([...common, ['점검 시각(ms)', 'date'], ['결과', 'result'], ['점검자', 'inspector'], ['불량 항목', 'faults'], ['점검표', 'checks'], ['메모', 'memo'], ['사진 연결', 'photoKeys'], ['검수 시각(ms)', 'reviewedAt']], records.inspections) },
      { path: 'reports.csv', bytes: csv([...common, ['접수 시각(ms)', 'createdAt'], ['변경 시각(ms)', 'updatedAt'], ['상태', 'status'], ['유형', 'issue'], ['위치', 'location'], ['내용', 'desc'], ['자체 접수번호', 'receipt'], ...(options.includeContacts ? [['연락처', 'contact'], ['이름', 'name'], ['전화', 'phone'], ['이메일', 'email']] : []), ['사진 연결', 'photoKeys']], records.reports) },
      { path: 'works.csv', bytes: csv([...common, ['제목', 'title'], ['설명', 'description'], ['원본 상태', 'status'], ['업무 상태', 'statusLabel'], ['원본 버전', 'revision'], ['담당', 'assignedTo'], ['생성 시각(ms)', 'createdAt'], ['변경 시각(ms)', 'updatedAt'], ['기한(ms)', 'dueAt'], ['완료 요청 시각(ms)', 'completedAt'], ['검수 완료 시각(ms)', 'verifiedAt'], ['조치 메모', 'completionNote'], ['자재', 'parts'], ['비용', 'costTotal'], ['신고 연결', 'reportIds'], ['사진 연결', 'photoKeys']], records.workOrders) },
      { path: 'work-events.csv', bytes: csv([...common, ['작업 ID', 'workId'], ['처리 시각(ms)', 'at'], ['담당', 'by'], ['이전 상태', 'fromStatus'], ['다음 상태', 'toStatus'], ['업무 상태', 'statusLabel'], ['메모', 'note'], ['사유', 'reason'], ['비용 증감', 'costDelta'], ['버전', 'revision']], records.workEvents) },
      { path: 'patrols.csv', bytes: csv([...common, ['시작 시각(ms)', 'start'], ['종료 시각(ms)', 'end'], ['거리(m)', 'dist'], ['담당', 'by'], ['누적 통과(중복 포함)', 'passed'], ['점검 표시', 'marks'], ['미등록 위치', 'spots'], ['경로', 'track']], records.patrols) },
      { path: 'photos.csv', bytes: csv([['사진 연결 키', 'key'], ['자료 종류', 'entity'], ['기록 ID', 'internalId'], ['시설 ID', 'lightId'], ['운영 시설 번호', 'lampId'], ['원본 사진 ID', 'sourceId'], ['전후 구분', 'phase'], ['설명', 'label'], ['촬영 시각(ms)', 'capturedAt'], ['파일', 'filename'], ['SHA-256', 'sha256'], ['바이트', 'bytes'], ['증빙 상태', 'sourceLabel'], ['확인 사유', 'reason']], photos.map(item => ({ ...item, sourceLabel: { original: '원본', thumbnail: '미리보기 대체', missing: '누락 · 원본 미확인', excluded: '사진 제외' }[item.sourceKind] }))) },
      { path: 'README.txt', bytes: encoder.encode('동구 비공식 현장 앱 · 운영 시스템 전달 참고 자료\n\n이 묶음은 gjd.roadlighting.kr의 공식 업로드 양식 또는 API 규격이 아닙니다. 공식 등록 양식과 권한은 운영 업체 확인이 필요합니다. 파일 준비·다운로드는 운영 시스템 전송 또는 등록 완료를 뜻하지 않습니다.\n\nrecords.json과 형식별 CSV는 원본 기록의 ID·시각·상태를 보존합니다. workOrders의 completed는 검수 대기이며 verified만 검수 완료입니다. 운영 시설 번호는 앱의 lampId 값이며 실제 운영 시스템 존재 여부를 자동 확인한 값은 아닙니다. 연결 번호가 없는 기록은 unmapped로 표시합니다.\n\nphotos.csv와 manifest.json에서 원본, 미리보기 대체, 원본 미확인, 사진 제외를 구분합니다. 같은 사진 바이트는 한 파일에 보관하되 기록별 관계는 모두 유지합니다. CSV의 수식으로 해석될 수 있는 텍스트에는 앞에 작은따옴표가 붙고, 정확한 원문은 records.json에 남습니다. CSV 시각은 밀리초이며 조회 기간 경계를 그대로 사용합니다.\n\n연락처 필드는 선택한 경우만 포함합니다. 메모와 설명의 자유 입력 내용까지 익명화한 자료는 아닙니다. 미확인 출처·불완전 조회 자료는 참고용으로 사용하고 등록 전 실제 운영 자료와 대조하세요.\n') }
    ];
    for (const [path, bytes] of [...photoFiles].sort(([a], [b]) => compare(a, b))) files.push({ path, bytes });
    const fileManifest = []; for (const file of files) fileManifest.push({ path: file.path, bytes: file.bytes.length, sha256: await hash(file.bytes, deps) });
    const manifest = { schemaVersion: 1, sourceSystem: 'donggu-streetlight', targetSystem: 'roadlighting', targetTenant: 'gjd', targetUrl: 'https://gjd.roadlighting.kr/slamp/', unofficial: true, apiCompatibility: 'unverified', state: 'prepared', registrationConfirmed: false, batchId, contentHash, generatedAt: time(input.generatedAt) ?? Date.now(), range: { from, to, timeZone: 'Asia/Seoul', dong: options.dong }, options, provenance, counts: summary, missingPhotos, fallbackPhotos, records: entries, photos, files: fileManifest };
    files.unshift({ path: 'manifest.json', bytes: jsonBytes(manifest) }); check(deps);
    const bytes = zipStore(files, limit); check(deps); if (typeof deps.onProgress === 'function') deps.onProgress({ phase: 'package', done: files.length, total: files.length });
    return { batchId, contentHash, bytes, filename: 'Donggu_GJD_' + batchId + '.zip', manifest, entries, summary, missingPhotos, fallbackPhotos, photoCount: summary.photos };
  }
  // The range is filtered in Korean time (+09:00), so its default is this Korean month up to today in Korean time,
  // whatever the device clock's time zone.
  function defaultRange(now = Date.now()) {
    const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
    return { from: today.slice(0, 8) + '01', to: today };
  }
  return { buildPackage, selectRecords, defaultRange };
});
