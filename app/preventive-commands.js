(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./preventive-core') : root.DGPreventiveCore, node ? require('./operations-core') : root.DGOperationsCore, node ? require('./data') : root.DGData, node ? require('node:crypto').webcrypto : root.crypto);
  if (node) module.exports = api; root.DGPreventiveCommands = api;
})(typeof globalThis === 'object' ? globalThis : this, function (P, C, D, crypto) {
  'use strict';
  const clone = D.clone, fail = (message, code = 'invalid-argument') => { throw Object.assign(new Error(message), { code }); };
  const canonical = value => value == null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  async function digest(value) { if (!crypto?.subtle) fail('안전한 저장 확인을 위해 HTTPS 연결을 확인해 주세요.'); const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))); return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
  async function keys(planId, scheduledAt, lightId) { const hash = await digest([planId, scheduledAt, lightId]); return { runId: 'pm-run-' + hash, workId: 'pm-work-' + hash, eventId: 'pm-created-' + hash }; }
  const dataOf = snap => snap && snap.exists !== false && (typeof snap.exists !== 'function' || snap.exists()) ? (typeof snap.data === 'function' ? snap.data() : snap) : null;
  async function prepare(raw, read, context) {
    const job = clone(raw);
    if (!context.admin || !context.user || context.user !== job.actor) fail('정기점검 계획과 작업 생성은 관리자만 처리할 수 있어요.', 'permission-denied');
    P.id(job.id); P.id(job.planId);
    if (!['save', 'generate', 'advance'].includes(job.kind) || !Number.isSafeInteger(job.at) || job.at <= 0 || job.at > Date.now() + 300000 || !Number.isSafeInteger(job.expectedRevision) || job.expectedRevision < 0) fail('정기점검 작업과 시각·버전을 확인해 주세요.');
    const hash = await digest(job), receiptPath = 'preventiveOperations/' + job.id, receipt = await read(receiptPath);
    if (receipt) { if (receipt.by !== job.actor || receipt.planId !== job.planId || receipt.requestHash !== hash) fail('같은 작업 ID가 다른 요청에 사용됐어요.', 'conflict'); return { ops: [], expected: {}, alreadyApplied: true, recordIds: receipt.recordIds }; }
    const planPath = 'preventivePlans/' + job.planId, old = await read(planPath), expected = { [receiptPath]: null }, ops = [], recordIds = [];
    if (job.expectedRevision === 0 ? !!old : !old || old.revision !== job.expectedRevision) fail('정기점검 계획이 변경됐어요. 다시 조회해 주세요.', 'conflict');
    expected[planPath] = old ? { document: clone(old) } : null;
    let revision = old?.revision || 0;
    if (job.kind === 'save') {
      const data = P.normalize(job.data);
      if (old && job.at < old.updatedAt) fail('최근 변경보다 이른 시각으로 저장할 수 없어요.');
      const record = { schemaVersion: 1, ...data, nextAt: old ? old.nextAt : data.startAt, createdAt: old ? old.createdAt : job.at, createdBy: old ? old.createdBy : job.actor, updatedAt: job.at, updatedBy: job.actor, revision: ++revision };
      P.validatePlan(record); ops.push({ path: planPath, data: record }); recordIds.push(job.planId);
    } else {
      P.validatePlan(old);
      if (!old.enabled || job.scheduledAt !== old.nextAt || job.scheduledAt > job.at) fail('현재 도래한 회차만 생성할 수 있어요.', 'failed-precondition');
      if (job.kind === 'generate') {
        if (!Array.isArray(job.targets) || !job.targets.length || job.targets.length > P.CHUNK || new Set(job.targets.map(target => target.light?.id)).size !== job.targets.length) fail('한 번에는 서로 다른 시설 1~4곳을 처리해 주세요.');
        for (const target of job.targets) {
          const light = target.light, lightId = P.id(light?.id);
          if (!old.lightIds.includes(lightId)) fail('계획에 포함된 시설만 생성할 수 있어요.');
          const ids = await keys(job.planId, job.scheduledAt, lightId), runPath = 'preventiveRuns/' + ids.runId, run = await read(runPath);
          recordIds.push(ids.runId);
          if (run) { P.validateRun(run); if (run.planId !== job.planId || run.scheduledAt !== job.scheduledAt || run.lightId !== lightId) fail('회차 기록의 연결이 달라요.', 'conflict'); continue; }
          expected[runPath] = null;
          let workId = ids.workId, carried = false;
          if (target.candidateWorkId) {
            const previousPath = 'workOrders/' + P.id(target.candidateWorkId), previous = await read(previousPath);
            if (previous && (previous.lightId !== lightId || previous.type !== old.type)) fail('기존 작업의 시설과 종류를 확인해 주세요.');
            expected[previousPath] = previous ? { document: clone(previous) } : null;
            if (previous && !['verified', 'cancelled'].includes(previous.status)) { workId = target.candidateWorkId; carried = true; }
          }
          if (!carried) {
            const workPath = 'workOrders/' + workId, eventPath = 'workEvents/' + ids.eventId;
            if (await read(workPath) || await read(eventPath)) fail('회차 작업과 이력이 이미 있어요. 회차 기록을 확인해 주세요.', 'conflict');
            expected[workPath] = null; expected[eventPath] = null;
            const work = C.createOrder({ title: old.title, description: old.description, type: old.type, priority: old.priority, assignedTo: old.assignedTo, dueAt: job.scheduledAt + old.completionDays * 86400000 - 1, workflowVersion: 2 }, light, job.actor, job.at);
            ops.push({ path: workPath, data: work }, { path: eventPath, data: { workId, lightId, fromStatus: '', toStatus: work.status, type: 'created', note: C.text('정기점검 · ' + old.title + ' · 예정 ' + C.kstDateKey(job.scheduledAt), 2000), at: job.at, by: job.actor, revision: 1, createdAt: work.createdAt, costTotal: 0, costDelta: 0, requestHash: await digest([hash, lightId]) } });
          }
          const record = { schemaVersion: 1, planId: job.planId, scheduledAt: job.scheduledAt, lightId, workId, carried, createdAt: job.at, createdBy: job.actor, operationId: job.id };
          P.validateRun(record); ops.push({ path: runPath, data: record });
        }
      } else {
        for (const lightId of old.lightIds) {
          const ids = await keys(job.planId, job.scheduledAt, lightId), path = 'preventiveRuns/' + ids.runId, run = await read(path);
          if (!run || run.planId !== job.planId || run.scheduledAt !== job.scheduledAt || run.lightId !== lightId) fail('아직 작업을 만들지 않은 대상이 있어요. 이번 회차 생성을 이어 주세요.', 'failed-precondition');
          expected[path] = { document: clone(run) };
        }
        const nextAt = old.nextAt + old.intervalDays * 86400000;
        if (!Number.isSafeInteger(nextAt)) fail('다음 점검일이 허용 범위를 넘었어요.');
        ops.push({ path: planPath, data: { ...old, nextAt, revision: ++revision, updatedAt: job.at, updatedBy: job.actor } });
      }
    }
    ops.push({ path: receiptPath, data: { schemaVersion: 1, planId: job.planId, by: job.actor, at: job.at, action: job.kind, revision, recordIds, requestHash: hash } });
    return { ops, expected, recordIds };
  }
  async function execute(job, context) {
    if (!context?.db || !context.user) fail('로그인과 저장소 연결을 확인해 주세요.', 'permission-denied');
    if (context.fb) return context.fb.runTransaction(async transaction => { const prepared = await prepare(job, async key => dataOf(await transaction.get(context.fb.doc(key))), context); for (const op of prepared.ops) transaction.set(context.fb.doc(op.path), op.data); return prepared; });
    if (context.user !== 'local' || typeof context.db.commitMany !== 'function') fail('기기 저장 또는 Firebase 공유 저장에서 사용할 수 있어요.', 'unsupported-backend');
    const read = async key => dataOf(await context.db.doc(key).get()), prepared = await prepare(job, read, context);
    try { if (prepared.ops.length) await context.db.commitMany(prepared.ops, { expected: prepared.expected }); }
    catch (error) { if (error.code === 'conflict') { const retry = await prepare(job, read, context); if (retry.alreadyApplied) return retry; } throw error; }
    return prepared;
  }
  return { prepare, execute, keys, dataOf };
});
