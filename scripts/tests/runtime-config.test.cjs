const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function configuration(hostname) {
  const sandbox = { window: {}, location: { hostname } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../firebase-config.js'), 'utf8'), sandbox);
  return sandbox.window.FIREBASE_CONFIG;
}
test('loopback and localhost development never connect to the hosted Firebase project by default', () => {
  for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'field.localhost']) assert.equal(configuration(host), null, host);
});
test('hosted staff configuration preserves its explicit Firebase project', () => {
  assert.equal(configuration('lanian.github.io').projectId, 'donggu-light');
});
test('public Firestore creation cannot bypass the verified report gateway', () => {
  const rules = fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8');
  const start = rules.indexOf('match /citizen_reports/');
  assert.match(rules.slice(start, rules.indexOf('\n    match ', start + 1)), /allow create:\s*if false;/);
});
