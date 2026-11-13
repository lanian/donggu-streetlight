const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../app/operations-core');

// Reordering from the plan map only rearranges the stops still to visit; finished stops keep their place.
const stops = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
const done = new Set(['a', 'c']);
const ids = rows => rows.map(row => row.id);
const isDone = stop => done.has(stop.id);

test('"다음 방문지로" puts the stop at the first unfinished position', () => {
  assert.deepEqual(ids(C.moveOpenStop(stops, 'e', 'next', isDone)), ['a', 'e', 'c', 'b', 'd']);
});
test('one step earlier or later swaps with the neighbouring unfinished stop, skipping finished ones', () => {
  assert.deepEqual(ids(C.moveOpenStop(stops, 'd', 'earlier', isDone)), ['a', 'd', 'c', 'b', 'e']);
  assert.deepEqual(ids(C.moveOpenStop(stops, 'b', 'later', isDone)), ['a', 'd', 'c', 'b', 'e']);
});
test('a move that cannot happen returns null and the original stops are never changed', () => {
  assert.equal(C.moveOpenStop(stops, 'b', 'next', isDone), null, 'already the next stop');
  assert.equal(C.moveOpenStop(stops, 'b', 'earlier', isDone), null, 'first unfinished stop');
  assert.equal(C.moveOpenStop(stops, 'e', 'later', isDone), null, 'last unfinished stop');
  assert.equal(C.moveOpenStop(stops, 'a', 'later', isDone), null, 'a finished stop is not moved');
  assert.equal(C.moveOpenStop(stops, 'zz', 'next', isDone), null, 'unknown stop');
  assert.deepEqual(ids(stops), ['a', 'b', 'c', 'd', 'e']);
});
