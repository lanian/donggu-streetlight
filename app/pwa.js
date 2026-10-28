/* Service-worker UI and provider selection. Only a deliberate, clean-page update may reload. */
(function () {
  "use strict";
  const state = { registration: null, waiting: null, requested: false, reloadReady: false, status: null, preparing: false, message: '' };
  let options = {};
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function provider() {
    const fallback = { name: 'OpenStreetMap 온라인 지도', urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19, offlineAllowed: false };
    const p = globalThis.DONGGU_MAP_PROVIDER;
    if (!p) return { ...fallback, reason: '오프라인 지도를 허용한 제공기관이 설정되지 않았어요. OSM 배경지도는 온라인 이용만 안내해요.' };
    if (p.requiresKey && !p.apiKey) return { ...fallback, reason: '지정한 지도 제공기관의 공개 API 키가 없어 온라인 기본 지도를 사용해요.' };
    try {
      const template = String(p.urlTemplate || '').replaceAll('{key}', encodeURIComponent(p.apiKey || ''));
      const url = new URL(template, document.baseURI);
      if (!(url.protocol === 'https:' || url.origin === location.origin) || !['{z}', '{x}', '{y}'].every(k => template.includes(k))) throw new Error('template');
      const osm = /(^|\.)openstreetmap\.org$/.test(url.hostname);
      return { ...p, urlTemplate: template, maxZoom: p.maxZoom || 19, offlineAllowed: !osm && p.offlineAllowed === true, reason: osm ? 'OSM 배경지도는 온라인 이용만 안내해요.' : p.offlineAllowed === true ? '이용 허가된 지도에서 현재 화면으로 본 타일만 보관해요. 지역 전체 다운로드 기능은 제공하지 않아요.' : '이 제공기관의 오프라인 저장 허가가 설정되지 않았어요.' };
    } catch (_) { return { ...fallback, reason: '지도 제공기관 설정이 올바르지 않아 온라인 기본 지도를 사용해요.' }; }
  }
  function tileLayer(L, extra = {}) {
    const p = provider();
    return L.tileLayer(p.urlTemplate, { maxZoom: p.maxZoom, attribution: p.attribution || p.name || '', ...extra });
  }
  function panelHTML() {
    return '<details class="help offline-panel"><summary>오프라인 준비와 앱 업데이트</summary><div id="offlineStatus" role="status" aria-live="polite">준비 상태를 확인하려면 아래 버튼을 누르세요.</div><div class="split"><button class="btn ghost sm" id="offlineCheck">준비 상태 확인</button><button class="btn ghost sm" id="offlinePrepare">OCR 파일 준비</button><button class="btn sodium sm" id="pwaReload" hidden>새 버전 적용</button></div><p class="muted">대장·앱 화면·QR과 OCR 파일 준비를 각각 확인해요. 공유 저장은 연결 상태에 따라 달라요. 브라우저가 저장 공간을 비우면 다시 준비해야 해요.</p><p class="muted" id="offlineMapNote">' + escape(provider().reason) + '</p></details>';
  }
  function render() {
    const el = document.getElementById('offlineStatus'), apply = document.getElementById('pwaReload'), prepare = document.getElementById('offlinePrepare');
    const summary = document.querySelector?.('.offline-panel summary');
    if (summary) summary.textContent = '오프라인 준비와 앱 업데이트' + (state.waiting || state.reloadReady ? ' · 새 버전 있음' : '');
    if (apply) apply.hidden = !state.waiting && !state.reloadReady;
    if (prepare) prepare.disabled = state.preparing;
    if (!el) return;
    const s = state.status;
    el.textContent = state.message || (s ? `필수 앱 자산: ${s.shell ? '준비됨' : '미완료'} · 대장: ${s.registry ? '준비됨' : '미완료'} · OCR 파일: ${s.ocr ? '준비됨' : '미완료'}${state.waiting ? ' · 새 버전 대기 중' : ''}` : state.waiting ? '새 버전이 있어요. 작성 중인 기록을 저장한 뒤 적용하세요.' : '준비 상태를 확인하려면 아래 버튼을 누르세요.');
  }
  function workerStatus() {
    return new Promise((resolve, reject) => {
      const worker = navigator.serviceWorker?.controller;
      if (!worker) { reject(new Error('앱 저장 준비가 아직 끝나지 않았어요. 연결된 상태로 잠시 후 다시 확인하세요.')); return; }
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('준비 상태 응답이 없어요. 잠시 후 다시 확인하세요.')); }, 5000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
      worker.postMessage({ type: 'offline-status' }, [channel.port2]);
    });
  }
  async function check() {
    state.message = '준비 상태를 확인하는 중…'; render();
    try { state.status = await workerStatus(); state.message = ''; }
    catch (e) { state.message = e.message; }
    render(); return state.status;
  }
  async function prepare() {
    if (state.preparing) return;
    if (!navigator.serviceWorker?.controller) { await check(); return; }
    if (!navigator.onLine) { state.message = 'OCR 파일은 연결된 상태에서 준비하세요. QR과 직접 입력은 준비된 앱에서 사용할 수 있어요.'; render(); return; }
    state.preparing = true; state.message = 'OCR 한국어·영어 엔진과 언어 파일을 준비하는 중… (약 10MB, 연결 상태에 따라 1~3분)'; render();
    let timer;
    try {
      await Promise.race([options.prepareOcr(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('준비가 오래 걸리고 있어요(약 10MB). 내려받기는 계속되니 잠시 뒤 상태를 다시 확인하세요.')), 180000); })]);
      await check();
      if (!state.status?.ocr) state.message = 'OCR을 실행했지만 필수 캐시 파일을 모두 확인하지 못했어요. 오프라인 준비가 완료된 것으로 표시하지 않았어요.';
    } catch (e) { state.message = e.message || 'OCR 파일 준비에 실패했어요. 연결을 확인하고 다시 시도하세요.'; }
    finally { clearTimeout(timer); state.preparing = false; render(); }
  }
  async function pending() { try { return !!(await options.hasPendingWork?.()); } catch (_) { return true; } }
  async function applyUpdate() {
    if (!state.waiting && !state.reloadReady) return false;
    if (await pending()) { options.notice?.('작성 중인 기록과 전송 대기를 먼저 저장·동기화하고, 열린 화면을 닫은 뒤 새 버전을 적용하세요.'); return false; }
    if (state.reloadReady) { location.reload(); return true; }
    state.requested = true; state.waiting.postMessage({ type: 'activate-update' });
    state.message = '새 버전을 적용하는 중…'; render(); return true;
  }
  function start(config) {
    options = config;
    if (!('serviceWorker' in navigator)) return;
    let controlled = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      state.reloadReady = controlled; controlled = true; state.waiting = null;
      if (state.requested) {
        state.requested = false;
        if (!(await pending())) { location.reload(); return; }
        state.message = '업데이트가 준비됐어요. 작성 중인 기록을 저장한 뒤 앱을 다시 열어 주세요.';
      }
      else if (state.reloadReady) state.message = '다른 화면에서 새 버전을 적용했어요. 작성 중인 기록을 마치고 새 버전 적용을 눌러 주세요.';
      render();
    });
    const register = () => navigator.serviceWorker.register('sw.js').then(reg => {
      state.registration = reg;
      const waiting = worker => { state.waiting = worker; state.message = ''; render(); };
      if (reg.waiting) waiting(reg.waiting);
      const watch = w => w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) waiting(reg.waiting || w); });
      watch(reg.installing); reg.addEventListener('updatefound', () => watch(reg.installing));
    }).catch(() => { state.message = '필수 앱 파일을 저장하지 못했어요. 오프라인 사용 전 연결 상태에서 다시 확인하세요.'; render(); });
    if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
    document.addEventListener('click', e => { const id = e.target.closest('button')?.id; if (id === 'offlineCheck') check(); else if (id === 'offlinePrepare') prepare(); });
  }
  window.DongguPWA = { start, applyUpdate, check, panelHTML, render, provider, tileLayer };
})();
