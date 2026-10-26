/* Atomic, administrator-only review-area changes with immutable snapshots. */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./lighting-area-core.js') : root.DGLightingAreaCore, node ? require('./data.js') : root.DGData, node ? require('node:crypto').webcrypto : root.crypto);
  if (node) module.exports = api;
  root.DGLightingAreaCommands = api;
})(typeof globalThis === 'object' ? globalThis : this, function (Core, Data, crypto) {
  'use strict';
  const fail = Core.fail;
  const dataOf = snap => snap && snap.exists !== false && (typeof snap.exists !== 'function' || snap.exists()) ? (typeof snap.data === 'function' ? snap.data() : snap) : null;
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  async function digest(value) {
    if (!crypto?.subtle) fail('HTTPS 연결과 브라우저의 저장 지원을 확인해 주세요.', 'unsupported-backend');
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function actorValue(value) { return typeof value === 'string' && !!value.trim() && value.length <= 128; }
  async function prepare(job, read, context) {
    if (!context || context.admin !== true || !actorValue(context.user) || job?.actor !== context.user) fail('관리자만 검토 구역을 변경할 수 있어요.', 'permission-denied');
    const operationId = Core.id(job.id), recordId = Core.id(job.recordId), actor = job.actor;
    const at = job.at, expectedRevision = job.expectedRevision;
    if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now() + 300000 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) fail('저장 시각과 기록 버전을 확인해 주세요.');
    const data = Core.normalize(job.data), requestHash = await digest({ recordId, actor, at, expectedRevision, data });
    const receiptBase = { schemaVersion: 1, recordId, by: actor, at, revision: expectedRevision + 1, requestHash };
    const receiptPath = 'lightingAreaOperations/' + operationId, path = 'lightingAreas/' + recordId;
    const receipt = await read(receiptPath);
    if (receipt) {
      const { snapshot, ...meta } = receipt;
      let valid = !!snapshot && Data.equal(meta, receiptBase);
      try { valid = valid && snapshot.schemaVersion === 1 && snapshot.operationId === operationId && snapshot.revision === receiptBase.revision && snapshot.updatedAt === at && snapshot.updatedBy === actor && Number.isSafeInteger(snapshot.createdAt) && snapshot.createdAt > 0 && snapshot.createdAt <= at && actorValue(snapshot.createdBy) && Data.equal(Core.normalize(snapshot), data); } catch (_) { valid = false; }
      if (!valid) fail('같은 저장 작업 ID가 다른 내용에 사용됐어요.', 'conflict');
      // Confirm the original result without reading/replacing a subsequently edited area.
      return { ops: [], expected: {}, record: Data.clone(snapshot), recordId, revision: receiptBase.revision, alreadyApplied: true };
    }
    const old = await read(path);
    if (expectedRevision === 0 ? !!old : !old || old.revision !== expectedRevision) fail('다른 관리자가 구역을 변경했어요. 최신 내용을 다시 읽어 주세요.', 'conflict');
    if (!old && data.disabled) fail('새 구역은 사용 상태로 등록해 주세요.');
    if (old && (old.schemaVersion !== 1 || !Number.isSafeInteger(old.createdAt) || old.createdAt <= 0 || !actorValue(old.createdBy) || !Number.isSafeInteger(old.updatedAt) || old.updatedAt < old.createdAt || at < old.updatedAt)) fail('구역의 마지막 변경보다 이른 시각으로 저장할 수 없어요. 기록 시각을 확인해 주세요.');
    const record = { schemaVersion: 1, ...data, createdAt: old ? old.createdAt : at, createdBy: old ? old.createdBy : actor, updatedAt: at, updatedBy: actor, revision: receiptBase.revision, operationId };
    return { ops: [{ path, data: record }, { path: receiptPath, data: { ...receiptBase, snapshot: Data.clone(record) } }], expected: { [path]: old ? { document: Data.clone(old) } : null, [receiptPath]: null }, record, recordId, revision: record.revision };
  }
  async function execute(job, context) {
    if (!context?.db || !context.user) fail('로그인과 저장소 연결을 확인해 주세요.', 'permission-denied');
    if (context.fb) {
      try {
        return await context.fb.runTransaction(async transaction => {
          const prepared = await prepare(job, async path => dataOf(await transaction.get(context.fb.doc(path))), context);
          for (const op of prepared.ops) transaction.set(context.fb.doc(op.path), op.data);
          return prepared;
        });
      } catch (error) {
        if (['permission-denied', 'aborted', 'unavailable', 'deadline-exceeded', 'conflict'].includes(error.code)) {
          try { const retry = await context.fb.runTransaction(transaction => prepare(job, async path => dataOf(await transaction.get(context.fb.doc(path))), context)); if (retry.alreadyApplied) return retry; } catch (_) {}
        }
        throw error;
      }
    }
    if (context.user !== 'local' || typeof context.db.commitMany !== 'function') fail('기기 저장 또는 Firebase 공유 저장에서 사용할 수 있어요.', 'unsupported-backend');
    const read = async path => dataOf(await context.db.doc(path).get()), prepared = await prepare(job, read, context);
    if (prepared.ops.length) {
      try { await context.db.commitMany(prepared.ops, { expected: prepared.expected }); }
      catch (error) {
        if (error.code === 'conflict') { try { const retry = await prepare(job, read, context); if (retry.alreadyApplied) return retry; } catch (_) {} }
        throw error;
      }
    }
    return prepared;
  }
  return Object.freeze({ normalize: Core.normalize, prepare, execute, dataOf });
});
