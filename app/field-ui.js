/* One focus owner for stacked sheets, photo editors, and patrol. No backend access. */
(function () {
  "use strict";
  const stack = [];
  const candidates = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const visible = el => !el.hidden && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0;
  const controls = el => [...el.querySelectorAll(candidates)].filter(visible);
  function sync() {
    const top = stack.at(-1);
    for (const entry of stack) entry.el.inert = entry !== top;
    for (const main of document.querySelectorAll('.wrap,nav.tabs')) main.inert = !!top;
  }
  function focus(entry) {
    if (!entry || !entry.el.isConnected) return;
    entry.el.tabIndex = -1;
    (controls(entry.el)[0] || entry.el).focus({ preventScroll: true });
  }
  function open(el, { label = '상세 화면', close } = {}) {
    const existing = stack.find(e => e.el === el);
    if (existing) { existing.close = close; el.setAttribute('aria-label', label); sync(); focus(existing); return; }
    const entry = { el, close, trigger: document.activeElement };
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', label);
    stack.push(entry); sync(); focus(entry);
  }
  function close(el) {
    const i = stack.findIndex(e => e.el === el);
    if (i < 0) return;
    const wasTop = i === stack.length - 1, entry = stack.splice(i, 1)[0];
    el.inert = false; sync();
    if (!wasTop) return;
    if (entry.trigger?.isConnected && visible(entry.trigger)) entry.trigger.focus({ preventScroll: true });
    else if (stack.length) focus(stack.at(-1));
    else document.querySelector('nav [aria-selected="true"],.wrap button')?.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', e => {
    const top = stack.at(-1);
    if (!top) return;
    if (e.key === 'Escape' && top.close) { e.preventDefault(); e.stopPropagation(); top.close(); return; }
    if (e.key !== 'Tab') return;
    const list = controls(top.el), first = list[0], last = list.at(-1);
    if (!first) { e.preventDefault(); top.el.focus(); }
    else if (e.shiftKey && (document.activeElement === first || !top.el.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !top.el.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }, true);
  document.addEventListener('focusin', e => {
    const top = stack.at(-1);
    if (top && !top.el.contains(e.target)) focus(top);
  });
  document.addEventListener('DOMContentLoaded', () => {
    for (const id of ['ovl', 'cmpSheet', 'ptFull']) {
      const el = document.getElementById(id); if (!el) continue;
      const update = () => {
        if (el.hidden) { close(el); return; }
        if (stack.some(e => e.el === el)) return;
        open(el, { label: el.querySelector('b,h2,h3')?.textContent || '사진과 현장 확인', close: () => {
          const button = el.querySelector('.x,#ptEnd,[data-close]'); if (button) button.click();
        }});
      };
      new MutationObserver(update).observe(el, { attributes: true, attributeFilter: ['hidden'] }); update();
    }
  });
  window.DongguUI = { open, close, hasModal: () => stack.length > 0 };
})();
