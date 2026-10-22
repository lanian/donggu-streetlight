/* A registry update preserves stable facility IDs and checks the fields previewed by the operator. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGRegistryCommands = api;
})(globalThis, function () {
  'use strict';
  const clone = v => JSON.parse(JSON.stringify(v));
  const normal = v => v == null ? null : v;
  const dataOf = snap => snap && snap.exists !== false ? (typeof snap.data === 'function' ? snap.data() : snap) : null;
  function conflict(message) { const e = new Error(message); e.code = 'conflict'; throw e; }
  async function prepare(job, entries, read) {
    const ops = [], expected = {};
    for (const entry of entries) {
      const path = 'lights/' + entry.id, current = await read(path);
      if (current && current.registryJobId === job.id) continue;
      if (entry.added && current) conflict('신규 시설 ID가 이미 사용 중이에요: ' + entry.id);
      for (const [field, value] of Object.entries(entry.before || {})) {
        const actual = current && Object.prototype.hasOwnProperty.call(current, field) ? current[field] : null;
        if (JSON.stringify(normal(actual)) !== JSON.stringify(normal(value))) conflict('미리보기 이후 시설 정보가 변경됐어요: ' + entry.id + ' · ' + field);
      }
      // Full document CAS for local storage; Firestore uses its transaction read version.
      expected[path] = current ? { document: clone(current) } : null;
      const patch = { ...clone(entry.patch), registryJobId: job.id, registryUpdatedAt: job.at, registryUpdatedBy: job.actor };
      if (entry.registryValues) { patch.registryValues = clone(entry.registryValues); delete patch.registryValues.id; }
      delete patch.id;
      if (entry.patch.code && entry.oldCode && entry.oldCode !== entry.patch.code) patch.aliases = [...new Set([...(current && current.aliases || []), entry.oldCode])].slice(-50);
      ops.push({ path, data: patch, merge: true });
    }
    return { ops, expected };
  }
  async function execute(job, context) {
    if (!context.admin || context.user !== job.actor) throw new Error('대장 갱신은 작성한 관리자 계정에서 처리해 주세요.');
    if (!context.fb && (context.user !== 'local' || !context.db.commitMany)) throw new Error('안전한 대장 갱신은 이 기기 저장 또는 Firebase 공유 저장에서 사용할 수 있어요.');
    // Each chunk is atomic. A durable operation ID on every facility makes a partial retry resumable.
    for (let offset = 0; offset < job.entries.length; offset += 80) {
      const entries = job.entries.slice(offset, offset + 80);
      if (context.fb) {
        await context.fb.runTransaction(async tx => {
          const prepared = await prepare(job, entries, async path => dataOf(await tx.get(context.fb.doc(path))));
          for (const op of prepared.ops) tx.set(context.fb.doc(op.path), op.data, { mergeFields: Object.keys(op.data) });
        });
      } else {
        const prepared = await prepare(job, entries, async path => dataOf(await context.db.doc(path).get()));
        if (prepared.ops.length) await context.db.commitMany(prepared.ops, { expected: prepared.expected });
      }
      if (context.progress) context.progress(Math.min(offset + entries.length, job.entries.length), job.entries.length);
    }
    const value = { schemaVersion: 1, kind: 'registry-update', jobId: job.id, source: job.source, at: job.at, by: job.actor, count: job.entries.length, counts: job.counts, preserveOverrides: job.preserveOverrides, markMissingRemoved: job.markMissingRemoved };
    const ref = context.db.doc('settings/registry-' + job.id);
    if (context.fb) await ref.set(value);
    else await context.db.commitMany([{ path: 'settings/registry-' + job.id, data: value }]);
    return value;
  }
  return { prepare, execute };
});
