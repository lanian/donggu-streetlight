(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGReporting = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  function photoItems(inspections, thumbs, scope = 'bad') {
    return inspections.flatMap((inspection, index) => {
      if (scope !== 'all' && inspection.result === '정상') return [];
      const evidence = thumbs(inspection) || [];
      const common = { code: inspection.code, lightId: inspection.lightId, inspectionId: inspection.id || 'legacy-' + index, workId: inspection.workId || '', date: inspection.date, result: inspection.result, by: inspection.inspector };
      return evidence.length ? evidence.map(t => ({ ...common, id: t.id, label: t.label || '', t: t.t })) : inspection.photo ? [{ ...common, id: null, label: '현장 사진', t: inspection.photo, full: inspection.photo }] : [];
    });
  }
  function photoPage(items, size, requested = 0) {
    const perPage = size === 'l' ? 24 : 48, pages = Math.max(1, Math.ceil(items.length / perPage));
    const page = Math.max(0, Math.min(pages - 1, Math.floor(Number(requested) || 0)));
    return { items: items.slice(page * perPage, (page + 1) * perPage), total: items.length, page, pages, first: items.length ? page * perPage + 1 : 0, last: Math.min(items.length, (page + 1) * perPage) };
  }
  function photoGroups(items, documents = {}) {
    const groups = new Map();
    for (const item of items) {
      const doc = item.id && documents[item.id], workId = item.workId || (doc && doc.lightId === item.lightId && doc.workId);
      // A shared facility alone never establishes a before/after relationship.
      const key = String(item.lightId) + '/' + (workId ? 'work:' + workId : 'inspection:' + item.inspectionId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.values()].map(values => {
      const before = values.find(item => item.label === '조치 전'), after = values.find(item => item.label === '조치 후');
      return { before, after, rest: values.filter(item => item !== before && item !== after) };
    });
  }
  return { photoItems, photoPage, photoGroups };
});
