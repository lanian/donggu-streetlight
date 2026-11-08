const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.resolve(__dirname, '../../report/official-handoff.js');
const helper = fs.existsSync(modulePath) ? require(modulePath) : {};
function api() {
  for (const name of ['destination', 'statusDestination', 'summary']) assert.equal(typeof helper[name], 'function', 'official handoff must provide ' + name);
  return helper;
}

test('only the verified service root and report map are accepted as reporting destinations', () => {
  const h = api();
  for (const value of ['https://gjd.roadlighting.kr', 'https://gjd.roadlighting.kr/', 'https://gjd.roadlighting.kr/slamp', 'https://gjd.roadlighting.kr/slamp/', 'https://GJD.ROADLIGHTING.KR:443/']) assert.equal(h.destination(value), 'https://gjd.roadlighting.kr/slamp/');
  assert.equal(h.destination('https://gjd.roadlighting.kr/slamp/repair/map'), 'https://gjd.roadlighting.kr/slamp/repair/map');
  assert.equal(h.destination('https://gjd.roadlighting.kr/slamp/repair/status'), null, 'status is not the report destination');
  assert.equal(h.destination('https://gjd.roadlighting.kr/slamp/repair/new'), null, 'a label in the bundle is not a verified route');
  assert.equal(h.destination('https://gjd.roadlighting.kr/slamp/repair/newApply'), null, 'new installation is not fault reporting');
});

test('the status destination is limited to its verified public route', () => {
  const h = api();
  assert.equal(h.statusDestination('https://gjd.roadlighting.kr/slamp/repair/status'), 'https://gjd.roadlighting.kr/slamp/repair/status');
  for (const value of ['https://gjd.roadlighting.kr/', 'https://gjd.roadlighting.kr/slamp/repair/map', 'https://gjd.roadlighting.kr/slamp/repair/status/other']) assert.equal(h.statusDestination(value), null);
});

test('lookalike hosts, credentials, ports, query data, fragments and malformed URLs fail closed', () => {
  const h = api();
  const values = [undefined, null, '', 1, false, '//gjd.roadlighting.kr/slamp/', 'http://gjd.roadlighting.kr/slamp/', 'javascript:alert(1)', 'data:text/html,hello', 'https://gjd.roadlighting.kr.evil.invalid/slamp/', 'https://evil-gjd.roadlighting.kr/slamp/', 'https://gjd.roadlighting.kr./slamp/', 'https://gjd%2eroadlighting.kr/slamp/', 'https://user@gjd.roadlighting.kr/slamp/', 'https://user:password@gjd.roadlighting.kr/slamp/', 'https://gjd.roadlighting.kr:444/slamp/', 'https://gjd.roadlighting.kr/slamp/?lampId=1', 'https://gjd.roadlighting.kr/slamp/?next=https://evil.invalid', 'https://gjd.roadlighting.kr/slamp/#report', 'https://gjd.roadlighting.kr/slamp/?', 'https://gjd.roadlighting.kr/slamp/#', ' https://gjd.roadlighting.kr/slamp/', 'https://gjd.roadlighting.kr/slamp/\n', 'https:\\gjd.roadlighting.kr\\slamp\\'];
  for (const value of values) { assert.equal(h.destination(value), null, String(value)); assert.equal(h.statusDestination(value), null, String(value)); }
  for (const suffix of ['?phone=private', '?', '#', '/other']) assert.equal(h.statusDestination('https://gjd.roadlighting.kr/slamp/repair/status' + suffix), null);
});

test('destination validation does not coerce caller objects or consult incoming URL parameters', () => {
  const h = api(), value = { officialUrl: 'https://gjd.roadlighting.kr/slamp/', next: 'https://evil.invalid', toString() { throw new Error('must not coerce'); } };
  assert.equal(h.destination(value), null); assert.equal(h.statusDestination(value), null);
});

test('a verified matching facility contributes its registry code and real external number', () => {
  const h = api();
  const text = h.summary({ code: 'QR의 이전 번호', lightId: 'p00042', facility: { id: 'p00042', code: '운림동 001', lampId: '00042' }, issue: '불이 꺼져 있어요', desc: '편의점 앞\n두 번째 기둥입니다.' });
  assert.match(text, /접수 전/); assert.match(text, /대장에서 확인한 표찰: 운림동 001/); assert.match(text, /운영 시설번호: 00042/); assert.match(text, /문제: 불이 꺼져 있어요/); assert.ok(text.includes('편의점 앞\n두 번째 기둥입니다.'));
  assert.doesNotMatch(text, /QR의 이전 번호|접수됐|접수번호|R\d{6}-/);
});

test('zero external identifiers are preserved rather than treated as absent', () => {
  const h = api();
  for (const lampId of [0, '0', '0000']) {
    const text = h.summary({ lightId: 'p0', facility: { id: 'p0', code: '표찰 0', lampId } });
    assert.ok(text.includes('운영 시설번호: ' + String(lampId)));
  }
});

test('an unverified or different facility never supplies a guessed operating number', () => {
  const h = api(), fixture = { id: 'p999', code: '다른 표찰', lampId: 'PRIVATE-WRONG-FACILITY' };
  for (const input of [{ code: '입력 표찰', lightId: 'p123', facility: fixture }, { code: '입력 표찰', facility: fixture }, { code: '입력 표찰', lightId: 'p123' }, { lightId: 'p123' }]) {
    const text = h.summary(input);
    assert.doesNotMatch(text, /운영 시설번호:|PRIVATE-WRONG-FACILITY|다른 표찰/);
    assert.match(text, /대장 미확인/);
    assert.doesNotMatch(text, /123/);
  }
});

test('malformed external identifiers are omitted while a matched registry plate remains recognizable', () => {
  const h = api();
  for (const lampId of [null, undefined, '', ' ', false, true, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 'a/b', 'a\\b', 'a\nb', 'a\u0000b']) {
    const text = h.summary({ lightId: 'p1', facility: { id: 'p1', code: '검증 표찰', lampId } });
    assert.match(text, /대장에서 확인한 표찰: 검증 표찰/); assert.doesNotMatch(text, /운영 시설번호:/);
  }
});

test('only the handoff whitelist is copied and source objects are not modified', () => {
  const h = api();
  const input = { code: '입력 표찰', issue: '깜빡거려요', desc: '자유 입력 원문', contact: 'PRIVATE-CONTACT', name: 'PRIVATE-NAME', phone: 'PRIVATE-PHONE', photo: 'data:image/png;base64,PRIVATE-PHOTO', lat: 35.123456, lng: 126.123456, statusCode: 'PRIVATE-STATUS', requestId: 'PRIVATE-REQUEST', receipt: 'R261108-12345678', url: 'https://evil.invalid/?token=PRIVATE-URL' };
  const before = JSON.stringify(input), text = h.summary(input);
  assert.equal(JSON.stringify(input), before); assert.doesNotMatch(text, /PRIVATE-|R261108-12345678|35\.123456|126\.123456|data:image|https:\/\//); assert.ok(text.includes('자유 입력 원문'));
});

test('the optional note keeps line breaks and its first 500 UTF-16 characters', () => {
  const h = api(), desc = '첫 줄\r\n둘째 줄\n' + '한'.repeat(600), text = h.summary({ desc });
  assert.ok(text.endsWith(desc.slice(0, 500))); assert.equal(text.indexOf('한'.repeat(501)), -1);
});

test('control characters cannot inject additional plate or issue headings', () => {
  const h = api(), text = h.summary({ code: '산수동\n123\u0000', issue: '고장\r\n접수번호: X\u001b', desc: '첫줄\n둘째줄\t설명\u0000\u007f' });
  assert.ok(text.includes('입력한 표찰(대장 미확인): 산수동 123')); assert.ok(text.includes('문제: 고장 접수번호: X')); assert.ok(text.endsWith('첫줄\n둘째줄\t설명')); assert.doesNotMatch(text, /[\u0000\u001b\u007f]/);
});

test('summary generation is deterministic, nullable and does not fabricate delivery status', () => {
  const h = api(), input = { code: '산수동 42', issue: '기타', desc: '<script>literal text</script>' };
  assert.equal(h.summary(input), h.summary(input)); assert.ok(h.summary(null).includes('접수 전')); assert.ok(h.summary(undefined).includes('대장 미확인')); assert.ok(h.summary(input).includes('<script>literal text</script>')); assert.doesNotMatch(h.summary(input), /전송 완료|접수 완료|접수됐/);
});

test('the browser global works without DOM, storage, network, clipboard or CommonJS', () => {
  api();
  const context = vm.createContext({ URL }); vm.runInContext(fs.readFileSync(modulePath, 'utf8'), context);
  assert.equal(typeof context.DGOfficialHandoff.summary, 'function'); assert.equal(context.DGOfficialHandoff.destination('https://gjd.roadlighting.kr/slamp/'), 'https://gjd.roadlighting.kr/slamp/'); assert.ok(context.DGOfficialHandoff.summary({ code: '합성 표찰' }).includes('합성 표찰'));
});
