const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../app/roadlighting-core.js');

// The handoff range is filtered in Korean time (+09:00). Its default must be this month to today in Korean time
// too, whatever the device clock's time zone: from 15:00 UTC the UTC date is still yesterday in Korea's terms.
const at = iso => Date.parse(iso);

test('the default range is the first of this Korean month to today in Korean time', () => {
  assert.deepEqual(Core.defaultRange(at('2026-11-14T03:00:00Z')), { from: '2026-11-01', to: '2026-11-14' });
});
test('after 15:00 UTC the default end date is already the next Korean day', () => {
  assert.deepEqual(Core.defaultRange(at('2026-11-14T15:30:00Z')), { from: '2026-11-01', to: '2026-11-15' });
});
test('the Korean month starts on its own first day, not the UTC month', () => {
  assert.deepEqual(Core.defaultRange(at('2026-10-31T15:30:00Z')), { from: '2026-11-01', to: '2026-11-01' });
});
