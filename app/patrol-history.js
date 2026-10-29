/* Night patrol presentation only. Never changes or truncates saved patrol records. */
(function (root) {
  'use strict';
  const PAGE_SIZE = 10;
  function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
  function rows(session) {
    const marks = Array.isArray(session?.marks) ? session.marks : [];
    const spots = Array.isArray(session?.spots) ? session.spots : [];
    return [
      ...marks.map((m, index) => ({ type: 'mark', index, id: m.id, code: m.code || '',
        result: m.result || '', at: number(m.at), raw: m, order: index })),
      ...spots.map((sp, index) => ({ type: 'spot', index, id: null, code: sp.near || '',
        result: '어두운 지점', at: number(sp.at), raw: sp, order: marks.length + index }))
    ].sort((a, b) => b.at - a.at || b.order - a.order);
  }
  function isIssue(row) { return row.type === 'spot' || row.result !== '정상'; }
  function snapshot(session, opts = {}) {
    const records = rows(session);
    const filter = ['all', 'issues', 'normal'].includes(opts.filter) ? opts.filter : 'all';
    const limit = Number.isInteger(opts.limit) ? Math.max(1, Math.min(500, opts.limit)) : PAGE_SIZE;
    const filtered = filter === 'issues' ? records.filter(isIssue)
      : filter === 'normal' ? records.filter(row => !isIssue(row)) : records;
    return {
      total: records.length,
      issues: records.filter(isIssue).length,
      normal: records.filter(row => !isIssue(row)).length,
      spots: records.filter(row => row.type === 'spot').length,
      latest: records[0] || null,
      count: filtered.length,
      visible: filtered.slice(0, limit),
      remaining: Math.max(0, filtered.length - limit),
      filter,
      limit
    };
  }
  function candidates(ahead, marks, showChecked = false) {
    const checked = new Set((marks || []).map(m => m.id));
    return (ahead || []).filter(a => showChecked || !checked.has(a?.l?.id));
  }
  function unmarkedTarget(ahead, marks) {
    return candidates(ahead, marks, false)[0]?.l || null;
  }
  root.DGPatrolHistory = Object.freeze({ PAGE_SIZE, snapshot, candidates, unmarkedTarget });
})(globalThis);
