const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const modulePath = path.resolve(__dirname, '../../app/roadlighting-core.js');
const Core = fs.existsSync(modulePath) ? require(modulePath) : {};
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const from = Date.parse('2026-11-01T00:00:00+09:00'), to = Date.parse('2026-11-30T23:59:59.999+09:00'), at = from + 123456;
const sha = value => createHash('sha256').update(value).digest('hex');
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
function unzip(bytes) {
  const buffer = Buffer.from(bytes), files = new Map(), central = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6), method = buffer.readUInt16LE(offset + 8), crc = buffer.readUInt32LE(offset + 14), compressed = buffer.readUInt32LE(offset + 18), size = buffer.readUInt32LE(offset + 22), nameSize = buffer.readUInt16LE(offset + 26), extraSize = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString('utf8'), start = offset + 30 + nameSize + extraSize, body = buffer.subarray(start, start + size);
    assert.equal(flags & 0x800, 0x800, 'Every filename declares UTF-8.'); assert.equal(flags & 8, 0); assert.equal(method, 0); assert.equal(compressed, size); assert.equal(crc32(body), crc); assert.equal(files.has(name), false); assert.doesNotMatch(name, /(?:^|\/)\.\.(?:\/|$)|\\|^\/|[\u0000-\u001f]/);
    files.set(name, body); central.push({ offset, name, crc, size }); offset = start + size;
  }
  const centralStart = offset;
  for (const entry of central) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50); assert.equal(buffer.readUInt32LE(offset + 16), entry.crc); assert.equal(buffer.readUInt32LE(offset + 24), entry.size); assert.equal(buffer.readUInt32LE(offset + 42), entry.offset);
    const ns = buffer.readUInt16LE(offset + 28), es = buffer.readUInt16LE(offset + 30), cs = buffer.readUInt16LE(offset + 32); assert.equal(buffer.subarray(offset + 46, offset + 46 + ns).toString('utf8'), entry.name); offset += 46 + ns + es + cs;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x06054b50); assert.equal(buffer.readUInt16LE(offset + 10), central.length); assert.equal(buffer.readUInt32LE(offset + 16), centralStart); assert.equal(offset + 22 + buffer.readUInt16LE(offset + 20), buffer.length);
  return { files, text: name => files.get(name).toString('utf8').replace(/^\ufeff/, ''), json: name => JSON.parse(files.get(name).toString('utf8')) };
}
function fixture(patch = {}) {
  return {
    from, to, generatedAt: to + 1, includePhotos: true, includeContacts: false,
    lights: [{ id: 'p101', lampId: '101', code: '동명동 1', dong: '동명동', lat: 35.14, lng: 126.93 }, { id: 'public-202', code: '별도 출처 2', dong: '서석동' }],
    inspections: [{ id: 'i1', lightId: 'p101', date: at, result: '정상', code: '옛 표찰', inspector: 'staff', memo: '정상 점검 원문', checks: { lamp: 'ok' }, thumbs: [] }],
    reports: [{ id: 'r1', lightId: 'p101', createdAt: at, status: '접수', issue: '꺼짐', desc: '원문 민원 내용', receipt: '자체 접수 번호', contact: 'PRIVATE-PHONE', name: 'PRIVATE-NAME', email: 'PRIVATE-EMAIL', reporterId: 'PRIVATE-ACCOUNT' }],
    workOrders: [{ id: 'w1', lightId: 'p101', code: '동명동 1', status: 'completed', title: '보수 작업', description: '긴 설명', createdAt: at, updatedAt: at + 1, revision: 2, completionNote: '검수 대기', beforePhotos: [], afterPhotos: [], reportIds: ['r1'], parts: [{ id: 'part1', quantity: 2, unitCost: 1200 }] }],
    workEvents: [{ id: 'e1', workId: 'w1', lightId: 'p101', at: at + 1, fromStatus: 'in_progress', toStatus: 'completed', by: 'staff', note: '작업 조치 완료', costDelta: -50 }],
    patrols: [{ id: 's1', start: at, end: at + 60000, dist: 1200, dong: '전체', passed: ['p101', 'p101'], marks: [{ id: 'p101', at, result: '정상' }], spots: [], track: [[35.14, 126.93, at], [35.141, 126.931, at + 60000]], by: 'staff' }],
    ...patch
  };
}
async function build(input, deps) { assert.equal(typeof Core.buildPackage, 'function', 'A real file-bridge package builder is available.'); return Core.buildPackage(input, deps); }

test('builds a real UTF-8 ZIP with stable IDs, exact source values, separate review states and verifiable file hashes', async () => {
  const input = fixture(), prior = JSON.stringify(input), output = await build(input);
  const zip = unzip(output.bytes), records = zip.json('records.json'), manifest = zip.json('manifest.json');
  for (const file of ['manifest.json', 'records.json', 'inspections.csv', 'reports.csv', 'works.csv', 'work-events.csv', 'patrols.csv', 'photos.csv', 'README.txt']) assert.ok(zip.files.has(file), file);
  assert.equal(manifest.unofficial, true); assert.equal(manifest.state, 'prepared'); assert.equal(manifest.targetTenant, 'gjd'); assert.equal(manifest.apiCompatibility, 'unverified'); assert.match(zip.text('README.txt'), /공식.*양식|공식.*규격/); assert.match(zip.text('README.txt'), /등록.*완료|전송.*완료/);
  assert.equal(records.inspections[0].internalId, 'i1'); assert.equal(records.inspections[0].lampId, '101'); assert.equal(records.inspections[0].lightId, 'p101'); assert.equal(records.inspections[0].code, '옛 표찰'); assert.equal(records.inspections[0].result, '정상');
  assert.equal(records.workOrders[0].status, 'completed'); assert.equal(records.workOrders[0].statusLabel, '검수 대기'); assert.equal(records.workEvents[0].costDelta, -50); assert.deepEqual(records.patrols[0].passed, ['p101', 'p101']); assert.equal(records.patrols[0].mappingStatus, 'not-applicable');
  assert.equal(output.entries.length, 5); assert.equal(output.entries.find(row => row.key === 'workOrders:w1').statusLabel, '검수 대기');
  for (const file of manifest.files) { assert.equal(sha(zip.files.get(file.path)), file.sha256); assert.equal(zip.files.get(file.path).length, file.bytes); }
  assert.equal(JSON.stringify(input), prior, 'Export never rewrites source records.');
});

test('does not truncate normal/repeated records or long Korean memos and gives missing facility matches explicit flags', async () => {
  const memo = '원문 긴 메모\n' + '등기구와 배선 점검 결과를 보존합니다. '.repeat(200);
  const inspections = Array.from({ length: 241 }, (_, n) => ({ id: 'all-' + n, lightId: n === 240 ? 'public-202' : 'p101', date: at + n, result: n % 2 ? '고장' : '정상', memo: n === 240 ? memo : '반복 점검 ' + n }));
  const output = await build(fixture({ inspections, reports: [], workOrders: [], workEvents: [], patrols: [] })); const data = unzip(output.bytes).json('records.json');
  assert.equal(data.inspections.length, 241); assert.equal(data.inspections.find(row => row.internalId === 'all-240').memo, memo); assert.equal(output.summary.unmapped, 1); assert.equal(data.inspections.find(row => row.internalId === 'all-240').mappingStatus, 'unmapped'); assert.equal(data.inspections.find(row => row.internalId === 'all-240').lampId, '');
});

test('preserves verified completion without turning completed work into a verified result', async () => {
  const input = fixture(); input.workOrders.push({ ...input.workOrders[0], id: 'w2', status: 'verified', verifiedAt: at + 2 });
  const output = await build(input), rows = unzip(output.bytes).json('records.json').workOrders;
  assert.equal(rows.find(row => row.internalId === 'w1').statusLabel, '검수 대기'); assert.equal(rows.find(row => row.internalId === 'w2').statusLabel, '완료'); assert.equal(input.workOrders[0].status, 'completed');
});

test('contact fields are excluded throughout the package by default and included only by explicit choice', async () => {
  const first = unzip((await build(fixture())).bytes);
  assert.doesNotMatch([...first.files.values()].map(b => b.toString()).join(''), /PRIVATE-PHONE|PRIVATE-NAME|PRIVATE-EMAIL|PRIVATE-ACCOUNT/);
  const second = unzip((await build(fixture({ includeContacts: true }))).bytes).json('records.json');
  assert.equal(second.reports[0].contact, 'PRIVATE-PHONE'); assert.equal(second.reports[0].name, 'PRIVATE-NAME'); assert.equal(second.reports[0].email, 'PRIVATE-EMAIL');
});

test('CSV quotes Korean, newlines and formulas without mutating exact JSON values', async () => {
  const text = '=HYPERLINK("https://example.invalid","한글")\n다음 줄,쉼표'; const input = fixture(); input.inspections[0].memo = text;
  const out = await build(input), zip = unzip(out.bytes); assert.equal(zip.json('records.json').inspections[0].memo, text); assert.match(zip.text('inspections.csv'), /"'=HYPERLINK\(""https:/); assert.match(zip.text('inspections.csv'), /다음 줄,쉼표/); assert.equal(zip.files.get('inspections.csv').subarray(0, 3).toString('hex'), 'efbbbf');
});

test('content identity ignores generation time and input ordering but changes with an actual record revision', async () => {
  const input = fixture(), first = await build(input), second = await build({ ...input, generatedAt: to + 99999, lights: [...input.lights].reverse(), inspections: [...input.inspections].reverse(), reports: [...input.reports].reverse() });
  assert.equal(first.batchId, second.batchId); assert.equal(first.contentHash, second.contentHash); assert.notEqual(unzip(first.bytes).json('manifest.json').generatedAt, unzip(second.bytes).json('manifest.json').generatedAt);
  const third = fixture(); third.workOrders[0].revision++; const changed = await build(third); assert.notEqual(first.batchId, changed.batchId); assert.notEqual(first.entries.find(e => e.key === 'workOrders:w1').hash, changed.entries.find(e => e.key === 'workOrders:w1').hash);
});

test('uses real photo bytes, deduplicates identical files and retains before/after relationships and original provenance', async () => {
  const input = fixture(); input.inspections[0].thumbs = [{ id: 'ip', label: '현장', t: photo }]; input.workOrders[0].beforePhotos = ['bp']; input.workOrders[0].afterPhotos = ['ap'];
  const requested = [], out = await build(input, { resolvePhoto: async id => { requested.push(id); return { id, lightId: 'p101', workId: id === 'ip' ? undefined : 'w1', data: photo, at, by: 'staff' }; } });
  const zip = unzip(out.bytes), manifest = zip.json('manifest.json'); assert.equal(requested.length, 3); assert.equal(out.summary.photos, 3); assert.equal(out.summary.photoFiles, 1); assert.equal(out.missingPhotos, 0); assert.equal(out.fallbackPhotos, 0); assert.equal(manifest.photos.length, 3); assert.equal(manifest.photos.filter(p => p.phase === 'before').length, 1); assert.equal(manifest.photos.filter(p => p.phase === 'after').length, 1);
  assert.ok(manifest.photos.every(p => p.sourceKind === 'original' && p.sha256 === sha(Buffer.from(photo.split(',')[1], 'base64')))); assert.equal([...zip.files.keys()].filter(name => name.startsWith('photos/')).length, 1);
});

test('original lookup failure and foreign facility evidence produce explicit thumbnail fallback or missing evidence', async () => {
  const input = fixture(); input.inspections[0].thumbs = [{ id: 'fallback', label: '현장', t: photo }, { id: 'missing', label: '원본 필요' }]; input.workOrders[0].afterPhotos = ['foreign'];
  const out = await build(input, { resolvePhoto: async id => { if (id === 'fallback') throw new Error('private service URL must not leak'); if (id === 'foreign') return { lightId: 'other', data: photo }; return null; } }), zip = unzip(out.bytes);
  assert.equal(out.fallbackPhotos, 1); assert.equal(out.missingPhotos, 2); assert.match(zip.text('photos.csv'), /미리보기/); assert.match(zip.text('photos.csv'), /누락|없음/); assert.doesNotMatch(zip.text('photos.csv'), /private service URL/); assert.equal(out.summary.photos, 1);
});

test('legacy inline photo evidence is preserved without lookup and photo exclusion never fetches an original', async () => {
  const input = fixture(); input.inspections[0].photo = photo; input.reports[0].photo = photo;
  const out = await build(input); assert.equal(out.summary.photos, 2); assert.equal(out.missingPhotos, 0);
  let calls = 0; const excluded = await build({ ...input, includePhotos: false }, { resolvePhoto: async () => { calls++; return { data: photo }; } }); assert.equal(calls, 0); assert.equal(excluded.summary.photos, 0); assert.equal(excluded.summary.photoReferences, 2); assert.equal(excluded.missingPhotos, 0); assert.equal([...unzip(excluded.bytes).files.keys()].some(name => name.startsWith('photos/')), false);
});

test('bounds parallel photo requests and hung originals fall back without hanging a package', async () => {
  const input = fixture(); input.inspections[0].thumbs = Array.from({ length: 12 }, (_, n) => ({ id: 'p' + n, t: photo })); let active = 0, max = 0;
  const out = await build(input, { photoTimeoutMs: 25, resolvePhoto: id => { active++; max = Math.max(max, active); if (id === 'p0') return new Promise(() => {}); return new Promise(resolve => setTimeout(() => { active--; resolve({ lightId: 'p101', data: photo }); }, 2)); } });
  assert.ok(max <= 3); assert.equal(out.fallbackPhotos, 1); assert.equal(out.summary.photos, 12);
});

test('scope cancellation aborts an unresolved photo preparation promptly and never returns a stale package', async () => {
  const input = fixture(); input.inspections[0].thumbs = [{ id: 'hung', t: photo }]; let current = true; const timer = setTimeout(() => { current = false; }, 15), began = Date.now();
  try { await assert.rejects(build(input, { photoTimeoutMs: 5000, isCurrent: () => current, resolvePhoto: () => new Promise(() => {}) }), error => error.code === 'bridge-cancelled'); assert.ok(Date.now() - began < 1000); } finally { clearTimeout(timer); }
});

test('date bounds and selected types include whole matching work events but exclude unrelated records', async () => {
  const input = fixture({ types: ['workOrders'] }); input.workOrders[0].createdAt = from - 9000; input.workOrders[0].updatedAt = from - 8000; input.workOrders.push({ id: 'outside', lightId: 'p101', createdAt: from - 9, updatedAt: from - 8, status: 'assigned' }); input.workEvents.push({ id: 'outside-e', workId: 'outside', at: from - 1 });
  const out = await build(input), data = unzip(out.bytes).json('records.json'); assert.equal(data.inspections.length, 0); assert.equal(data.reports.length, 0); assert.equal(data.patrols.length, 0); assert.equal(data.workOrders.length, 1); assert.equal(data.workOrders[0].internalId, 'w1'); assert.equal(data.workEvents.length, 1); assert.equal(data.workEvents[0].internalId, 'e1');
});

test('rejects ambiguous record IDs, invalid bounds, empty packages and explicit size limits without partial truncation', async () => {
  const input = fixture(); input.inspections.push({ ...input.inspections[0] }); await assert.rejects(build(input), /중복/);
  await assert.rejects(build(fixture({ from: to + 1 })), /기간|날짜/); await assert.rejects(build(fixture({ types: [] })), /종류/); await assert.rejects(build(fixture({ inspections: [], reports: [], workOrders: [], workEvents: [], patrols: [] })), /자료|기록/);
  await assert.rejects(build(fixture(), { maxPackageBytes: 1024 }), error => error.code === 'package-too-large');
});

test('provenance completeness and dong participate in identity while fresh fetch times do not', async () => {
  const one = await build(fixture({ provenance: { source: 'server', complete: true, fetchedAt: at }, dong: '동명동' }));
  const two = await build(fixture({ provenance: { source: 'server', complete: true, fetchedAt: at + 1000 }, dong: '동명동' }));
  const unknown = await build(fixture({ provenance: { source: 'artifact', complete: false, fetchedAt: at }, dong: '동명동' }));
  const otherScope = await build(fixture({ provenance: { source: 'server', complete: true, fetchedAt: at }, dong: '전체' }));
  assert.equal(one.batchId, two.batchId); assert.notEqual(one.batchId, unknown.batchId); assert.notEqual(one.batchId, otherScope.batchId); assert.equal(unknown.manifest.provenance.complete, false); assert.equal(unknown.manifest.provenance.source, 'artifact');
});

test('structured payload fields cannot smuggle private metadata or data URLs into the records JSON', async () => {
  const input = fixture(); input.workOrders[0].parts[0].privateNote = 'PRIVATE-UNLISTED'; input.workOrders[0].parts[0].contact = 'PRIVATE-NESTED-CONTACT'; input.patrols[0].marks[0].email = 'PRIVATE-NESTED-EMAIL'; input.inspections[0].checks.extra = { data: photo, contact: 'PRIVATE-NESTED-CHECK' };
  const out = await build(input), data = unzip(out.bytes).text('records.json');
  assert.doesNotMatch(data, /PRIVATE-UNLISTED|PRIVATE-NESTED|data:image/); assert.equal(unzip(out.bytes).json('records.json').workOrders[0].parts[0].unitCost, 1200);
});

test('rejects disguised executable image data and a thumbnail explicitly belonging to another facility', async () => {
  const input = fixture(); input.inspections[0].thumbs = [{ id: 'bad', t: 'data:image/png;base64,' + Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64') }, { id: 'other', lightId: 'another-facility', t: photo }];
  const out = await build(input, { resolvePhoto: async () => null }); assert.equal(out.missingPhotos, 2); assert.equal(out.summary.photos, 0); assert.equal([...unzip(out.bytes).files.keys()].some(name => name.startsWith('photos/')), false);
});

test('the shared preview selector uses exactly the package period and selected work-event scope', async () => {
  assert.equal(typeof Core.selectRecords, 'function');
  const input = fixture({ types: ['workOrders'] }); input.workOrders[0].createdAt = from - 50; input.workOrders[0].updatedAt = from - 40; input.inspections.push({ id: 'outside', date: from - 1 });
  const preview = Core.selectRecords(input), output = await build(input), data = unzip(output.bytes).json('records.json');
  for (const entity of ['inspections', 'reports', 'workOrders', 'workEvents', 'patrols']) assert.deepEqual(preview[entity].map(row => row.id).sort(), data[entity].map(row => row.internalId).sort());
});

test('a mismatched original facility or work ID suppresses the associated thumbnail too', async () => {
  const input = fixture(); input.inspections[0].thumbs = [{ id: 'foreign-light', t: photo }]; input.workOrders[0].afterPhotos = [{ id: 'foreign-work', t: photo }];
  const out = await build(input, { resolvePhoto: async id => ({ lightId: id === 'foreign-light' ? 'foreign' : 'p101', workId: id === 'foreign-work' ? 'other-work' : undefined, data: photo }) });
  assert.equal(out.summary.photos, 0); assert.equal(out.missingPhotos, 2); assert.equal(out.fallbackPhotos, 0); assert.ok(out.manifest.photos.every(row => row.reason === 'wrong-facility'));
});

test('explicit inspection before and after labels remain attached to the same inspection rather than a facility-wide pairing', async () => {
  const input = fixture(); input.inspections[0].thumbs = [{ id: 'before', label: '조치 전', t: photo }, { id: 'after', label: '조치 후', t: photo }]; input.inspections.push({ ...input.inspections[0], id: 'different-inspection', thumbs: [{ id: 'elsewhere-before', label: '조치 전', t: photo }] });
  const out = await build(input, { resolvePhoto: async () => null });
  assert.equal(out.manifest.photos.find(p => p.sourceId === 'before').phase, 'before'); assert.equal(out.manifest.photos.find(p => p.sourceId === 'after').phase, 'after'); assert.equal(out.manifest.photos.find(p => p.sourceId === 'elsewhere-before').internalId, 'different-inspection');
});

test('ambiguous external facility numbers cannot silently map two different internal facilities', async () => {
  const input = fixture(); input.lights.push({ id: 'another-id', lampId: '101', code: '동명동 또다른 시설' });
  await assert.rejects(build(input), error => error.code === 'ambiguous-facility' && /여러|중복/.test(error.message));
});

test('many timed-out original references do not repeatedly wait behind the same three unabortable backend requests', async () => {
  const input = fixture(); input.inspections[0].thumbs = Array.from({ length: 60 }, (_, index) => ({ id: 'hang-' + index, t: photo })); let calls = 0; const began = Date.now();
  const out = await build(input, { photoTimeoutMs: 50, resolvePhoto: () => { calls++; return new Promise(() => {}); } });
  assert.equal(calls, 3); assert.equal(out.fallbackPhotos, 60); assert.ok(Date.now() - began < 750, 'Only the initial failed slots should incur the original lookup timeout.');
});

test('untrusted completeness flags cannot make unknown or artifact provenance look complete', async () => {
  for (const source of ['artifact', 'mixed', 'unknown', 'https://private.invalid']) {
    const out = await build(fixture({ provenance: { source, complete: true } })); assert.equal(out.manifest.provenance.complete, false);
  }
});

test('every selected photo reference survives beyond the screen preview limits', async () => {
  const inspections = Array.from({ length: 241 }, (_, index) => ({ id: 'full-' + index, lightId: 'p101', date: at + index, result: '정상', thumbs: [{ id: 'photo-' + index, label: '현장', t: photo }] }));
  const out = await build(fixture({ inspections, reports: [], workOrders: [], workEvents: [], patrols: [] }), { resolvePhoto: async id => ({ id, lightId: 'p101', data: photo, at }) });
  assert.equal(out.summary.photos, 241); assert.equal(out.manifest.photos.length, 241); assert.equal(out.summary.photoReferences, 241); assert.equal(out.summary.photoFiles, 1); assert.equal(out.missingPhotos, 0); assert.equal(out.entries.length, 241);
});

test('an original response carrying another photo ID cannot be exported under the requested evidence relation', async () => {
  const input = fixture(); input.inspections[0].thumbs = [{ id: 'requested', t: photo }];
  const out = await build(input, { resolvePhoto: async () => ({ id: 'different-photo', lightId: 'p101', data: photo }) });
  assert.equal(out.missingPhotos, 1); assert.equal(out.summary.photos, 0); assert.equal(out.fallbackPhotos, 0); assert.equal(out.manifest.photos[0].reason, 'wrong-photo');
});

test('cancel and prepare again share three real pending requests across four builds of the same photo owner', async () => {
  const input = fixture(); input.inspections[0].thumbs = Array.from({ length: 3 }, (_, index) => ({ id: 'retry-' + index, t: photo }));
  const photoSession = {}, requested = [], resolvePhoto = id => { requested.push(id); return new Promise(() => {}); };
  for (let attempt = 0; attempt < 4; attempt++) {
    let current = true; const pending = build(input, { photoSession, resolvePhoto, photoTimeoutMs: 5000, isCurrent: () => current });
    await new Promise(resolve => setTimeout(resolve, 15)); current = false;
    await assert.rejects(pending, error => error.code === 'bridge-cancelled');
  }
  assert.equal(requested.length, 3, 'Cancel/retry cannot create a fresh pool around the same unresolved originals.'); assert.equal(new Set(requested).size, 3);
});

test('queued requests from a cancelled build never start when another build later releases its photo slots', async () => {
  const photoSession = {}, calls = [], releases = new Map();
  const resolvePhoto = id => { calls.push(id); return new Promise(resolve => { releases.set(id, () => resolve({ id, lightId: 'p101', data: photo })); }); };
  const first = fixture(), second = fixture(); first.inspections[0].thumbs = Array.from({ length: 3 }, (_, n) => ({ id: 'first-' + n, t: photo })); second.inspections[0].thumbs = Array.from({ length: 3 }, (_, n) => ({ id: 'queued-' + n, t: photo }));
  const active = build(first, { photoSession, resolvePhoto, photoTimeoutMs: 5000 }); await new Promise(resolve => setTimeout(resolve, 15));
  let current = true; const queued = build(second, { photoSession, resolvePhoto, photoTimeoutMs: 5000, isCurrent: () => current }); await new Promise(resolve => setTimeout(resolve, 15)); current = false;
  await assert.rejects(queued, error => error.code === 'bridge-cancelled');
  for (const [id, release] of releases) if (id.startsWith('first-')) release();
  await active; await new Promise(resolve => setTimeout(resolve, 15)); assert.deepEqual(calls.sort(), ['first-0', 'first-1', 'first-2']);
});

test('pending originals stay isolated by owner and a settled original is fetched again rather than permanently cached', async () => {
  const input = fixture(); input.inspections[0].thumbs = [{ id: 'shared-id', t: photo }];
  const photoSessionA = {}, photoSessionB = {}; let callsA = 0, callsB = 0, releaseA;
  const resolveA = id => { callsA++; return callsA === 1 ? new Promise(resolve => { releaseA = () => resolve({ id, lightId: 'p101', data: photo, at: at + 1 }); }) : Promise.resolve({ id, lightId: 'p101', data: photo, at: at + 3 }); };
  const resolveB = async id => { callsB++; return { id, lightId: 'p101', data: photo, at: at + 2 }; };
  let currentA = true; const firstA = build(input, { photoSession: photoSessionA, resolvePhoto: resolveA, photoTimeoutMs: 5000, isCurrent: () => currentA }); await new Promise(resolve => setTimeout(resolve, 15)); currentA = false; await assert.rejects(firstA, error => error.code === 'bridge-cancelled');
  const resultB = await build(input, { photoSession: photoSessionB, resolvePhoto: resolveB }); assert.equal(callsB, 1); assert.equal(resultB.manifest.photos[0].capturedAt, at + 2);
  releaseA(); await new Promise(resolve => setTimeout(resolve, 15));
  const returnedA = await build(input, { photoSession: photoSessionA, resolvePhoto: resolveA }); assert.equal(callsA, 2); assert.equal(returnedA.manifest.photos[0].capturedAt, at + 3);
});

test('a photo owner token cannot be reused with another resolver', async () => {
  const input = fixture(); input.inspections[0].thumbs = [{ id: 'owner-bound', t: photo }]; const photoSession = {}, resolvePhoto = async id => ({ id, lightId: 'p101', data: photo });
  await build(input, { photoSession, resolvePhoto });
  await assert.rejects(build(input, { photoSession, resolvePhoto: async () => null }), error => error.code === 'photo-session-changed');
});
