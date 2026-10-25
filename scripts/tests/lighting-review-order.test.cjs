const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Model = require('../../app/lighting-model.js');
const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const grid = html.slice(html.indexOf('const LIGHT_MODEL='), html.indexOf('/* ---------- road network:'));
const review = fs.readFileSync(path.join(__dirname, '../../app/lighting-review.js'), 'utf8');
function run(streetId, reverse = false, distance = 60) {
  const lights = [
    { id: streetId, kind: '가로등', code: 'street', lat: 35.14, lng: 126.93, lampType: 'LED일반형', status: '정상' },
    { id: streetId === 'a' ? 'z' : 'a', kind: '공원등', code: 'park', lat: 35.14 + distance / 110540, lng: 126.93, lampType: 'LED일반형', status: '정상' }
  ];
  if (reverse) lights.reverse();
  const S = { lights, rvMinute: 1260 };
  const context = vm.createContext({ S, KINDS: ['가로등', '보안등', '공원등', '특이등'], DGLightingModel: Model,
    DGLighting: { context: options => Model.createContext([], lights, options) }, inDong: () => true, Date });
  vm.runInContext(grid + '\n' + review, context);
  return vm.runInContext('lightReview("전체", "전체")', context).map(c => ({ distance: c.d, index: c.E, classification: c.context.classification }));
}
test('mixed-kind gap candidates are independent of ID and array ordering', () => {
  const expected = JSON.stringify(run('a'));
  assert.equal(JSON.parse(expected).length, 1);
  for (const id of ['a', 'z']) for (const reverse of [true, false]) assert.equal(JSON.stringify(run(id, reverse)), expected);
});
test('the symmetric search still excludes pairs beyond both kinds’ configured range', () => {
  for (const id of ['a', 'z']) assert.equal(run(id, false, 100).length, 0);
});
