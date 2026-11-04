/* Device profile: what kind of device this is (phone / tablet / desktop) and what it can do, decided from input type and
   platform rather than window width. Layout stays width-based (app/desktop.css); features and the home screen follow
   this profile. The person can override it ("화면 방식": 자동 / PC / 휴대폰), stored per device.

   desktop — a mouse is the primary pointer (PCs, touch laptops, narrow PC windows): no GPS, usually no rear camera or
             compass, so field tools (patrol, AR, tilt, camera scan) are offered as PC alternatives.
   phone   — mobile platform (Android phone, iPhone) or a short touch screen.
   tablet  — touch-first large screen (iPad incl. iPadOS that reports as a Mac, Android tablets).
   phone and tablet are "field" devices. */
(function (root) {
  'use strict';
  const KEY = 'dg-device';
  const QUERIES = { coarse: '(pointer:coarse)', anyFine: '(any-pointer:fine)', hover: '(hover:hover)', wide: '(min-width:1024px)', short: '(max-height:500px)', standalone: '(display-mode: standalone)' };
  const mq = q => { try { return root.matchMedia ? root.matchMedia(q) : null; } catch (e) { return null; } };
  const MQ = Object.fromEntries(Object.entries(QUERIES).map(([k, q]) => [k, mq(q)]));
  const on = k => !!(MQ[k] && MQ[k].matches);
  const read = () => { try { const v = root.localStorage.getItem(KEY); return v === 'desktop' || v === 'phone' ? v : 'auto'; } catch (e) { return 'auto'; } };
  const nav = root.navigator || {};

  function detect() {
    const ua = String(nav.userAgent || ''), tp = Number(nav.maxTouchPoints) || 0;
    const iPadOS = /Macintosh/.test(ua) && tp > 1;                       // iPadOS 13+ presents itself as a Mac
    const uaMobile = nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean' ? nav.userAgentData.mobile : /Android.+Mobile|iPhone|iPod|Windows Phone/i.test(ua);
    const uaTablet = iPadOS || /iPad|Android(?!.*Mobile)|Tablet/i.test(ua);
    const touchFirst = on('coarse') || iPadOS;
    if (uaMobile || (touchFirst && on('short') && !on('anyFine'))) return 'phone';
    if (uaTablet || (touchFirst && !on('anyFine'))) return 'tablet';
    if (touchFirst && !on('wide')) return 'phone';                       // a narrow touch-only screen without a mobile UA
    return 'desktop';
  }
  const DEV = { kind: 'desktop', auto: 'desktop', mode: 'auto', field: false, gps: false, hover: false, touch: false, standalone: false, ios: false };
  function compute() {
    const auto = detect(), mode = read(), kind = mode === 'auto' ? auto : mode;
    const ua = String(nav.userAgent || '');
    Object.assign(DEV, {
      kind, auto, mode,
      field: kind !== 'desktop',
      gps: kind !== 'desktop',                                         // PC browsers report Wi-Fi/IP estimates (see docs/navigation.md)
      hover: on('hover'), touch: (Number(nav.maxTouchPoints) || 0) > 0 || on('coarse'),
      standalone: on('standalone') || nav.standalone === true,
      ios: /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (Number(nav.maxTouchPoints) || 0) > 1)
    });
    const html = root.document && root.document.documentElement;
    if (html) { html.dataset.device = kind; html.classList.toggle('dev-field', DEV.field); html.classList.toggle('dev-desktop', !DEV.field); }
    return DEV;
  }
  function changed(prev) { if (prev !== DEV.kind) try { root.dispatchEvent(new CustomEvent('dgdevice', { detail: { from: prev, to: DEV.kind } })); } catch (e) {} }
  function refresh() { const prev = DEV.kind; compute(); changed(prev); }
  function set(mode) {
    const prev = DEV.kind;
    try { if (mode === 'desktop' || mode === 'phone') root.localStorage.setItem(KEY, mode); else root.localStorage.removeItem(KEY); } catch (e) {}
    compute(); changed(prev); return DEV;
  }
  for (const m of Object.values(MQ)) if (m) { if (m.addEventListener) m.addEventListener('change', refresh); else if (m.addListener) m.addListener(refresh); }
  compute();
  root.DEV = DEV;
  root.DongguDevice = Object.freeze({ get: () => DEV, set, refresh, detect, label: k => ({ desktop: 'PC', phone: '휴대폰', tablet: '태블릿' })[k] || k });
})(typeof window !== 'undefined' ? window : globalThis);
