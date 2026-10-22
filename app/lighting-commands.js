/* Shared lighting context commands. A fixed operation receipt survives later edits. */
(function (root, factory) {
  const commonJS = typeof module === 'object' && module.exports;
  const model = commonJS ? require('./lighting-model.js') : root.DGLightingModel;
  const data = commonJS ? require('./data.js') : root.DGData;
  const crypto = commonJS ? require('node:crypto').webcrypto : root.crypto;
  const api = factory(model, data, crypto);
  if (commonJS) module.exports = api;
  root.DGLightingCommands = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, data, crypto) {
  'use strict';
  function fail(message, code = 'invalid-argument') { throw Object.assign(new Error(message), { code }); }
  function identifier(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('관찰 기록과 저장 작업의 식별자를 확인해 주세요.');
    return value;
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function fingerprint(value) {
    if (!crypto || !crypto.subtle) fail('이 브라우저에서 안전한 저장 요청을 만들 수 없어요. HTTPS 연결을 확인해 주세요.', 'unsupported-backend');
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const dataOf = snap => snap && snap.exists !== false && (typeof snap.exists !== 'function' || snap.exists()) ? (typeof snap.data === 'function' ? snap.data() : snap) : null;
  async function prepare(job, read, context) {
    if (!context || typeof context.user !== 'string' || !context.user || context.user.length > 128 || !job || job.actor !== context.user) fail('저장 작업의 계정이 현재 계정과 달라요.', 'permission-denied');
    const id = identifier(job.id), recordId = identifier(job.recordId);
    if (!Number.isSafeInteger(job.at) || job.at <= 0 || job.at > Date.now() + 300000 || !Number.isSafeInteger(job.expectedRevision) || job.expectedRevision < 0 || job.expectedRevision >= Number.MAX_SAFE_INTEGER) fail('확인 시각과 기록 버전을 확인해 주세요.');
    const at = job.at, expectedRevision = job.expectedRevision, actor = job.actor;
    const normalized = model.normalizeRecord(job.data, { now: at });
    const requestHash = await fingerprint({ recordId, actor, at, expectedRevision, data: normalized });
    const receipt = { schemaVersion: 1, recordId, by: actor, at, revision: expectedRevision + 1, requestHash };
    const receiptPath = 'lightingOperations/' + id, path = 'lightingContext/' + recordId;
    const previousReceipt = await read(receiptPath);
    if (previousReceipt) {
      if (!data.equal(previousReceipt, receipt)) fail('같은 저장 작업 ID가 다른 내용에 사용됐어요.', 'conflict');
      // Do not replay an old state after somebody has subsequently edited or removed it.
      return { ops: [], expected: {}, recordId, revision: receipt.revision, alreadyApplied: true };
    }
    const old = await read(path);
    if (expectedRevision === 0 ? !!old : !old || old.revision !== expectedRevision) fail('다른 직원이 기록을 변경했어요. 최신 내용을 확인한 뒤 다시 저장해 주세요.', 'conflict');
    if (old && !context.admin && old.createdBy !== actor) fail('다른 직원이 작성한 관찰은 관리자만 수정할 수 있어요.', 'permission-denied');
    if (!old && normalized.removed) fail('새 기록은 삭제된 상태로 등록할 수 없어요.');
    if (old && (!Number.isSafeInteger(old.createdAt) || at < old.createdAt)) fail('기록의 작성 시각보다 이른 시각으로 수정할 수 없어요.');
    const record = { schemaVersion: 1, ...normalized, createdAt: old ? old.createdAt : at, createdBy: old ? old.createdBy : actor,
      updatedAt: at, updatedBy: actor, revision: receipt.revision, operationId: id };
    return { ops: [{ path, data: record }, { path: receiptPath, data: receipt }],
      expected: { [path]: old ? { document: data.clone(old) } : null, [receiptPath]: null }, record, recordId, revision: record.revision };
  }
  async function execute(job, context) {
    if (!context || !context.db || !context.user) fail('로그인과 저장소 연결을 확인해 주세요.', 'permission-denied');
    if (context.fb) {
      try {
        return await context.fb.runTransaction(async transaction => {
          const prepared = await prepare(job, async path => dataOf(await transaction.get(context.fb.doc(path))), context);
          for (const op of prepared.ops) transaction.set(context.fb.doc(op.path), op.data);
          return prepared;
        });
      } catch (error) {
        // A competing identical transaction may commit before rules evaluate the
        // second write, or an acknowledgement may be lost. Confirm its immutable
        // receipt with a read-only transaction; never weaken revision checks.
        if (['permission-denied', 'aborted', 'unavailable', 'deadline-exceeded', 'conflict'].includes(error.code)) {
          try {
            const retry = await context.fb.runTransaction(transaction => prepare(job, async path => dataOf(await transaction.get(context.fb.doc(path))), context));
            if (retry.alreadyApplied) return retry;
          } catch (_) {}
        }
        throw error;
      }
    }
    if (context.user !== 'local' || typeof context.db.commitMany !== 'function') fail('이 기능은 기기 저장 또는 Firebase 공유 저장에서 사용할 수 있어요.', 'unsupported-backend');
    const read = async path => dataOf(await context.db.doc(path).get());
    const prepared = await prepare(job, read, context);
    if (prepared.ops.length) {
      try { await context.db.commitMany(prepared.ops, { expected: prepared.expected }); }
      catch (error) {
        // Two tabs can submit the same queued command. A matching durable receipt
        // proves success; any other raced edit remains a conflict for the operator.
        if (error.code === 'conflict') {
          try { const retry = await prepare(job, read, context); if (retry.alreadyApplied) return retry; } catch (_) {}
        }
        throw error;
      }
    }
    return prepared;
  }
  return { normalize: model.normalizeRecord, prepare, execute, dataOf };
});
