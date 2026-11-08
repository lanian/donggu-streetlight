/* Shared, frozen print output. The source screen, History and drafts remain untouched. */
(function (root) {
  'use strict';
  const IMAGE_WAIT_MS = 8000, FALLBACK_CLEANUP_MS = 120000;
  let active = null;
  const failure = (message, code, cause) => Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
  const cancelled = () => failure('화면이나 계정이 바뀌었거나 인쇄 준비가 취소됐어요. 현재 화면에서 다시 인쇄해 주세요.', 'print-cancelled');

  function check(job) {
    let valid = !job.cancelled && !job.cleaned && active === job;
    if (valid && typeof job.isCurrent === 'function') { try { valid = !!job.isCurrent(); } catch (_) { valid = false; } }
    if (!valid) throw cancelled();
  }
  async function wait(job, promise, timeoutMessage) {
    let timer, dispose;
    const pending = [Promise.resolve(promise), job.cancellation.then(() => { throw cancelled(); })];
    if (timeoutMessage) pending.push(new Promise((_, reject) => {
      timer = root.setTimeout(() => reject(failure(timeoutMessage, 'print-prepare-failed')), IMAGE_WAIT_MS);
      dispose = () => root.clearTimeout(timer); job.disposers.add(dispose);
    }));
    try { return await Promise.race(pending); }
    finally { if (dispose) { dispose(); job.disposers.delete(dispose); } }
  }
  function restoreTitle(job) {
    if (job.titleChanged && root.document.title === job.title) root.document.title = job.originalTitle;
    job.titleChanged = false;
  }
  function restoreButton(job) {
    if (job.buttonRestored) return;
    job.buttonRestored = true;
    if (!job.buttonState || !job.button?.isConnected) return;
    job.button.disabled = job.buttonState.disabled;
    if (job.buttonState.nodes && typeof job.button.replaceChildren === 'function') job.button.replaceChildren(...job.buttonState.nodes);
    else job.button.textContent = job.buttonState.text;
  }
  function cleanup(job) {
    if (job.cleaned) return;
    job.cleaned = true;
    root.clearTimeout(job.cleanupTimer); root.clearInterval(job.scopeTimer);
    root.removeEventListener('afterprint', job.afterprint); root.removeEventListener('beforeprint', job.beforeprint);
    for (const dispose of [...job.disposers]) dispose(); job.disposers.clear();
    job.target?.remove(); restoreTitle(job); restoreButton(job);
    if (active === job) { root.document.body.classList.remove('dg-report-printing'); active = null; }
  }
  function cancel() {
    if (!active) return false;
    const job = active; job.cancelled = true; job.notifyCancel(); cleanup(job); return true;
  }
  function cleanControls(target) {
    target.querySelectorAll('.noprint,.sheet-head,.sheet-foot').forEach(element => element.remove());
    // Repeated-fault and facility rows are buttons on screen, but their report content is still needed.
    target.querySelectorAll('button').forEach(button => {
      const content = root.document.createElement('div');
      for (const key of ['class', 'style', 'title', 'lang', 'dir']) if (button.hasAttribute(key)) content.setAttribute(key, button.getAttribute(key));
      while (button.firstChild) content.append(button.firstChild);
      button.replaceWith(content);
    });
  }
  function imageReady(image, job) {
    image.loading = 'eager';
    return new Promise(resolve => {
      let finished = false, timer;
      const finish = (broken, abandon = false) => {
        if (finished) return;
        finished = true; root.clearTimeout(timer);
        image.removeEventListener('load', loaded); image.removeEventListener('error', errored); job.disposers.delete(dispose);
        if (broken && !abandon && !job.cleaned && image.parentNode) {
          const note = root.document.createElement('p'); note.className = 'notice'; note.textContent = '사진 표시 실패 · 원본을 확인해 주세요.'; image.replaceWith(note);
        }
        resolve();
      };
      const loaded = () => {
        if (!image.naturalWidth) return finish(true);
        if (typeof image.decode !== 'function') return finish(false);
        Promise.resolve().then(() => image.decode()).then(() => finish(!image.naturalWidth), () => finish(true));
      };
      const errored = () => finish(true), dispose = () => finish(false, true);
      job.disposers.add(dispose);
      timer = root.setTimeout(() => finish(true), IMAGE_WAIT_MS);
      image.addEventListener('load', loaded, { once: true }); image.addEventListener('error', errored, { once: true });
      if (image.complete) loaded();
    });
  }
  async function frame(job) {
    if (typeof root.requestAnimationFrame !== 'function') return;
    await wait(job, new Promise(resolve => root.requestAnimationFrame(resolve)), '인쇄 화면을 준비하지 못했어요. 현재 화면에서 다시 시도해 주세요.');
    check(job);
  }
  async function prepareAndPrint(job, prepare) {
    try {
      check(job);
      const target = job.target = root.document.createElement('div');
      target.id = 'reportPrintRoot'; target.style.display = 'none'; target.setAttribute('aria-hidden', 'true'); target.dataset.printKind = job.kind;
      target.innerHTML = job.html;
      if (typeof prepare === 'function') await wait(job, Promise.resolve().then(() => { check(job); return prepare(target); }));
      check(job); cleanControls(target);
      target.querySelectorAll('img').forEach(image => { image.loading = 'eager'; });
      root.document.body.append(target);
      if (root.document.fonts?.ready) await wait(job, root.document.fonts.ready, '인쇄 글꼴을 준비하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
      check(job);
      await wait(job, Promise.all([...target.querySelectorAll('img')].map(image => imageReady(image, job))));
      check(job); await frame(job); await frame(job); check(job);
      root.document.body.classList.add('dg-report-printing');
      root.document.title = job.title; job.titleChanged = true;
      job.afterprint = () => cleanup(job); root.addEventListener('afterprint', job.afterprint, { once: true });
      job.beforeprint = () => { try { check(job); } catch (_) { cleanup(job); } };
      root.addEventListener('beforeprint', job.beforeprint);
      job.cleanupTimer = root.setTimeout(() => cleanup(job), FALLBACK_CLEANUP_MS);
      check(job); job.phase = 'calling';
      try { root.print(); }
      catch (cause) { throw failure('인쇄 창을 열지 못했어요. 이 브라우저의 인쇄 기능을 확인해 주세요.', 'print-failed', cause); }
      if (!job.cleaned) job.phase = 'waiting';
      return { state: 'dialog-opened' }; // A closed/cancelled native dialog does not prove that paper or a PDF was produced.
    } catch (error) {
      cleanup(job);
      if (error?.code?.startsWith('print-')) throw error;
      throw failure('인쇄 자료를 준비하지 못했어요. 현재 화면에서 다시 시도해 주세요.', 'print-prepare-failed', error);
    } finally { restoreTitle(job); restoreButton(job); }
  }
  function run(options = {}) {
    if (active && active.phase !== 'waiting') return Promise.reject(failure('인쇄 자료를 준비하거나 인쇄 창을 여는 중이에요. 잠시 기다려 주세요.', 'print-busy'));
    // Some browsers omit afterprint. An explicit subsequent request first releases the previous frozen output.
    if (active) cleanup(active);
    if (!root.document?.body || typeof root.print !== 'function') return Promise.reject(failure('이 브라우저에서는 인쇄 창을 열 수 없어요.', 'print-unavailable'));
    let html;
    try { html = String(options.html ?? ''); }
    catch (cause) { return Promise.reject(failure('인쇄할 내용을 확인하지 못했어요.', 'print-prepare-failed', cause)); }
    const job = { html, title: String(options.title || root.document.title).replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 180),
      kind: String(options.kind || 'report'), isCurrent: options.isCurrent, button: options.button,
      originalTitle: root.document.title, phase: 'preparing', cancelled: false, cleaned: false, disposers: new Set() };
    job.cancellation = new Promise(resolve => { job.notifyCancel = resolve; });
    if (job.button) { job.buttonState = { disabled: job.button.disabled, text: job.button.textContent, nodes: job.button.childNodes ? [...job.button.childNodes] : null }; job.button.disabled = true; job.button.textContent = '출력 준비 중…'; }
    active = job;
    // A photo fetch can stay pending after navigation. Release that obsolete job without waiting for its response.
    job.scopeTimer = root.setInterval(() => { try { check(job); } catch (_) { if (active === job) cancel(); } }, 200);
    return prepareAndPrint(job, options.prepare);
  }
  root.DongguPrint = { run, busy: () => !!active, cancel };
})(globalThis);
