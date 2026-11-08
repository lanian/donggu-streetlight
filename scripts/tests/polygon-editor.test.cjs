const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.resolve(__dirname, '../../app/polygon-editor.js');
const helper = fs.existsSync(modulePath) ? require(modulePath) : {};
function api() {
  for (const name of ['create', 'update', 'select', 'undo', 'redo', 'canUndo', 'canRedo', 'points', 'format', 'add', 'move', 'remove', 'insert']) {
    assert.equal(typeof helper[name], 'function', 'polygon editor must provide ' + name);
  }
  return helper;
}
const triangle = [{ lat: 35.1, lng: 126.9 }, { lat: 35.102, lng: 126.9 }, { lat: 35.102, lng: 126.904 }];
const before = session => JSON.stringify(session);

test('an empty edit session supports incomplete geometry without fabricating points or undo steps', () => {
  const h = api(), session = h.create();
  assert.equal(session.text, ''); assert.equal(session.selected, null);
  assert.deepEqual(h.points(session.text), []);
  assert.equal(h.canUndo(session), false); assert.equal(h.canRedo(session), false);
  assert.equal(h.undo(session), false); assert.equal(h.redo(session), false);
  assert.equal(h.update(session, ''), false);
  h.add(session, triangle[0]);
  assert.deepEqual(h.points(session.text), [triangle[0]]);
  assert.equal(session.selected, 0);
});

test('coordinate parsing tolerates spacing and blank lines while preserving decimal precision', () => {
  const h = api();
  assert.deepEqual(h.points(' \r\n 35.1234567 , 126.9876543\r\n\n-85, -180\n85,180\n'), [
    { lat: 35.1234567, lng: 126.9876543 }, { lat: -85, lng: -180 }, { lat: 85, lng: 180 }
  ]);
  assert.equal(h.format(triangle), '35.1, 126.9\n35.102, 126.9\n35.102, 126.904');
  const source = JSON.parse(JSON.stringify(triangle));
  const text = h.format(source); h.points(text)[0].lat = 0;
  assert.deepEqual(source, triangle, 'parsing and formatting never retain caller point references');
});

test('invalid or excessive coordinate text fails with a readable error', () => {
  const h = api();
  for (const raw of ['35.1', ',126.9', '35.1,', '35.1,126.9,0', 'x,126.9', 'Infinity,126.9', '85.001,0', '0,-180.001']) {
    assert.throws(() => h.points(raw), /경계점|좌표|위도|경도/, raw);
  }
  for (const raw of [null, 1, {}, []]) assert.throws(() => h.points(raw), /좌표|텍스트/);
  assert.throws(() => h.points(Array.from({ length: 33 }, (_, i) => '35.1, ' + (126 + i / 1000)).join('\n')), /32/);
});

test('moving a middle vertex preserves ring order and creates one undoable replacement', () => {
  const h = api(), session = h.create(h.format(triangle)), next = { lat: 35.1034567, lng: 126.9012345 };
  h.select(session, 1);
  assert.equal(h.move(session, 1, next), true);
  assert.deepEqual(h.points(session.text), [triangle[0], next, triangle[2]]);
  assert.equal(session.selected, 1); assert.equal(session.undoStack.length, 1);
  assert.equal(h.undo(session), true); assert.deepEqual(h.points(session.text), triangle); assert.equal(session.selected, 1);
  assert.equal(h.redo(session), true); assert.deepEqual(h.points(session.text)[1], next);
});

test('inserting an edge midpoint preserves the following vertices and supports the closing edge', () => {
  const h = api(), session = h.create(h.format(triangle));
  assert.equal(h.insert(session, 0), true);
  const midpoint = { lat: (triangle[0].lat + triangle[1].lat) / 2, lng: 126.9 };
  assert.deepEqual(h.points(session.text), [triangle[0], midpoint, triangle[1], triangle[2]]);
  assert.equal(session.selected, 1);
  h.undo(session);
  assert.equal(h.insert(session, 2), true);
  const closing = { lat: (triangle[2].lat + triangle[0].lat) / 2, lng: (triangle[2].lng + triangle[0].lng) / 2 };
  assert.deepEqual(h.points(session.text), [...triangle, closing]);
  assert.equal(session.selected, 3);
});

test('explicit edge insertion uses its supplied point without mutating the source object', () => {
  const h = api(), session = h.create(h.format(triangle)), point = { lat: 35.103, lng: 126.903, extra: 'ignore' };
  h.insert(session, 1, point);
  assert.deepEqual(h.points(session.text), [triangle[0], triangle[1], { lat: point.lat, lng: point.lng }, triangle[2]]);
  point.lat = 0;
  assert.equal(h.points(session.text)[2].lat, 35.103);
});

test('selected deletion can leave an incomplete draft and undo restores text and selection together', () => {
  const h = api(), text = h.format(triangle), session = h.create(text);
  h.select(session, 1); h.remove(session, 1);
  assert.deepEqual(h.points(session.text), [triangle[0], triangle[2]]);
  assert.equal(session.selected, null);
  h.undo(session); assert.equal(session.text, text); assert.equal(session.selected, 1);
  h.redo(session); assert.equal(session.selected, null);
});

test('manual malformed text is retained exactly and can be undone and redone', () => {
  const h = api(), text = h.format(triangle), session = h.create(text), raw = '  35.1, 126.9\n오타\n';
  h.select(session, 2);
  assert.equal(h.update(session, raw), true);
  assert.equal(session.text, raw); assert.equal(session.selected, null);
  assert.equal(h.undo(session), true); assert.equal(session.text, text); assert.equal(session.selected, 2);
  assert.equal(h.redo(session), true); assert.equal(session.text, raw); assert.equal(session.selected, null);
});

test('selection changes and unchanged geometry do not consume undo history or erase redo', () => {
  const h = api(), session = h.create(h.format(triangle));
  h.move(session, 1, { lat: 35.104, lng: 126.9 }); h.undo(session);
  h.select(session, 2);
  assert.equal(h.canUndo(session), false); assert.equal(h.canRedo(session), true);
  assert.equal(h.update(session, session.text, 1), false);
  assert.equal(session.selected, 1); assert.equal(h.canRedo(session), true);
  assert.equal(h.move(session, 1, triangle[1]), false);
  assert.equal(h.canUndo(session), false); assert.equal(h.canRedo(session), true);
});

test('a new edit after undo replaces the redo branch without sharing history across sessions', () => {
  const h = api(), one = h.create(h.format(triangle)), two = h.create(h.format(triangle));
  h.move(one, 0, { lat: 35.1001, lng: 126.9 }); h.undo(one);
  assert.equal(h.canRedo(one), true);
  h.add(one, { lat: 35.099, lng: 126.902 });
  assert.equal(h.canRedo(one), false); assert.equal(h.canUndo(two), false); assert.equal(h.canRedo(two), false);
  assert.deepEqual(h.points(two.text), triangle);
});

test('only the most recent fifty geometry edits are retained', () => {
  const h = api(), session = h.create('');
  for (let i = 1; i <= 60; i++) h.update(session, String(i));
  assert.equal(session.undoStack.length, 50);
  for (let i = 0; i < 50; i++) assert.equal(h.undo(session), true);
  assert.equal(session.text, '10'); assert.equal(h.undo(session), false);
  for (let i = 0; i < 50; i++) assert.equal(h.redo(session), true);
  assert.equal(session.text, '60'); assert.equal(h.redo(session), false);
});

test('adding or inserting a thirty-third point fails before any draft or history mutation', () => {
  const h = api(), points = Array.from({ length: 32 }, (_, i) => ({ lat: 35 + i / 10000, lng: 126.9 }));
  for (const mutate of [s => h.add(s, { lat: 35.2, lng: 126.9 }), s => h.insert(s, 4)]) {
    const session = h.create(h.format(points)), snapshot = before(session);
    assert.throws(() => mutate(session), /32/); assert.equal(before(session), snapshot);
  }
});

test('structural edits reject invalid source text, point values, and indices without losing the draft', () => {
  const h = api();
  for (const mutate of [s => h.add(s, triangle[0]), s => h.move(s, 0, triangle[0]), s => h.remove(s, 0), s => h.insert(s, 0)]) {
    const session = h.create('35.1,\nunfinished'), snapshot = before(session);
    assert.throws(() => mutate(session), /경계점|좌표/); assert.equal(before(session), snapshot);
  }
  for (const mutate of [s => h.move(s, -1, triangle[0]), s => h.move(s, 3, triangle[0]), s => h.remove(s, '1'), s => h.insert(s, 1.5), s => h.select(s, 9)]) {
    const session = h.create(h.format(triangle)), snapshot = before(session);
    assert.throws(() => mutate(session), /경계점|선택/); assert.equal(before(session), snapshot);
  }
  for (const point of [{ lat: '', lng: 126.9 }, { lat: '35', lng: 126.9 }, { lat: null, lng: 126.9 }, { lat: NaN, lng: 126.9 }, { lat: 35, lng: 181 }, { lat: 86, lng: 126.9 }]) {
    const session = h.create(h.format(triangle)), snapshot = before(session);
    assert.throws(() => h.move(session, 0, point), /경계점|좌표|위도|경도/); assert.equal(before(session), snapshot);
    assert.throws(() => h.add(session, point)); assert.equal(before(session), snapshot);
  }
});

test('session updates reject non-text values without running coercion or changing existing state', () => {
  const h = api(), session = h.create(h.format(triangle)), snapshot = before(session);
  const value = { toString() { throw new Error('coercion must not run'); } };
  assert.throws(() => h.update(session, value), /텍스트/);
  assert.equal(before(session), snapshot);
});

test('the browser global is independent of DOM, storage, network and CommonJS', () => {
  api();
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: 'polygon-editor.js' });
  assert.equal(typeof sandbox.DGPolygonEditor.create, 'function');
  const session = sandbox.DGPolygonEditor.create('');
  sandbox.DGPolygonEditor.add(session, { lat: 35, lng: 126 });
  assert.equal(session.text, '35, 126');
  sandbox.DGPolygonEditor.undo(session); assert.equal(session.text, '');
});
