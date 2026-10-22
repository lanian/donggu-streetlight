const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
test('대장 생성 결과는 count·좌표·안정 ID·열 너비 계약을 만족한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'donggu-registry-'));
  try {
    const source = path.join(dir, 'getPoint.json'), output = path.join(dir, 'lights.json');
    fs.writeFileSync(source, JSON.stringify({ DATA: [{ lamp_id: '101', label_no: '동명동 12', latitude: '35.15', longitude: '126.92', facility_class: '보안등', lampName: 'LED' }, { lamp_id: '102', label_no: '지호로 65-5', latitude: 35.16, longitude: 126.93, facility_class: '가로등' }] }));
    const result = spawnSync(process.execPath, ['scripts/build-registry.mjs', source, output], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(fs.readFileSync(output));
    assert.equal(data.count, 2); assert.equal(data.count, data.rows.length); assert.equal(data.schemaVersion, 1); assert.equal(data.source, 'getPoint.json');
    assert.deepEqual(data.rows.map(r => r[data.cols.indexOf('id')]), ['p101', 'p102']);
    for (const row of data.rows) assert.equal(row.length, data.cols.length);
    assert.equal(data.rows[1][data.cols.indexOf('code')], '지호로 65-5');
    const original = fs.readFileSync(output, 'utf8');
    for (const bad of [{}, { DATA: [] }, { DATA: [{ lamp_id: '', label_no: '없음', latitude: 35, longitude: 126 }] }, { DATA: [{ lamp_id: '1', label_no: '좌표 오류', latitude: '', longitude: 126 }] }]) {
      fs.writeFileSync(source, JSON.stringify(bad));
      const failed = spawnSync(process.execPath, ['scripts/build-registry.mjs', source, output], { cwd: root, encoding: 'utf8' });
      assert.notEqual(failed.status, 0); assert.equal(fs.readFileSync(output, 'utf8'), original, '오류 입력은 기존 대장을 덮지 않는다');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
