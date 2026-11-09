/* Keyless vehicle handoff only; no road geometry, network request or route optimization.
 * Naver: https://guide-gov.ncloud-docs.com/docs/naveropenapiv3-maps-url-scheme-url-scheme
 * Kakao web: https://apis.map.kakao.com/web/guide/#routeurl
 * Kakao app: https://apis.map.kakao.com/android_v2/docs/api-guide/urlscheme/
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGVisitDriving = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_STOPS = 200, BATCH_STOPS = 6, APP_NAME = 'https://lanian.github.io/donggu-streetlight/';
  const fail = (code = 'invalid-argument') => { throw Object.assign(new Error(code === 'origin-required' ? '카카오맵 차량 경로는 출발 위치를 먼저 정해 주세요.' : '차량 노선을 만들 시설과 좌표를 확인해 주세요.'), { code }); };
  const own = (value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined; }
    catch (_) { return undefined; }
  };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  function point(value, stop, ordinal) {
    if (!object(value) || own(value, 'removed') || own(value, 'posApprox')) fail();
    const lat = own(value, 'lat'), lng = own(value, 'lng');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) fail();
    const id = own(value, 'id'), code = own(value, 'code'), number = own(value, 'ordinal');
    if (stop && (typeof id !== 'string' || !id.trim() || id.length > 200)) fail();
    if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 200)) fail();
    if (code !== undefined && (typeof code !== 'string' || code.length > 300)) fail();
    if (number !== undefined && (!Number.isSafeInteger(number) || number < 1)) fail();
    const out = {};
    if (id !== undefined) out.id = id;
    if (code !== undefined) out.code = code;
    out.lat = lat; out.lng = lng;
    if (number !== undefined || stop) out.ordinal = number === undefined ? ordinal : number;
    return out;
  }
  function destinations(values, limit) {
    if (!Array.isArray(values) || values.length > limit) fail();
    const ids = new Set(), result = [];
    for (let i = 0; i < values.length; i++) {
      const next = point(own(values, String(i)), true, i + 1);
      if (ids.has(next.id)) fail();
      ids.add(next.id); result.push(next);
    }
    return result;
  }
  function safe(run) {
    try { return run(); }
    catch (error) { fail(own(error, 'code') === 'origin-required' ? 'origin-required' : 'invalid-argument'); }
  }
  function makeBatches(stops, origin = null) {
    return safe(() => {
      const visits = destinations(stops, MAX_STOPS), begin = origin === null ? null : point(origin, false);
      const batches = [];
      for (let offset = 0; offset < visits.length; offset += BATCH_STOPS) {
        const start = offset ? { ...visits[offset - 1] } : begin && { ...begin };
        batches.push({ index: batches.length, start, stops: visits.slice(offset, offset + BATCH_STOPS).map(stop => ({ ...stop })) });
      }
      return batches;
    });
  }
  function makeUrl(batch, provider) {
    return safe(() => {
      if (!object(batch) || !['naver', 'kakao-web', 'kakao-app'].includes(provider)) fail();
      const stops = destinations(own(batch, 'stops'), BATCH_STOPS);
      if (!stops.length) fail();
      const rawStart = own(batch, 'start'), start = rawStart == null ? null : point(rawStart, false);
      const end = stops[stops.length - 1], via = stops.slice(0, -1);
      const label = (stop, fallback) => stop.code && stop.code.trim() ? stop.code : stop.id || fallback;
      const ll = stop => stop.lat + ',' + stop.lng;
      if (provider === 'naver') {
        const source = start ? 'slat=' + start.lat + '&slng=' + start.lng + '&sname=' + encode(label(start, '출발지')) + '&' : '';
        const through = via.map((stop, i) => '&v' + (i + 1) + 'lat=' + stop.lat + '&v' + (i + 1) + 'lng=' + stop.lng + '&v' + (i + 1) + 'name=' + encode(label(stop, '방문지'))).join('');
        return 'nmap://route/car?' + source + 'dlat=' + end.lat + '&dlng=' + end.lng + '&dname=' + encode(label(end, '도착지')) + through + '&appname=' + encode(APP_NAME);
      }
      if (!start) fail('origin-required');
      if (provider === 'kakao-web') return 'https://map.kakao.com/link/by/car/' + [start, ...stops].map((stop, i) => encode(label(stop, i ? '방문지' : '출발지')) + ',' + ll(stop)).join('/');
      return 'kakaomap://route?sp=' + ll(start) + via.map((stop, i) => '&vp' + (i ? i + 1 : '') + '=' + ll(stop)).join('') + '&ep=' + ll(end) + '&by=car';
    });
  }
  return { makeBatches, makeUrl };
});
