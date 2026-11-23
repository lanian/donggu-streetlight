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

test('official resident mode distinguishes legacy QR import from the current official desk intake', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/staff-app.js'), 'utf8');
  const sandbox = { window: {}, IB: { only: true }, S: { reports: [] }, dl: null, INBOX_VIA: ['전화'], ISSUES: ['고장'], esc: String };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../report/config.js'), 'utf8'), sandbox);
  vm.runInContext(source.slice(source.indexOf('function inboxSection()'), source.indexOf('const SCRIPT_LOADS=')), sandbox);
  const html = sandbox.inboxSection();
  assert.match(html, /공식 운영서비스에서 접수한 신고는 확인 후 여기에 직접 등록/);
  assert.match(html, /기존 QR 신고 가져오기/);
  assert.match(html, /기존 자체 신고 서버의 미이관 기록/);
});
