/* Atomic task/run writes with durable receipts, shared by local and Firebase modes. */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./lighting-workflow-core.js') : root.DGLightingWorkflowCore, node ? require('./data.js') : root.DGData);
  if (node) module.exports = api;
  root.DGLightingWorkflowCommands = api;
})(typeof globalThis === 'object' ? globalThis : this, function (C, D) {
  'use strict';
  const dataOf = snap => snap && snap.exists !== false && (typeof snap.exists !== 'function' || snap.exists()) ? (typeof snap.data === 'function' ? snap.data() : snap) : null;
  async function prepare(job, read, context) {
    if (!context || !context.user || job?.actor !== context.user || typeof context.user !== 'string' || context.user.length > 128) C.fail('저장 작업의 계정을 확인해 주세요.', 'permission-denied');
    if (!['task', 'run'].includes(job.entity)) C.fail('밝기 업무 종류를 확인해 주세요.');
    const operationId = C.id(job.id), recordId = C.id(job.recordId), actor = job.actor;
    const at = C.number(job.at, 1, Date.now() + 300000, '저장 시각', true), expectedRevision = C.number(job.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1, '기록 버전', true);
    const data = job.entity === 'task' ? C.normalizeTask({ ...job.data, completedAt: job.data.status === 'completed' ? at : 0, completedBy: job.data.status === 'completed' ? actor : '', observationId: job.data.status === 'completed' ? job.data.observationId : '' }) : C.normalizeRun(job.data);
    const requestHash = await C.digest({ entity: job.entity, recordId, actor, at, expectedRevision, data });
    const receipt = { schemaVersion: 1, entity: job.entity, recordId, by: actor, at, revision: expectedRevision + 1, requestHash }, receiptPath = 'lightingWorkflowOperations/' + operationId;
    const existingReceipt = await read(receiptPath);
    if (existingReceipt) { if (!D.equal(existingReceipt, receipt)) C.fail('같은 작업 ID가 다른 내용에 쓰였어요.', 'conflict'); return { ops: [], expected: {}, alreadyApplied: true, recordId, revision: receipt.revision }; }
    const path = (job.entity === 'task' ? 'lightingTasks/' : 'lightingRuns/') + recordId, old = await read(path);
    if (expectedRevision === 0 ? !!old : !old || old.revision !== expectedRevision) C.fail('다른 직원이 기록을 변경했어요. 최신 내용을 확인해 주세요.', 'conflict');
    if (old && at < old.createdAt) C.fail('최초 작성보다 이른 시각의 변경은 저장할 수 없어요.');
    const expected = { [path]: old ? { document: D.clone(old) } : null, [receiptPath]: null };
    if (job.entity === 'run') {
      if (old || expectedRevision !== 0) C.fail('검토 실행 이력은 변경할 수 없어요. 새 검토로 보관해 주세요.', 'permission-denied');
      if (data.reviewedAt > at) C.fail('검토 시각은 저장 시각보다 늦을 수 없어요.');
    } else {
      if (!old) {
        if (data.status !== 'open') C.fail('새 재확인 업무는 진행 상태로 등록해 주세요.');
        if (!context.admin && data.assignedTo !== actor) C.fail('다른 직원에게 배정하려면 관리자 권한이 필요해요.', 'permission-denied');
      } else {
        if (!context.admin && (old.assignedTo !== actor || data.assignedTo !== old.assignedTo)) C.fail('담당자 또는 관리자만 처리할 수 있어요.', 'permission-denied');
        if (data.originKind !== old.originKind || data.originId !== old.originId) C.fail('재확인 업무의 원본 연결은 변경할 수 없어요.');
        if (old.status !== 'open' && (!context.admin || data.status !== 'open')) C.fail('완료·취소한 업무는 관리자가 다시 열어 처리해 주세요.', 'permission-denied');
      }
      if (context.fb && (!old || old.assignedTo !== data.assignedTo)) {
        const rolePath = 'roles/' + data.assignedTo, role = await read(rolePath);
        if (!role || !['admin', 'inspector'].includes(role.role)) C.fail('현재 점검 권한이 있는 담당자를 선택해 주세요.', 'failed-precondition');
      }
      if (data.status === 'completed') {
        if (!old) C.fail('등록한 업무를 먼저 확인해 주세요.');
        const observationPath = 'lightingContext/' + data.observationId, observation = await read(observationPath);
        C.checkCompletion({ ...data, createdAt: old.createdAt }, observation, at);
        expected[observationPath] = { document: D.clone(observation) };
      }
    }
    const record = { schemaVersion: 1, ...data, createdAt: old ? old.createdAt : at, createdBy: old ? old.createdBy : actor, updatedAt: at, updatedBy: actor, revision: receipt.revision, operationId };
    return { ops: [{ path, data: record }, { path: receiptPath, data: receipt }], expected, record, recordId, revision: record.revision };
  }
  async function execute(job, context) {
    if (!context?.db || !context.user) C.fail('로그인과 저장소를 확인해 주세요.', 'permission-denied');
    if (context.fb) {
      try {
        return await context.fb.runTransaction(async tx => { const p = await prepare(job, async path => dataOf(await tx.get(context.fb.doc(path))), context); for (const op of p.ops) tx.set(context.fb.doc(op.path), op.data); return p; });
      } catch (error) {
        if (['permission-denied', 'aborted', 'unavailable', 'deadline-exceeded', 'conflict'].includes(error.code)) {
          try { const p = await context.fb.runTransaction(tx => prepare(job, async path => dataOf(tx.get ? await tx.get(context.fb.doc(path)) : null), context)); if (p.alreadyApplied) return p; } catch (_) {}
        }
        throw error;
      }
    }
    if (context.user !== 'local' || typeof context.db.commitMany !== 'function') C.fail('기기 저장 또는 Firebase 공유 저장이 필요해요.', 'unsupported-backend');
    const read = async path => dataOf(await context.db.doc(path).get()), p = await prepare(job, read, context);
    if (p.ops.length) {
      try { await context.db.commitMany(p.ops, { expected: p.expected }); }
      catch (error) { if (error.code === 'conflict') { try { const retry = await prepare(job, read, context); if (retry.alreadyApplied) return retry; } catch (_) {} } throw error; }
    }
    return p;
  }
  return Object.freeze({ prepare, execute, dataOf, normalizeTask: C.normalizeTask, normalizeRun: C.normalizeRun });
});
