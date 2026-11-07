/* Reporter retention policy and cleanup commands, independent of the management UI. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGPrivacy = api;
})(globalThis, function () {
  'use strict';
  const DAY = 86400000, COLLECTIONS = ['reports', 'citizen_reports'];
  const unsupported = '신고자 정보 파기는 Firebase 또는 기기 체험 저장소에서 사용할 수 있어요. 현재 공유 저장소에서는 안전한 파기를 지원하지 않아요.';
  function supported(context) { return typeof context.firebase?.runTransaction === 'function' || typeof context.database?.commitMany === 'function'; }
  function days(value) { return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : 90; }
  function privateLeft(row) {
    return !!(row && (row.contact || row.photo || row.ua || typeof row.lat === 'number' || typeof row.lng === 'number' || typeof row.acc === 'number' || (row.ext && row.location)));
  }
  function privatePatch(row) {
    return { contact: '', photo: null, lat: null, lng: null, acc: null, ua: '', ...(row.ext ? { location: '' } : {}) };
  }
  function expiresAt(row, collection, privacyDays) {
    const created = collection === 'citizen_reports' ? row.at : row.createdAt;
    const fallback = Number.isFinite(created) && created > 0 ? created + days(privacyDays) * DAY : Infinity;
    const explicit = Number.isFinite(row.privacyExpiresAt) && row.privacyExpiresAt > 0 ? row.privacyExpiresAt : Infinity;
    return Math.min(fallback, explicit);
  }
  function expired(row, collection, at, privacyDays) { return privateLeft(row) && expiresAt(row, collection, privacyDays) <= at; }
  function targets(records, at, privacyDays) {
    return COLLECTIONS.flatMap(collection => (records[collection] || []).filter(row => expired(row, collection, at, privacyDays)).map(row => ({ collection, id: row.id })));
  }
  function entries(job) {
    const values = job.targets || (Array.isArray(job.ids) ? job.ids.map(id => ({ collection: 'reports', id })) : null);
    if (!Array.isArray(values) || values.some(row => !row || !COLLECTIONS.includes(row.collection) || typeof row.id !== 'string' || !row.id || row.id.includes('/') || ['.', '..', '__proto__', 'prototype', 'constructor'].includes(row.id))) throw new Error('파기 대상 신고 경로를 확인해 주세요.');
    return [...new Map(values.map(row => [row.collection + '/' + row.id, row])).values()];
  }
  async function execute(job, context) {
    if (!context.admin || job.actor !== context.actor) throw new Error('처리한 관리자 계정으로 로그인해 주세요.');
    if (!supported(context)) throw new Error(unsupported);
    if (!Number.isFinite(job.at) || job.at <= 0) throw new Error('파기 작업의 기준 시각을 확인해 주세요.');
    const selected = entries(job); // Validate every path before making the first change.
    const eligible = (row, collection) => job.targets ? expired(row, collection, job.at, job.privacyDays) : privateLeft(row) && Number.isFinite(job.cut) && row.createdAt < job.cut;
    for (const entry of selected) {
      const path = entry.collection + '/' + entry.id;
      const patch = row => ({ ...privatePatch(row), privacyPurgedAt: job.at, privacyPurgedBy: job.actor });
      if (context.firebase) {
        await context.firebase.runTransaction(async tx => {
          const ref = context.firebase.doc(path), snapshot = await tx.get(ref);
          const row = snapshot.exists ? snapshot.data() : null;
          if (row && eligible(row, entry.collection)) tx.update(ref, patch(row));
        });
      } else {
        const snapshot = await context.database.doc(path).get(), row = snapshot.exists === false ? null : snapshot.data();
        if (row && eligible(row, entry.collection)) await context.database.commitMany([{ path, data: patch(row), merge: true }], { expected: { [path]: { document: row } } });
      }
    }
  }
  return { COLLECTIONS, days, privateLeft, privatePatch, expiresAt, expired, targets, execute, supported, unsupported };
});
