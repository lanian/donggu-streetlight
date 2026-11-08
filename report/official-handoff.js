/* Read-only handoff to the operating service. No request, storage or receipt is created here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGOfficialHandoff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ORIGIN = 'https://gjd.roadlighting.kr', ROOT = ORIGIN + '/slamp/';
  const MAP = '/slamp/repair/map', STATUS = '/slamp/repair/status';
  function approved(url) {
    if (typeof url !== 'string' || !/^https:\/\/gjd\.roadlighting\.kr(?::443)?(?:\/|$)/i.test(url) || /[\\\u0000-\u0020\u007f?#]/.test(url)) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'gjd.roadlighting.kr' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      return parsed;
    } catch (_) { return null; }
  }
  function destination(url) {
    const parsed = approved(url); if (!parsed) return null;
    if (['/', '/slamp', '/slamp/'].includes(parsed.pathname)) return ROOT;
    return parsed.pathname === MAP ? ORIGIN + MAP : null;
  }
  function statusDestination(url) {
    const parsed = approved(url);
    return parsed && parsed.pathname === STATUS ? ORIGIN + STATUS : null;
  }
  function read(value, key) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && Object.prototype.hasOwnProperty.call(property, 'value') ? property.value : undefined;
  }
  const text = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const clean = value => text(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const oneLine = (value, limit) => clean(value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
  const internalId = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\s\u0000-\u001f\u007f/\\]/.test(value);
  function operatingId(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    if (typeof value !== 'string' || !value || value.length > 180 || /[\s\u0000-\u001f\u007f/\\]/.test(value)) return null;
    return value;
  }
  function summary(input) {
    const facility = read(input, 'facility'), id = read(input, 'lightId');
    const matched = internalId(id) && read(facility, 'id') === id;
    const registryCode = matched ? oneLine(read(facility, 'code'), 200) : '';
    const confirmed = matched && !!registryCode;
    const code = confirmed ? registryCode : oneLine(read(input, 'code'), 200);
    const lampId = confirmed ? operatingId(read(facility, 'lampId')) : null;
    const issue = oneLine(read(input, 'issue'), 120), desc = clean(read(input, 'desc')).slice(0, 500);
    const lines = ['[가로등 고장 신고 메모 · 접수 전]', '이 메모만으로 신고가 접수되지는 않아요.',
      (confirmed ? '대장에서 확인한 표찰: ' : '입력한 표찰(대장 미확인): ') + (code || '(모름)')];
    if (lampId !== null) lines.push('운영 시설번호: ' + lampId);
    lines.push('문제: ' + (issue || '(운영서비스에서 선택)'), '내용:', desc.trim() ? desc : '(운영서비스에서 작성)');
    return lines.join('\n');
  }
  return { destination, statusDestination, summary };
});
