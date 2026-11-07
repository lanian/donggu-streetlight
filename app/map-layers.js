/* Online background maps only. Imagery is never an offline-package source. */
(function (root) {
  'use strict';
  const MODES = ['street', 'satellite', 'hybrid'];
  const PREFERENCE = 'dg-map-background-v1';
  const IMAGE_PANE = 'dgSatellitePane', LABEL_PANE = 'dgSatelliteLabelsPane';
  const CREDIT = '© <a href="https://www.vworld.kr/" target="_blank" rel="noopener">국토교통부 VWorld</a>';

  function imageryConfig() {
    const config = root.DONGGU_SATELLITE_CONFIG || {}, key = config.apiKey;
    if (typeof key !== 'string' || !key || key.length > 256 || key === '.' || key === '..' || /[\u0000-\u0020\u007f-\u009f]/.test(key)) return null;
    try {
      return { encodedKey: encodeURIComponent(key), maxNativeZoom: Number.isInteger(config.maxNativeZoom) && config.maxNativeZoom > 0 ? Math.min(18, config.maxNativeZoom) : 18 };
    } catch (_) { return null; }
  }
  function preferredMode() {
    try { const mode = root.localStorage.getItem(PREFERENCE); return MODES.includes(mode) ? mode : 'street'; }
    catch (_) { return 'street'; }
  }
  function remember(mode) { try { root.localStorage.setItem(PREFERENCE, mode); } catch (_) { /* Display preferences are optional. */ } }

  function create(L, streetProvider, extra = {}) {
    const group = L.layerGroup(), config = imageryConfig();
    const inheritedAdd = group.onAdd, inheritedRemove = group.onRemove;
    const maxZoom = extra.maxZoom ?? streetProvider.maxZoom ?? 19;
    let mode = config ? preferredMode() : 'street', epoch = 0;
    let map = null, removed = false, control = null, box = null, select = null, note = null, cleanControl = null;
    let bindings = [], message = config ? '' : '위성 지도 연결 준비 중';
    const connected = () => !map || map.getContainer().isConnected !== false;

    function preparePanes() {
      if (!map) return;
      for (const [name, z] of [[IMAGE_PANE, 200], [LABEL_PANE, 201]]) {
        const pane = map.getPane(name) || map.createPane(name);
        pane.style.zIndex = String(z); pane.style.filter = 'none'; pane.style.pointerEvents = 'none';
      }
    }
    function releaseTiles() {
      epoch++;
      for (const [tile, error, load] of bindings) { tile.off('tileerror', error); tile.off('tileload', load); }
      bindings = []; group.clearLayers();
    }
    function tile(url, options) {
      const layer = L.tileLayer(url, options), generation = epoch;
      let failures = 0;
      const current = () => !!map && !removed && connected() && epoch === generation;
      const load = () => { if (current()) failures = 0; };
      const error = e => {
        if (!current()) return;
        failures++;
        // Do not propagate provider URLs, DOM image src or raw provider errors containing the key.
        group.fire('tileerror', { mode, coords: e?.coords });
        if (mode !== 'street' && failures >= 4 && current()) change('street', false, 'tile-failure');
      };
      layer.on('tileerror', error); layer.on('tileload', load); bindings.push([layer, error, load]); group.addLayer(layer);
    }
    function renderControl() {
      if (select) select.value = mode;
      if (note) { note.textContent = message; note.hidden = !message; }
    }
    function replaceTiles() {
      releaseTiles();
      if (mode === 'street') {
        tile(streetProvider.urlTemplate, { maxZoom, attribution: streetProvider.attribution || streetProvider.name || '', ...extra });
      } else {
        preparePanes();
        const common = { ...extra, maxZoom, maxNativeZoom: config.maxNativeZoom, attribution: CREDIT, offlineAllowed: false, detectRetina: false, tms: false, zoomOffset: 0, zoomReverse: false };
        const prefix = 'https://api.vworld.kr/req/wmts/1.0.0/' + config.encodedKey + '/';
        tile(prefix + 'Satellite/{z}/{y}/{x}.jpeg', { ...common, pane: IMAGE_PANE, zIndex: 1 });
        if (mode === 'hybrid') tile(prefix + 'Hybrid/{z}/{y}/{x}.png', { ...common, pane: LABEL_PANE, zIndex: 2 });
      }
    }
    function change(next, persist, reason) {
      if (removed || !connected() || !MODES.includes(next) || next !== 'street' && !config) return group;
      if (persist) remember(next);
      if (next === mode) { if (persist) { message = config ? '' : '위성 지도 연결 준비 중'; renderControl(); } return group; }
      const previousMode = mode; mode = next;
      message = reason === 'tile-failure' ? '위성 사진을 불러오지 못해 일반 지도로 전환했어요.' : config ? '' : '위성 지도 연결 준비 중';
      replaceTiles(); renderControl();
      group.fire('mapmodechange', { mode, previousMode, reason });
      return group;
    }
    function buildControl() {
      box = root.document.createElement('div'); box.className = 'dg-map-layers leaflet-control';
      if (map.getContainer().querySelector?.('.locbtn')) box.className += ' dg-map-layers-below-location';
      const label = root.document.createElement('label'), title = root.document.createElement('span');
      title.textContent = '지도 배경'; label.appendChild(title);
      select = root.document.createElement('select'); select.setAttribute('aria-label', '지도 배경');
      for (const [value, text] of [['street', '일반 지도'], ['satellite', '위성·항공사진'], ['hybrid', '사진＋도로명']]) {
        const option = root.document.createElement('option'); option.value = value; option.textContent = text; option.disabled = value !== 'street' && !config; select.appendChild(option);
      }
      label.appendChild(select); box.appendChild(label);
      note = root.document.createElement('div'); note.className = 'dg-map-layers-note'; note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite'); box.appendChild(note);
      const owner = box, input = select;
      const changeInput = () => { if (map && !removed && connected() && box === owner) { change(input.value, true, 'manual'); renderControl(); } };
      const stop = e => L.DomEvent.stopPropagation(e);
      input.addEventListener('change', changeInput);
      // Keep native select keyboard behavior while isolating the map's shortcuts and editors.
      const events = ['click', 'dblclick', 'mousedown', 'touchstart', 'pointerdown', 'wheel', 'keydown', 'keyup', 'input', 'change'];
      for (const event of events) owner.addEventListener(event, stop);
      L.DomEvent.disableClickPropagation(owner); L.DomEvent.disableScrollPropagation(owner);
      cleanControl = () => { input.removeEventListener('change', changeInput); for (const event of events) owner.removeEventListener(event, stop); L.DomEvent.off(owner); owner.remove?.(); };
      renderControl(); return box;
    }
    function removeControl() {
      control?.remove(); control = null; cleanControl?.(); cleanControl = null; box = select = note = null;
    }
    group.onAdd = function (target) {
      map = target; removed = false;
      // A removed layer may be reattached; stale handlers and controls remain retired.
      preparePanes();
      if (!group.getLayers().length) replaceTiles();
      inheritedAdd.call(group, target);
      const patrolHost = target.getContainer().closest?.('#ptMapBox');
      if (patrolHost) { const element = buildControl(); element.classList.add('dg-map-layers-patrol'); patrolHost.appendChild(element); }
      else { control = L.control({ position: 'topright' }); control.onAdd = buildControl; control.addTo(target); }
    };
    group.onRemove = function (target) {
      removed = true; map = null; epoch++;
      removeControl(); inheritedRemove.call(group, target); releaseTiles();
    };
    group.getMode = () => mode;
    group.setMode = next => change(next, true, 'manual');
    replaceTiles();
    return group;
  }
  root.DongguMapLayers = { create };
})(globalThis);
