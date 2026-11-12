/* Administrator-only physical relationship changes and immutable service receipts. */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./asset-maintenance-core.js') : root.DGAssetMaintenanceCore, node ? require('./data.js') : root.DGData, node ? require('node:crypto').webcrypto : root.crypto);
  if (node) module.exports = api;
  root.DGAssetMaintenanceCommands = api;
})(typeof globalThis === 'object' ? globalThis : this, function (Core, Data, crypto) {
  'use strict';
  const fail = Core.fail, copy = Core.clone;
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const dataOf = snap => snap && snap.exists !== false && (typeof snap.exists !== 'function' || snap.exists()) ? (typeof snap.data === 'function' ? snap.data() : snap) : null;
  async function digest(value) {
    if (!crypto?.subtle) fail('HTTPS 연결과 브라우저 저장 지원을 확인해 주세요.', 'unsupported-backend');
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async function prepare(job, read, context) {
    if (context?.admin !== true || !context.user || job?.actor !== context.user) fail('시설 연결과 이력은 관리자만 변경할 수 있어요.', 'permission-denied');
    const operationId = Core.id(job.id), entity = job.entity, recordId = Core.id(job.recordId), actor = Core.actor(job.actor), input = Core.normalize(entity, job.data);
    const at = job.at, expectedRevision = job.expectedRevision;
    if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now() + 300000 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) fail('저장 시각과 기록 버전을 확인해 주세요.');
    const path = Core.COLLECTIONS[entity] + '/' + recordId, receiptPath = 'assetOperations/' + operationId;
    const requestHash = await digest({ entity, recordId, expectedRevision, data: input, actor, at });
    const receiptBase = { schemaVersion: 1, entity, recordId, by: actor, at, revision: expectedRevision + 1, requestHash };
    const existing = await read(receiptPath);
    if (existing) {
      const { snapshot, ...base } = existing;
      let valid = Data.equal(base, receiptBase);
      try { Core.validateRecord(entity, snapshot); valid = valid && Data.equal(Core.normalize(entity, snapshot), input) && snapshot.revision === receiptBase.revision && snapshot.operationId === operationId && snapshot.updatedAt === at && snapshot.updatedBy === actor; } catch (_) { valid = false; }
      if (!valid) fail('같은 저장 작업 ID가 다른 내용에 사용됐어요.', 'conflict');
      return { ops: [], expected: {}, alreadyApplied: true, record: copy(snapshot), recordId, entity };
    }
    const old = await read(path);
    if (expectedRevision === 0 ? !!old : !old || old.revision !== expectedRevision) fail('다른 직원이 자료를 변경했어요. 최신 내용을 확인해 주세요.', 'conflict');
    if (entity === 'replacement' && old) fail('교체 이력은 수정할 수 없어요. 정정 내용은 새 이력으로 남겨 주세요.', 'failed-precondition');
    if (old && (at < old.updatedAt || old.schemaVersion !== 1)) fail('이전 변경보다 이른 시각의 수정은 저장할 수 없어요.');
    if (entity === 'incident' && old?.status === 'resolved') fail('복구 완료한 장애는 새 장애 이력으로 이어 주세요.', 'failed-precondition');
    const expected = { [receiptPath]: null, [path]: old ? { document: copy(old) } : null }, references = new Map();
    async function reference(key, message) {
      if (!references.has(key)) {
        const value = await read(key); references.set(key, value); expected[key] = value ? { document: copy(value) } : null;
      }
      const value = references.get(key); if (!value) fail(message, 'failed-precondition'); return value;
    }
    async function facility(id) {
      const current = typeof context.byId === 'function' ? context.byId(id) : null;
      const path = 'lights/' + id, override = await read(path); expected[path] = override ? { document: copy(override) } : null;
      const light = current ? { ...current, ...override } : typeof context.byId === 'function' ? null : override?.code ? override : null;
      if (!light || light.removed || light.reg === '반려') fail('현재 대장의 시설을 확인해 주세요.', 'failed-precondition');
      return light;
    }
    async function parent(cabinetId, circuitId) {
      if (!cabinetId) return;
      const cabinet = await reference('cabinets/' + cabinetId, '분전함을 찾을 수 없어요.');
      if (cabinet.disabled) fail('사용 중인 분전함을 선택해 주세요.');
      if (circuitId) { const circuit = await reference('circuits/' + circuitId, '회로를 찾을 수 없어요.'); if (circuit.disabled || circuit.cabinetId !== cabinetId) fail('분전함에 연결된 사용 중인 회로를 선택해 주세요.'); }
    }
    if (entity === 'cabinet' && !old && input.disabled) fail('새 분전함은 사용 상태로 등록해 주세요.');
    if (entity === 'circuit') {
      await parent(input.cabinetId, '');
      if (old && old.cabinetId !== input.cabinetId) fail('회로의 분전함은 바꿀 수 없어요. 올바른 분전함 아래 새 회로를 등록한 뒤 시설 연결을 정정해 주세요.');
      if (!old && input.disabled) fail('새 회로는 사용 상태로 등록해 주세요.');
    }
    if (entity === 'link') {
      if (recordId !== input.lightId) fail('시설과 연결 기록 ID가 달라요.');
      await facility(input.lightId); await parent(input.cabinetId, input.circuitId);
    }
    if (entity === 'incident') {
      await parent(input.cabinetId, input.circuitId);
      for (const lightId of input.lightIds) {
        await facility(lightId);
        if (input.circuitId) { const link = await reference('assetLinks/' + lightId, '시설의 회로 연결을 먼저 확인해 주세요.'); if (link.cabinetId !== input.cabinetId || link.circuitId !== input.circuitId) fail('선택한 회로에 연결된 시설만 장애에 포함할 수 있어요.'); }
      }
      for (const id of input.reportIds) { const report = await reference('reports/' + id, '연결 신고를 찾을 수 없어요.'); if (!input.lightIds.includes(report.lightId)) fail('관련 시설에 접수된 신고만 선택해 주세요.'); }
      for (const id of input.workIds) { const work = await reference('workOrders/' + id, '연결 작업을 찾을 수 없어요.'); if (!input.lightIds.includes(work.lightId)) fail('관련 시설의 작업만 선택해 주세요.'); if (input.status === 'resolved' && !['verified', 'cancelled'].includes(work.status)) fail('연결 작업의 검수·취소가 끝난 뒤 전체 복구를 확인해 주세요.'); }
    }
    if (entity === 'replacement') {
      await facility(input.lightId);
      if (input.replacedAt > at) fail('실제로 교체한 시각을 확인해 주세요.');
      if (input.workId) { const work = await reference('workOrders/' + input.workId, '연결 작업을 찾을 수 없어요.'); if (work.lightId !== input.lightId) fail('같은 시설의 작업만 교체 이력에 연결할 수 있어요.'); }
    }
    const record = { schemaVersion: 1, ...input, createdAt: old ? old.createdAt : at, createdBy: old ? old.createdBy : actor, updatedAt: at, updatedBy: actor, revision: receiptBase.revision, operationId };
    Core.validateRecord(entity, record);
    return { ops: [{ path, data: record }, { path: receiptPath, data: { ...receiptBase, snapshot: copy(record) } }], expected, record, recordId, entity };
  }
  async function execute(job, context) {
    if (!context?.db || !context.user) fail('로그인과 저장소 연결을 확인해 주세요.', 'permission-denied');
    if (context.fb) {
      try { return await context.fb.runTransaction(async transaction => { const prepared = await prepare(job, async path => dataOf(await transaction.get(context.fb.doc(path))), context); for (const op of prepared.ops) transaction.set(context.fb.doc(op.path), op.data); return prepared; }); }
      catch (error) { if (['permission-denied', 'aborted', 'unavailable', 'deadline-exceeded', 'conflict'].includes(error.code)) { try { const result = await context.fb.runTransaction(transaction => prepare(job, async path => dataOf(await transaction.get(context.fb.doc(path))), context)); if (result.alreadyApplied) return result; } catch (_) {} } throw error; }
    }
    if (context.user !== 'local' || typeof context.db.commitMany !== 'function') fail('기기 저장 또는 Firebase 공유 저장에서 사용할 수 있어요.', 'unsupported-backend');
    const read = async path => dataOf(await context.db.doc(path).get()), prepared = await prepare(job, read, context);
    if (prepared.ops.length) { try { await context.db.commitMany(prepared.ops, { expected: prepared.expected }); } catch (error) { if (error.code === 'conflict') { try { const result = await prepare(job, read, context); if (result.alreadyApplied) return result; } catch (_) {} } throw error; } }
    return prepared;
  }
  return Object.freeze({ prepare, execute, dataOf, digest });
});
