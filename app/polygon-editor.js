/* Local polygon editing only. Final geometry, authorization and storage belong to the area editor. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DGPolygonEditor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_POINTS = 32, MAX_HISTORY = 50;
  const fail = message => { throw new Error(message); };
  function text(value) {
    if (typeof value !== 'string') fail('경계점 좌표는 텍스트로 입력해 주세요.');
    return value;
  }
  function point(value) {
    if (!value || typeof value !== 'object' || typeof value.lat !== 'number' || typeof value.lng !== 'number' ||
      !Number.isFinite(value.lat) || Math.abs(value.lat) > 85 || !Number.isFinite(value.lng) || Math.abs(value.lng) > 180) {
      fail('경계점의 위도·경도 좌표 범위를 확인해 주세요.');
    }
    return { lat: value.lat, lng: value.lng };
  }
  function points(value) {
    const lines = text(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > MAX_POINTS) fail('경계점은 최대 32개예요. 구역을 나누어 등록해 주세요.');
    return lines.map((line, index) => {
      const parts = line.split(',').map(part => part.trim());
      if (parts.length !== 2 || parts.some(part => !part || !Number.isFinite(Number(part)))) fail((index + 1) + '번째 경계점은 위도, 경도 순서로 입력해 주세요.');
      return point({ lat: Number(parts[0]), lng: Number(parts[1]) });
    });
  }
  function format(values) {
    if (!Array.isArray(values)) fail('경계점 좌표 목록을 확인해 주세요.');
    if (values.length > MAX_POINTS) fail('경계점은 최대 32개예요. 구역을 나누어 등록해 주세요.');
    return values.map(value => { const p = point(value); return p.lat + ', ' + p.lng; }).join('\n');
  }
  function state(session) {
    if (!session || typeof session !== 'object' || typeof session.text !== 'string' || !Array.isArray(session.undoStack) || !Array.isArray(session.redoStack)) {
      fail('다각형 편집 상태를 다시 열어 주세요.');
    }
    return session;
  }
  function snapshot(session) { return { text: session.text, selected: session.selected }; }
  function push(stack, value) { stack.push(value); if (stack.length > MAX_HISTORY) stack.shift(); }
  function indexOf(values, index) {
    if (!Number.isInteger(index) || index < 0 || index >= values.length) fail('수정할 경계점을 다시 선택해 주세요.');
    return index;
  }
  function selection(value, index) { return index == null ? null : indexOf(points(value), index); }
  function create(value = '') { return { text: text(value), selected: null, undoStack: [], redoStack: [] }; }
  function update(session, value, selected = null) {
    state(session); text(value);
    const nextSelection = selection(value, selected);
    if (value === session.text) { session.selected = nextSelection; return false; }
    push(session.undoStack, snapshot(session)); session.redoStack.length = 0;
    session.text = value; session.selected = nextSelection;
    return true;
  }
  function select(session, index) { state(session); session.selected = selection(session.text, index); return session.selected; }
  function canUndo(session) { return state(session).undoStack.length > 0; }
  function canRedo(session) { return state(session).redoStack.length > 0; }
  function travel(session, source, destination) {
    state(session);
    if (!source.length) return false;
    const previous = source.pop(); push(destination, snapshot(session));
    session.text = previous.text; session.selected = previous.selected;
    return true;
  }
  function undo(session) { state(session); return travel(session, session.undoStack, session.redoStack); }
  function redo(session) { state(session); return travel(session, session.redoStack, session.undoStack); }
  function add(session, value) {
    state(session); const values = points(session.text);
    if (values.length >= MAX_POINTS) fail('경계점은 최대 32개예요. 마지막 점을 취소하거나 구역을 나누어 주세요.');
    values.push(point(value)); return update(session, format(values), values.length - 1);
  }
  function move(session, index, value) {
    state(session); const values = points(session.text), at = indexOf(values, index), next = point(value);
    if (values[at].lat === next.lat && values[at].lng === next.lng) { select(session, at); return false; }
    values[at] = next; return update(session, format(values), at);
  }
  function remove(session, index) {
    state(session); const values = points(session.text), at = indexOf(values, index);
    values.splice(at, 1); return update(session, format(values));
  }
  function insert(session, afterIndex, value) {
    state(session); const values = points(session.text), at = indexOf(values, afterIndex);
    if (values.length >= MAX_POINTS) fail('경계점은 최대 32개예요. 마지막 점을 취소하거나 구역을 나누어 주세요.');
    const a = values[at], b = values[(at + 1) % values.length];
    const next = value === undefined ? point({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }) : point(value);
    values.splice(at + 1, 0, next); return update(session, format(values), at + 1);
  }
  return { create, update, select, undo, redo, canUndo, canRedo, points, format, add, move, remove, insert };
});
