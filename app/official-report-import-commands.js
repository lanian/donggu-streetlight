/* Implementation preparation: imports are admitted only to the disconnected local trial database. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./official-report-import-core.js') : root.DGOfficialReportImportCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGOfficialReportImportCommands = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';
  const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
  function gate(context, database) {
    if (!context || context.db !== database || context.firebase || context.actor !== 'local' || context.admin !== true || context.canWrite !== true || database?.mode !== 'local' || typeof database.readAll !== 'function' || typeof database.commitMany !== 'function') fail('협의 전 준비 기능은 체험 저장소의 관리자만 사용할 수 있어요.', 'permission-denied');
    if (typeof context.isCurrent !== 'function' || context.isCurrent() !== true) fail('화면이나 계정이 바뀌어 가져오기를 중단했어요.', 'import-cancelled');
  }
  async function execute(values, selectedIds, context) {
    const db = context?.db; gate(context, db);
    const rows = Core.normalizeRows(values);
    if (!Array.isArray(selectedIds) || !selectedIds.length || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => typeof id !== 'string' || !rows.some(row => row.externalId === id))) fail('가져올 신규 신고를 다시 선택해 주세요.', 'invalid-argument');
    const selected = new Set(selectedIds); gate(context, db);
    const reports = await db.readAll('reports'); gate(context, db);
    const lights = typeof context.lights === 'function' ? await context.lights() : context.lights; gate(context, db);
    if (!Array.isArray(lights) || !Array.isArray(reports)) fail('최신 대장과 신고 목록을 확인하지 못했어요.', 'unavailable');
    const planned = Core.plan(rows, { lights, reports }).rows.filter(row => selected.has(row.externalId));
    const eligible = planned.filter(row => row.decision === 'new'), duplicates = planned.filter(row => row.decision === 'duplicate').length;
    const result = { imported: eligible.length, duplicates, skipped: planned.length - eligible.length - duplicates, reportIds: eligible.map(row => row.reportId) };
    if (!eligible.length) return result;
    const expected = Object.create(null), operations = eligible.map(row => {
      const path = 'reports/' + row.reportId; expected[path] = null;
      return { path, data: Core.report(row, context.actor), ifAbsent: true };
    });
    gate(context, db);
    await db.commitMany(operations, { expected });
    // A transaction already admitted to its captured local DB cannot be moved to another account.
    // A late acknowledgement is rejected so it cannot clear a replacement view or draft.
    gate(context, db); return result;
  }
  return { execute };
});
