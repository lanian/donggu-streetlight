/* Business commands: revision checks, evidence, stock and event are committed together. */
(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./operations-core.js') : root.DGOperationsCore;
  const data = typeof module === 'object' && module.exports ? require('./data.js') : root.DGData;
  const crypto = typeof module === 'object' && module.exports ? require('node:crypto').webcrypto : root.crypto;
  const api = factory(core, data, crypto);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGWorkCommands = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, data, crypto) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  function fail(message, code) { const error = new Error(message); error.code = code || 'invalid-argument'; throw error; }
  const active = work => work && !['verified', 'cancelled'].includes(work.status);
  function identifier(value) { if (typeof value !== 'string' || !value || value.length > 180 || value.includes('/') || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(value)) fail('기록 식별자를 확인해 주세요.'); return value; }
  const canonical = value => value == null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  async function fingerprint(job) {
    if (!crypto?.subtle) fail('안전한 저장 확인을 위해 HTTPS 연결을 확인해 주세요.', 'unsupported-backend');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(job)));
    return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  const dataOf = snap => snap && snap.exists !== false && (typeof snap.exists !== 'function' || snap.exists()) ? (typeof snap.data === 'function' ? snap.data() : snap) : null;
  async function prepare(job, read, context) {
    job = clone(job); identifier(job.id);
    if (job.actor !== context.user) fail('저장 작업의 계정이 현재 계정과 달라요.', 'permission-denied');
    if (job.kind === 'report-link') return prepareReportLink(job, read, context);
    const inventoryOnly = job.kind === 'inventory-create' || job.kind === 'inventory-move';
    if (!inventoryOnly && !['create', 'transition', 'link-reports'].includes(job.kind)) fail('지원하지 않는 업무 명령이에요.');
    if (inventoryOnly) identifier(job.itemId); else identifier(job.workId);
    const requestHash = inventoryOnly ? null : await fingerprint(job);
    const eventPath = (inventoryOnly ? 'inventoryMoves/' : 'workEvents/') + job.id;
    const existingEvent = await read(eventPath);
    if (existingEvent) {
      if (existingEvent.by !== job.actor || (inventoryOnly ? existingEvent.itemId !== job.itemId : existingEvent.workId !== job.workId || existingEvent.requestHash && existingEvent.requestHash !== requestHash)) fail('작업 ID가 다른 기록에 사용됐어요.', 'conflict');
      return { ops: [], expected: {}, alreadyApplied: true };
    }
    const expected = { [eventPath]: null }, ops = [];
    if (inventoryOnly) {
      if (!context.admin) fail('재고는 관리자만 변경할 수 있어요.', 'permission-denied');
      const path = 'inventory/' + job.itemId, old = await read(path);
      let item, delta;
      if (job.kind === 'inventory-create') {
        if (old) fail('이미 등록된 자재 ID예요.', 'conflict');
        item = { name: core.text(job.input.name, 100), unit: core.text(job.input.unit || '개', 20), quantity: Number(job.input.quantity || 0), unitCost: Number(job.input.unitCost || 0), revision: 1, updatedAt: job.at, updatedBy: job.actor };
        if (!item.name || !Number.isFinite(item.quantity) || item.quantity < 0 || item.quantity > 100000000 || !Number.isFinite(item.unitCost) || item.unitCost < 0 || item.unitCost > 1000000000) fail('자재 이름·수량·단가를 확인해 주세요.');
        expected[path] = null; delta = item.quantity;
      } else {
        if (!old) fail('자재를 찾을 수 없어요.');
        item = core.inventoryChange(old, Number(job.delta), job.expectedRevision);
        item.updatedAt = job.at; item.updatedBy = job.actor; expected[path] = old.revision; delta = Number(job.delta);
      }
      ops.push({ path, data: item }, { path: eventPath, data: { itemId: job.itemId, delta, reason: core.text(job.reason || '초기 입고', 300), at: job.at, by: job.actor, revision: item.revision } });
      return { ops, expected };
    }
    const path = 'workOrders/' + job.workId, old = await read(path);
    let next;
    if (job.kind === 'create') {
      if (!context.admin) fail('작업 지시는 관리자만 등록할 수 있어요.', 'permission-denied');
      if (old) fail('같은 작업 ID가 이미 있어요.', 'conflict');
      if (job.input.reportIds && (!Array.isArray(job.input.reportIds) || job.input.reportIds.length > 20)) fail('한 작업에는 신고를 최대 20건 연결할 수 있어요.');
      next = core.createOrder(job.input, job.light, job.actor, job.at); expected[path] = null;
    } else if (job.kind === 'link-reports') {
      if (!context.admin) fail('신고 연결은 관리자만 변경할 수 있어요.', 'permission-denied');
      if (!old || !active(old)) fail('진행 중인 작업에만 신고를 연결할 수 있어요.');
      if (old.revision !== job.input.expectedRevision) fail('작업이 변경됐어요. 최신 작업을 확인해 주세요.', 'conflict');
      const ids = [...new Set([...(old.reportIds || []), ...(job.input.reportIds || []).map(identifier)])];
      if (!job.input.reportIds?.length || ids.length > 20) fail('연결할 신고는 작업당 최대 20건이에요.');
      next = { ...old, reportIds: ids, revision: old.revision + 1, updatedAt: job.at, updatedBy: job.actor }; delete next.id;
      expected[path] = old.revision;
    } else {
      if (!old) fail('작업 기록을 찾을 수 없어요.');
      next = core.transition(old, job.target, job.input, job.actor, context.admin, job.at); expected[path] = old.revision;
    }
    if (job.kind === 'create' || job.kind === 'link-reports') {
      for (const id of job.kind === 'create' ? next.reportIds : job.input.reportIds) {
        const reportPath = 'reports/' + identifier(id), report = await read(reportPath);
        if (!report || report.lightId !== next.lightId || report.status === '완료') fail('같은 시설의 미완료 신고를 선택해 주세요.', 'failed-precondition');
        if (job.reportVersions && (report.updatedAt || report.createdAt || null) !== job.reportVersions[id]) fail('신고가 변경됐어요. 최신 내용을 확인해 주세요.', 'conflict');
        if (report.workId && report.workId !== job.workId) {
          const previousPath = 'workOrders/' + identifier(report.workId), previous = await read(previousPath);
          if (active(previous)) fail('이미 진행 중인 작업에 연결된 신고예요. 기존 작업을 확인해 주세요.', 'conflict');
          expected[previousPath] = previous ? { document: clone(previous) } : null;
        }
        expected[reportPath] = { document: clone(report) };
        ops.push({ path: reportPath, data: { workId: job.workId, updatedAt: job.at }, merge: true });
      }
    }
    const incomingPhotos = new Map((job.photos || []).map(photo => [photo.id, photo.data]));
    if (incomingPhotos.size > 12) fail('작업 사진 수를 확인해 주세요.');
    for (const [id, value] of incomingPhotos) {
      if (!/^[A-Za-z0-9_-]+$/.test(id) || value.by !== job.actor || value.lightId !== next.lightId || value.workId !== job.workId || value.kind !== 'work' || !/^data:image\/(jpeg|png|webp);base64,/.test(value.data || '')) fail('사진의 시설·작업 연결이 올바르지 않아요.');
      const previous = await read('photos/' + id);
      if (previous && !data.equal(previous, value)) fail('같은 사진 ID의 원본이 변경됐어요.', 'conflict');
      if (!previous) { expected['photos/' + id] = null; ops.push({ path: 'photos/' + id, data: clone(value) }); }
    }
    const evidenceIds = [...new Set([...(next.beforePhotos || []), ...(next.afterPhotos || [])])];
    for (const id of evidenceIds) {
      const photo = incomingPhotos.get(id) || await read('photos/' + id);
      if (!photo || photo.lightId !== next.lightId || photo.workId !== job.workId || photo.kind !== 'work' || typeof photo.data !== 'string' || !photo.data.startsWith('data:image/')) fail('작업에 연결된 원본 사진을 확인하지 못했어요. 다시 첨부해 주세요.', 'failed-precondition');
      if (!Object.prototype.hasOwnProperty.call(expected, 'photos/' + id)) expected['photos/' + id] = { document: clone(photo) };
    }
    if (job.target === 'verified') {
      if (!next.afterPhotos.length) fail('조치 후 원본 사진이 필요해요.');
      const wanted = {};
      for (const part of next.parts) if (part.inventoryId) wanted[part.inventoryId] = (wanted[part.inventoryId] || 0) + part.qty;
      const previous = old.stockApplied || {};
      if ([...new Set([...Object.keys(wanted), ...Object.keys(previous)])].filter(id => Math.round(((previous[id] || 0) - (wanted[id] || 0)) * 1000) !== 0).length > 10) fail('한 번의 검수에서 변경할 수 있는 재고는 반납을 포함해 최대 10종이에요. 별도 작업으로 나눠 주세요.');
      for (const itemId of new Set([...Object.keys(wanted), ...Object.keys(previous)])) {
        const delta = Math.round(((previous[itemId] || 0) - (wanted[itemId] || 0)) * 1000) / 1000;
        if (!delta) continue;
        const itemPath = 'inventory/' + itemId, item = await read(itemPath);
        if (!item) fail('사용한 자재가 재고에서 삭제됐어요. 자재 내역을 확인해 주세요.', 'failed-precondition');
        const updated = core.inventoryChange(item, delta, item.revision);
        updated.updatedAt = job.at; updated.updatedBy = job.actor;
        expected[itemPath] = item.revision;
        ops.push({ path: itemPath, data: updated }, { path: 'inventoryMoves/' + job.id + '-' + itemId, data: { itemId, delta, reason: '작업 검수: ' + next.title, at: job.at, by: job.actor, revision: updated.revision, workId: job.workId } });
      }
      next.stockApplied = wanted;
      next.accountedCost = next.costTotal;
      if (job.facilityStatus) {
        if (!['정상', '점검필요', '고장', '수리중'].includes(job.facilityStatus)) fail('시설 상태를 확인해 주세요.');
        const lightPath = 'lights/' + next.lightId, light = await read(lightPath);
        const stamp = light && light.updatedAt || null;
        if (stamp !== (job.lightUpdatedAt || null)) fail('시설 상태가 다른 작업에서 변경됐어요. 최신 상태를 확인한 뒤 검수해 주세요.', 'conflict');
        expected[lightPath] = light ? { field: 'updatedAt', value: stamp } : null;
        ops.push({ path: lightPath, data: { status: job.facilityStatus, updatedAt: job.at, lastRepairedAt: job.at, lastWorkId: job.workId }, merge: true });
      }
      if (job.closeReports) {
        for (const id of next.reportIds) {
          const reportPath = 'reports/' + id, report = await read(reportPath);
          if (!report || report.lightId !== next.lightId) fail('연결 신고의 시설을 확인해 주세요.', 'failed-precondition');
          if (!job.reportVersions || !Object.prototype.hasOwnProperty.call(job.reportVersions, id) || (report.updatedAt || report.createdAt || null) !== job.reportVersions[id]) fail('연결 신고가 변경됐어요. 최신 신고를 확인한 뒤 검수해 주세요.', 'conflict');
          expected[reportPath] = { document: clone(report) };
          ops.push({ path: reportPath, data: { status: '완료', contact: '', resolvedAt: job.at, resolvedBy: job.actor, workId: job.workId }, merge: true });
        }
      }
    }
    ops.push({ path, data: next });
    ops.push({ path: eventPath, data: { workId: job.workId, lightId: next.lightId, fromStatus: old ? old.status : '', toStatus: next.status, type: job.kind === 'create' ? 'created' : job.kind === 'link-reports' ? 'reports-linked' : 'transition', note: core.text(job.input.verificationNote || job.input.completionNote || job.note || '', 2000), at: job.at, by: job.actor, revision: next.revision, createdAt: next.createdAt, costTotal: next.costTotal, costDelta: job.target === 'verified' ? next.costTotal - (Number(old.accountedCost) || 0) : 0, requestHash } });
    return { ops, expected, order: next };
  }
  async function prepareReportLink(job, read, context) {
    if (!context.admin) fail('신고 시설 연결은 관리자만 변경할 수 있어요.', 'permission-denied');
    const reportId = identifier(job.reportId), lightId = identifier(job.light?.id), reason = core.text(job.reason, 500);
    if (!reason || !Number.isSafeInteger(job.at) || job.at <= 0 || !Number.isSafeInteger(job.expectedRevision) || job.expectedRevision < 0) fail('연결 사유와 기록 버전을 확인해 주세요.');
    const path = 'reports/' + reportId, eventPath = 'reportEvents/' + job.id, requestHash = await fingerprint(job), existing = await read(eventPath);
    if (existing) {
      if (existing.by !== job.actor || existing.reportId !== reportId || existing.requestHash !== requestHash) fail('같은 작업 ID가 다른 내용에 사용됐어요.', 'conflict');
      return { ops: [], expected: {}, alreadyApplied: true };
    }
    const old = await read(path);
    if (!old || (old.linkRevision || 0) !== job.expectedRevision || (old.updatedAt || old.createdAt || null) !== job.expectedUpdatedAt) fail('신고 내용이 변경됐어요. 최신 내용을 확인해 주세요.', 'conflict');
    const expected = { [path]: { document: clone(old) }, [eventPath]: null };
    if (old.lightId !== lightId && old.workId) {
      const previousPath = 'workOrders/' + identifier(old.workId), previous = await read(previousPath);
      if (active(previous)) fail('진행 중인 작업에 연결돼 있어요. 기존 작업을 마치거나 취소한 뒤 시설을 정정해 주세요.', 'failed-precondition');
      expected[previousPath] = previous ? { document: clone(previous) } : null;
    }
    const patch = { lightId, code: core.text(job.light.code, 120), dong: core.text(job.light.dong, 80), linkRevision: job.expectedRevision + 1, linkEventId: job.id, linkUpdatedBy: job.actor, updatedAt: job.at, workId: old.lightId === lightId ? old.workId || '' : '' };
    const event = { schemaVersion: 1, type: 'facility-linked', reportId, fromLightId: old.lightId || '', toLightId: lightId, reason, by: job.actor, at: job.at, revision: patch.linkRevision, requestHash };
    return { ops: [{ path, data: patch, merge: true }, { path: eventPath, data: event }], expected };
  }
  async function execute(job, context) {
    if (!context.db || !context.user) fail('로그인과 저장소 연결을 확인해 주세요.', 'permission-denied');
    if (context.fb) {
      try { return await context.fb.runTransaction(async transaction => {
        const prepared = await prepare(job, async path => dataOf(await transaction.get(context.fb.doc(path))), context);
        for (const op of prepared.ops) transaction.set(context.fb.doc(op.path), op.data, op.merge ? { mergeFields: Object.keys(op.data) } : {});
        return prepared;
      }); } catch (error) {
        if (['permission-denied', 'aborted', 'unavailable', 'deadline-exceeded', 'conflict'].includes(error.code)) {
          try { const retry = await context.fb.runTransaction(tx => prepare(job, async path => dataOf(await tx.get(context.fb.doc(path))), context)); if (retry.alreadyApplied) return retry; } catch (_) {}
        }
        throw error;
      }
    }
    if (context.user !== 'local' || typeof context.db.commitMany !== 'function') fail('이 업무는 기기 저장 또는 Firebase 공유 저장에서 사용할 수 있어요.', 'unsupported-backend');
    const prepared = await prepare(job, async path => dataOf(await context.db.doc(path).get()), context);
    if (prepared.ops.length) {
      try { await context.db.commitMany(prepared.ops, { expected: prepared.expected }); }
      catch (error) {
        if (error.code === 'conflict') { try { const retry = await prepare(job, async path => dataOf(await context.db.doc(path).get()), context); if (retry.alreadyApplied) return retry; } catch (_) {} }
        throw error;
      }
    }
    return prepared;
  }
  return { execute, prepare, dataOf };
});
