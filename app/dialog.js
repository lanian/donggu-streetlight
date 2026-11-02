/* In-app replacement for window.alert / confirm / prompt. One dialog at a time, queued; Promise-based.
   confirm(message, {title, ok, cancel, danger}) → true/false
   prompt(message, {title, value, placeholder, ok, cancel, multiline, maxLength, required}) → string | null
   alert(message, {title, ok}) → true
   choose(message, {title, options:[{value,label,hint}], value}) → the chosen value | null
   Escape, the backdrop and the phone Back key cancel (the page's popstate handler calls DGDialog.cancel()).
   Buttons are labelled with the action ("버리고 이동", "삭제") instead of 확인/취소 whenever the caller says so. */
(function (root) {
  'use strict';
  const queue = []; let active = null, host = null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lines = s => esc(s).split('\n').map(l => l || '&nbsp;').join('<br>');
  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement('div'); host.className = 'dgdlg-bg'; host.id = 'dgDialog'; host.hidden = true;
    document.body.appendChild(host);
    host.addEventListener('click', e => { if (e.target === host && active && !active.opts.modalOnly) settle(none(active.kind)); });
    host.addEventListener('keydown', e => {
      if (!active) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(none(active.kind)); }
      else if (e.key === 'Enter' && active.kind === 'prompt' && e.target.matches('input')) { e.preventDefault(); ok(); }
    }, true);
    return host;
  }
  const none = kind => kind === 'prompt' || kind === 'choose' ? null : false; // what "no" means for each kind
  function value() {
    const f = host.querySelector('.dgdlg-field'); if (!f) return null;
    let v = f.value; if (active.opts.maxLength) v = v.slice(0, active.opts.maxLength); return v;
  }
  function ok() {
    if (!active) return;
    if (active.kind === 'prompt') { const v = value(); if (active.opts.required && !String(v || '').trim()) { host.querySelector('.dgdlg-field')?.focus(); return; } settle(v); }
    else settle(true);
  }
  function settle(result) {
    const item = active; if (!item) return; active = null;
    host.hidden = true; host.innerHTML = '';
    if (root.DongguUI) root.DongguUI.close(host);
    else if (item.trigger && item.trigger.isConnected) { try { item.trigger.focus({ preventScroll: true }); } catch (_) {} }
    item.resolve(result);
    if (queue.length) show(queue.shift()); else document.dispatchEvent(new CustomEvent('dgdialog:idle'));
  }
  function show(item) {
    active = item; const { kind, message, opts } = item; ensureHost();
    const okLabel = opts.ok || (kind === 'alert' ? '확인' : '확인'), cancelLabel = opts.cancel || '취소';
    const title = opts.title ? `<h3 class="dgdlg-title" id="dgDialogTitle">${esc(opts.title)}</h3>` : '';
    const field = kind !== 'prompt' ? '' : opts.multiline
      ? `<textarea class="dgdlg-field" rows="3" placeholder="${esc(opts.placeholder || '')}"${opts.maxLength ? ` maxlength="${+opts.maxLength}"` : ''}>${esc(opts.value || '')}</textarea>`
      : `<input class="dgdlg-field" type="text" value="${esc(opts.value || '')}" placeholder="${esc(opts.placeholder || '')}"${opts.maxLength ? ` maxlength="${+opts.maxLength}"` : ''} autocomplete="off" enterkeyhint="done">`;
    const choices = kind !== 'choose' ? '' : `<div class="dgdlg-choices" role="listbox">${(opts.options || []).map((o, i) => `<button type="button" role="option" data-dgdlg-choice="${i}" aria-selected="${String(o.value === opts.value)}" class="${o.value === opts.value ? 'current' : ''}">${esc(o.label == null ? o.value : o.label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</button>`).join('')}</div>`;
    const cancel = kind === 'alert' ? '' : `<button type="button" class="dgdlg-cancel" data-dgdlg="cancel">${esc(cancelLabel)}</button>`;
    const okBtn = kind === 'choose' ? '' : `<button type="button" class="dgdlg-ok${opts.danger ? ' danger' : ''}" data-dgdlg="ok">${esc(okLabel)}</button>`;
    host.innerHTML = `<div class="dgdlg ${kind}${opts.danger ? ' danger' : ''}" role="${kind === 'alert' ? 'alertdialog' : 'dialog'}" aria-modal="true"${opts.title ? ' aria-labelledby="dgDialogTitle"' : ''} aria-describedby="dgDialogMsg">${title}<div class="dgdlg-msg" id="dgDialogMsg">${lines(message)}</div>${field}${choices}<div class="dgdlg-btns">${cancel}${okBtn}</div></div>`;
    host.hidden = false;
    host.querySelector('[data-dgdlg="ok"]')?.addEventListener('click', ok);
    host.querySelectorAll('[data-dgdlg-choice]').forEach(b => b.addEventListener('click', () => settle(opts.options[+b.dataset.dgdlgChoice].value)));
    host.querySelector('[data-dgdlg="cancel"]')?.addEventListener('click', () => settle(none(kind)));
    const focusTarget = host.querySelector('.dgdlg-field') || host.querySelector('[data-dgdlg-choice].current') || host.querySelector('[data-dgdlg-choice]') || host.querySelector(kind === 'confirm' && opts.danger ? '[data-dgdlg="cancel"]' : '[data-dgdlg="ok"]');
    if (root.DongguUI) root.DongguUI.open(host, { label: opts.title || (kind === 'alert' ? '알림' : kind === 'prompt' ? '입력' : kind === 'choose' ? '선택' : '확인'), close: () => settle(none(kind)) });
    if (focusTarget) { focusTarget.focus({ preventScroll: true }); if (focusTarget.select && !opts.multiline) focusTarget.select(); }
  }
  function ask(kind, message, opts) {
    return new Promise(resolve => {
      const item = { kind, message: String(message == null ? '' : message), opts: opts || {}, resolve, trigger: document.activeElement };
      if (active) queue.push(item); else show(item);
    });
  }
  root.DGDialog = Object.freeze({
    confirm: (message, opts) => ask('confirm', message, opts),
    prompt: (message, opts) => ask('prompt', message, opts),
    alert: (message, opts) => ask('alert', message, opts),
    choose: (message, opts) => ask('choose', message, opts),
    isOpen: () => !!active,
    /* Back key or a screen change while a dialog is up: answer "no" so the flow that asked simply stops. */
    cancel: () => { if (active) settle(none(active.kind)); },
    ok
  });
})(typeof window !== 'undefined' ? window : globalThis);
