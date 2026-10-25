/* Durable, account-scoped drafts and idempotent commands. No credentials are stored. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGOffline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const executors = new Map(), listeners = new Set(), active = new Map();
  let storage = null, namespace = '', durable = false, networkRequired = true, generation = 0, openPromise = null;
  const errorText = error => String(error && (error.message || error.code) || '저장 요청을 완료하지 못했어요.').slice(0, 300);
  const canonical = value => value == null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  async function fingerprint(value) {
    if (!root.crypto || !root.crypto.subtle) throw new Error('안전한 저장 확인을 위해 HTTPS 주소 또는 지원되는 브라우저에서 열어 주세요.');
    const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function emit(event) { for (const listener of listeners) { try { listener(event); } catch (e) { console.error(e); } } }
  function openDB() {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('이 브라우저에서는 자동 복구 저장소를 사용할 수 없어요.'));
      const request = root.indexedDB.open('donggu-workspace-v2', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('entries', { keyPath: 'key' });
        store.createIndex('namespace', 'namespace', { unique: false });
      };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); openPromise = null; }; resolve(db); };
      request.onerror = () => { openPromise = null; reject(request.error); };
      request.onblocked = () => { openPromise = null; reject(new Error('다른 탭을 닫고 자동 복구 저장소를 다시 열어 주세요.')); };
    });
    return openPromise;
  }
  function memoryStore() {
    const values = new Map();
    return {
      read: async key => values.has(key) ? copy(values.get(key)) : null,
      write: async (key, value) => { values.set(key, copy(value)); },
      claim: async (key, value) => {
        if (values.has(key)) return { value: copy(values.get(key)), created: false };
        values.set(key, copy(value)); return { value: copy(value), created: true };
      },
      compareAndSet: async (key, expectedRevision, value) => {
        const current = values.get(key) || null;
        if ((current ? current.value.draftRevision || 0 : null) !== expectedRevision) return { applied: false, current: copy(current) };
        if (value === null) values.delete(key); else values.set(key, copy(value));
        return { applied: true };
      },
      remove: async key => { values.delete(key); },
      list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([, value]) => copy(value)),
      clear: async () => { values.clear(); }
    };
  }
  async function indexedStore(ns) {
    const db = await openDB();
    const transact = (mode, action) => new Promise((resolve, reject) => {
      const tx = db.transaction('entries', mode), store = tx.objectStore('entries');
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('기기 저장 공간을 확인해 주세요.'));
      try { action(store, value => { result = value; }); } catch (error) { tx.abort(); reject(error); }
    });
    return {
      read: key => transact('readonly', (store, done) => { const r = store.get(ns + '|' + key); r.onsuccess = () => done(r.result ? r.result.value : null); }),
      write: (key, value) => transact('readwrite', store => store.put({ key: ns + '|' + key, namespace: ns, item: key, value: copy(value) })),
      claim: (key, value) => transact('readwrite', (store, done) => {
        // The existence check and insertion share one transaction across every tab.
        const recordKey = ns + '|' + key, request = store.get(recordKey);
        request.onsuccess = () => {
          if (request.result) return done({ value: request.result.value, created: false });
          store.put({ key: recordKey, namespace: ns, item: key, value: copy(value) });
          done({ value: copy(value), created: true });
        };
      }),
      compareAndSet: (key, expectedRevision, value) => transact('readwrite', (store, done) => {
        const recordKey = ns + '|' + key, request = store.get(recordKey);
        request.onsuccess = () => {
          const current = request.result ? request.result.value : null;
          if ((current ? current.value.draftRevision || 0 : null) !== expectedRevision) return done({ applied: false, current });
          if (value === null) store.delete(recordKey);
          else store.put({ key: recordKey, namespace: ns, item: key, value: copy(value) });
          done({ applied: true });
        };
      }),
      remove: key => transact('readwrite', store => store.delete(ns + '|' + key)),
      list: prefix => transact('readonly', (store, done) => {
        const r = store.index('namespace').getAll(ns);
        r.onsuccess = () => done(r.result.filter(x => x.item.startsWith(prefix)).map(x => x.value));
      }),
      clear: () => transact('readwrite', store => {
        const r = store.index('namespace').openKeyCursor(ns);
        r.onsuccess = () => { const cursor = r.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
      })
    };
  }
  function requireStore() { if (!storage) throw new Error('자동 복구 저장소를 준비하는 중이에요.'); return storage; }
  async function configure(options) {
    const token = ++generation;
    const nextNamespace = String(options.namespace || ''), nextDurable = !!options.durable;
    if (!nextNamespace || nextNamespace.includes('|')) throw new Error('저장 계정 범위가 올바르지 않아요.');
    storage = null;
    const next = options.adapter || (nextDurable ? await indexedStore(nextNamespace) : memoryStore());
    if (token !== generation) return false;
    storage = next; namespace = nextNamespace; durable = nextDurable; networkRequired = options.networkRequired !== false;
    emit({ type: 'ready', durable, namespace });
    return true;
  }
  async function put(kind, id, value) {
    const store = requireStore(), key = kind + ':' + id;
    await store.write(key, { id, kind, value: copy(value), updatedAt: Date.now() });
    emit({ type: 'draft', kind, id });
  }
  async function putIfCurrent(kind, id, value, expectedRevision = null) {
    const store = requireStore(), gen = generation;
    if (typeof store.compareAndSet !== 'function') throw Object.assign(new Error('이 저장소는 충돌을 확인하는 초안 저장을 지원하지 않아요.'), { code: 'unsupported-backend' });
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('초안 버전을 확인해 주세요.');
    const saved = { ...copy(value), draftRevision: (expectedRevision || 0) + 1 };
    const result = await store.compareAndSet(kind + ':' + id, expectedRevision, { id, kind, value: saved, updatedAt: Date.now() });
    if (gen !== generation) throw Object.assign(new Error('초안을 저장하는 동안 계정이 바뀌었어요.'), { code: 'account-changed' });
    if (!result.applied) throw Object.assign(new Error('다른 탭에서 이 초안을 변경했어요. 최신 내용과 비교해 주세요.'), { code: 'conflict' });
    emit({ type: 'draft', kind, id }); return copy(saved);
  }
  async function removeIfCurrent(kind, id, expectedRevision) {
    const store = requireStore(), gen = generation;
    if (typeof store.compareAndSet !== 'function') throw Object.assign(new Error('이 저장소는 충돌을 확인하는 초안 삭제를 지원하지 않아요.'), { code: 'unsupported-backend' });
    const result = await store.compareAndSet(kind + ':' + id, expectedRevision, null);
    if (gen !== generation) throw Object.assign(new Error('초안을 처리하는 동안 계정이 바뀌었어요.'), { code: 'account-changed' });
    if (!result.applied && result.current !== null) throw Object.assign(new Error('다른 탭에서 변경한 초안은 지우지 않았어요.'), { code: 'conflict' });
    emit({ type: 'removed', kind, id }); return true;
  }
  async function get(kind, id) { const entry = await requireStore().read(kind + ':' + id); return entry ? copy(entry.value) : null; }
  async function list(kind) { return requireStore().list(kind + ':'); }
  async function remove(kind, id) { await requireStore().remove(kind + ':' + id); emit({ type: 'removed', kind, id }); }
  function register(kind, execute) { executors.set(kind, execute); }
  function connected() { return !networkRequired || !(root.navigator && root.navigator.onLine === false); }
  async function run(id, options) {
    const store = requireStore(), ns = namespace, gen = generation, key = 'job:' + id;
    const activeKey = ns + ':' + id;
    if (active.has(activeKey)) return active.get(activeKey);
    const work = async () => {
      let job = await store.read(key);
      if (!job || job.state === 'synced' || gen !== generation) return job;
      if (!connected()) return job;
      if ((job.state === 'failed' || job.state === 'conflict') && !(options && options.retry)) return job;
      const execute = executors.get(job.kind);
      if (!execute) return job;
      job = { ...job, state: 'sending', attempts: job.attempts + 1, updatedAt: Date.now(), error: '' };
      await store.write(key, job);
      if (gen !== generation) { job.state = 'queued'; await store.write(key, job); return job; }
      emit({ type: 'job', job: copy(job) });
      try {
        await execute(copy(job.payload), copy(job));
        job = { ...job, state: 'synced', updatedAt: Date.now(), syncedAt: Date.now(), error: '' };
        // The queue is not an additional photo/contact archive after successful delivery.
        const completion = copy(job); delete job.payload;
        await store.write(key, job);
        if (gen === generation) emit({ type: 'synced', job: completion });
      } catch (error) {
        const code = String(error && error.code || '');
        const offline = !connected() || /unavailable|network|deadline|offline/i.test(code + ' ' + errorText(error));
        job = { ...job, state: /conflict|aborted|already-exists/.test(code) ? 'conflict' : offline ? 'queued' : 'failed', error: errorText(error), updatedAt: Date.now() };
        await store.write(key, job); if (gen === generation) emit({ type: 'job', job: copy(job) });
      }
      return job;
    };
    const pending = (root.navigator && root.navigator.locks ? root.navigator.locks.request('dg-command-' + activeKey, work) : work()).finally(() => active.delete(activeKey));
    active.set(activeKey, pending);
    return pending;
  }
  async function submit(kind, payload, options) {
    const store = requireStore(), gen = generation, opts = options || {}, id = opts.id || payload.id;
    if (typeof id !== 'string' || !id) throw new Error('저장 작업 ID가 없어요.');
    const snapshot = copy(payload), digest = await fingerprint(snapshot);
    if (gen !== generation) throw new Error('계정이 변경됐어요. 원래 계정으로 돌아가 저장 작업을 확인해 주세요.');
    if (typeof store.claim !== 'function') throw new Error('이 저장소에서는 안전한 대기 작업 등록을 지원하지 않아요.');
    const candidate = { id, kind, payload: snapshot, fingerprint: digest, summary: String(opts.summary || kind).slice(0, 120), state: 'queued', attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), error: '' };
    const claimed = await store.claim('job:' + id, candidate), job = claimed.value;
    if (gen !== generation) throw new Error('계정이 변경됐어요. 원래 계정의 대기함에 작업을 보관했어요.');
    if (job && job.kind !== kind) throw new Error('같은 저장 작업 ID를 다른 업무에 사용할 수 없어요.');
    if (job && (job.fingerprint ? job.fingerprint !== digest : job.payload ? canonical(job.payload) !== canonical(snapshot) : true)) {
      const error = new Error('이미 대기 중인 작업과 내용이 달라요. 기존 작업을 먼저 확인해 주세요.'); error.code = 'conflict'; throw error;
    }
    if (claimed.created) emit({ type: 'job', job: copy(job) });
    if (job.state === 'synced' || !connected()) return copy(job);
    const pending = run(id, { retry: !!opts.retry });
    let timer;
    const result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), opts.waitMs == null ? 5000 : opts.waitMs); })]);
    clearTimeout(timer);
    return result || await store.read('job:' + id);
  }
  async function jobs() { return (await requireStore().list('job:')).sort((a, b) => b.createdAt - a.createdAt); }
  async function flush(options) {
    if (!storage || !connected()) return;
    const gen = generation;
    for (const job of await jobs()) {
      if (gen !== generation) return;
      if (job.state === 'queued' || job.state === 'sending' || (options && options.retry && job.state === 'failed')) await run(job.id, options);
    }
    const done = (await jobs()).filter(x => x.state === 'synced');
    for (const job of done.slice(50)) await storage.remove('job:' + job.id);
  }
  async function retry(id) { return run(id, { retry: true }); }
  async function discard(id) {
    const job = await requireStore().read('job:' + id);
    if (job && job.state === 'sending') throw new Error('전송 중인 작업은 결과를 확인한 뒤 정리할 수 있어요.');
    await storage.remove('job:' + id); emit({ type: 'discarded', id, job: job ? copy(job) : null });
  }
  async function clear() { await requireStore().clear(); emit({ type: 'cleared' }); }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  if (root.addEventListener) root.addEventListener('online', () => { flush().catch(error => emit({ type: 'error', error: errorText(error) })); });
  return { configure, put, putIfCurrent, get, list, remove, removeIfCurrent, register, submit, flush, jobs, retry, discard, clear, subscribe, memoryStore,
    get ready() { return !!storage; }, get durable() { return durable; }, get namespace() { return namespace; } };
});
