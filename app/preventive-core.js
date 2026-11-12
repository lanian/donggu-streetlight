(function (root, factory) {
  const C = typeof module === 'object' && module.exports ? require('./operations-core') : root.DGOperationsCore;
  const api = factory(C); if (typeof module === 'object' && module.exports) module.exports = api; root.DGPreventiveCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function (C) {
  'use strict';
  const fail = (message, code = 'invalid-argument') => { throw Object.assign(new Error(message), { code }); };
  function id(value) { if (typeof value !== 'string' || !value || value.length > 180 || value.includes('/') || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(value)) fail('정기점검 식별자를 확인해 주세요.'); return value; }
  function integer(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(label + '을 확인해 주세요.'); return value; }
  function normalize(input) {
    if (!input || !Array.isArray(input.lightIds) || !input.lightIds.length || input.lightIds.length > 200) fail('한 계획에는 시설을 1~200곳 선택해 주세요.');
    const title = C.text(input.title, 120), assignedTo = C.text(input.assignedTo, 180);
    if (!title || !assignedTo || !C.TYPES.includes(input.type) || !C.PRIORITIES.includes(input.priority) || typeof input.enabled !== 'boolean') fail('계획 제목·담당자·작업 종류·우선순위를 확인해 주세요.');
    return { title, description: C.text(input.description, 2000), type: input.type, priority: input.priority, assignedTo,
      intervalDays: integer(input.intervalDays, 1, 3650, '반복 주기'), completionDays: integer(input.completionDays ?? 1, 1, 3650, '완료 기간'), startAt: integer(input.startAt, 1, Number.MAX_SAFE_INTEGER, '시작일'), lightIds: [...new Set(input.lightIds.map(id))], enabled: input.enabled };
  }
  function validatePlan(plan) {
    normalize(plan); integer(plan.nextAt, 1, Number.MAX_SAFE_INTEGER, '다음 점검일'); integer(plan.revision, 1, Number.MAX_SAFE_INTEGER, '버전');
    integer(plan.createdAt, 1, Number.MAX_SAFE_INTEGER, '작성 시각'); integer(plan.updatedAt, plan.createdAt, Number.MAX_SAFE_INTEGER, '수정 시각'); id(plan.createdBy); id(plan.updatedBy);
    if (plan.schemaVersion !== 1) fail('정기점검 계획 형식을 확인해 주세요.'); return plan;
  }
  function validateRun(run) {
    if (run.schemaVersion !== 1 || typeof run.carried !== 'boolean') fail('정기점검 회차 형식을 확인해 주세요.');
    for (const key of ['planId', 'lightId', 'workId', 'createdBy', 'operationId']) id(run[key]);
    integer(run.scheduledAt, 1, Number.MAX_SAFE_INTEGER, '회차 예정일'); integer(run.createdAt, 1, Number.MAX_SAFE_INTEGER, '생성일'); return run;
  }
  function due(plans, now = Date.now()) { return plans.filter(plan => plan.enabled && plan.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id)); }
  return { id, normalize, validatePlan, validateRun, due, CHUNK: 4, MAX_TARGETS: 200 };
});
