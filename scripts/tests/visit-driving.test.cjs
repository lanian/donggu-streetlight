'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const file = path.resolve(__dirname, '../../app/visit-driving-core.js');
const Core = fs.existsSync(file) ? require(file) : {};
const stops = count => Array.from({ length: count }, (_, i) => ({ id: 'light-' + i, code: '시설 ' + (i + 1), lat: 35.14 + i * 0.0001, lng: 126.92 + i * 0.0001, ordinal: i + 1 }));
const origin = { code: '현재 위치', lat: 35.13, lng: 126.91 };
const clone = value => JSON.parse(JSON.stringify(value));
const invalid = run => assert.throws(run, error => error.code === 'invalid-argument' && !/PRIVATE|SECRET/.test(error.message));

test('the pure helper exports the same API in CommonJS and a browser global', () => {
  assert.equal(typeof Core.makeBatches, 'function', 'Vehicle batch creation is not implemented');
  assert.equal(typeof Core.makeUrl, 'function', 'Vehicle route URL creation is not implemented');
  const context = {}; vm.createContext(context); vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  assert.equal(typeof context.DGVisitDriving.makeBatches, 'function');
  assert.equal(typeof context.DGVisitDriving.makeUrl, 'function');
});

for (const count of [0, 1, 6, 7, 200]) test(count + ' visits are split without losing or duplicating a destination', () => {
  const input = stops(count), batches = Core.makeBatches(input);
  assert.equal(batches.length, Math.ceil(count / 6));
  assert.deepEqual(batches.flatMap(batch => batch.stops), input);
  batches.forEach((batch, index) => {
    assert.equal(batch.index, index); assert.ok(batch.stops.length > 0 && batch.stops.length <= 6);
    assert.deepEqual(batch.start, index ? batches[index - 1].stops.at(-1) : null);
  });
});

test('batch starts preserve the explicit origin and connect later batches to the previous destination', () => {
  const input = stops(13), batches = Core.makeBatches(input, origin);
  assert.deepEqual(batches[0].start, origin); assert.notEqual(batches[0].start, origin);
  assert.deepEqual(batches[1].start, input[5]); assert.deepEqual(batches[2].start, input[11]);
  assert.notEqual(batches[1].start, batches[0].stops[5]);
  assert.deepEqual(batches.flatMap(batch => batch.stops).map(stop => stop.id), input.map(stop => stop.id));
});

test('batch creation drops unrelated source fields and never mutates the input or shares point objects', () => {
  const input = stops(7).map(stop => ({ ...stop, workIds: ['PRIVATE-WORK'], visited: false })), before = clone(input), begin = { ...origin, acc: 4, private: 'SECRET' };
  const batches = Core.makeBatches(input, begin);
  assert.deepEqual(input, before); assert.deepEqual(begin, { ...origin, acc: 4, private: 'SECRET' });
  assert.deepEqual(Object.keys(batches[0].stops[0]).sort(), ['code', 'id', 'lat', 'lng', 'ordinal']);
  assert.deepEqual(batches[0].start, origin); assert.notEqual(batches[0].stops[0], input[0]);
  batches[0].stops[0].code = '변경'; assert.equal(input[0].code, before[0].code);
});

test('missing ordinals receive their original global visit positions', () => {
  const input = stops(7).map(({ ordinal, ...stop }) => stop), batches = Core.makeBatches(input);
  assert.deepEqual(batches.flatMap(batch => batch.stops.map(stop => stop.ordinal)), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(batches[1].start.ordinal, 6);
});

test('the batch builder rejects invalid collections, more than 200 visits and duplicate facility IDs', () => {
  for (const input of [null, {}, 'PRIVATE', stops(201), [stops(1)[0], stops(1)[0]], new Array(1)]) invalid(() => Core.makeBatches(input));
});

test('the batch builder rejects removed, approximate and invalid WGS84 destinations', () => {
  for (const extra of [{ removed: true }, { posApprox: true }, { lat: NaN }, { lng: Infinity }, { lat: 90.001 }, { lat: -90.001 }, { lng: 180.001 }, { lng: -180.001 }, { lat: '35.14' }, { id: '' }, { ordinal: 0 }, { ordinal: 1.5 }]) invalid(() => Core.makeBatches([{ ...stops(1)[0], ...extra }]));
  assert.equal(Core.makeBatches([{ id: 'edge', code: '경계', lat: -90, lng: 180 }])[0].stops[0].lng, 180);
});

test('the batch builder validates origins and does not silently use the first visit as the origin', () => {
  for (const value of [{ lat: 91, lng: 126 }, { lat: 35, lng: '126' }, { lat: 35 }, false, { ...origin, posApprox: true }]) invalid(() => Core.makeBatches(stops(1), value));
  const batch = Core.makeBatches(stops(1))[0]; assert.equal(batch.start, null); assert.equal(batch.stops.length, 1);
});

test('Naver car URL includes the explicit start and all five waypoints in plan order', () => {
  const input = stops(6), batch = Core.makeBatches(input, origin)[0], before = clone(batch), url = new URL(Core.makeUrl(batch, 'naver'));
  assert.equal(url.protocol, 'nmap:'); assert.equal(url.hostname, 'route'); assert.equal(url.pathname, '/car');
  assert.equal(url.searchParams.get('slat'), String(origin.lat)); assert.equal(url.searchParams.get('slng'), String(origin.lng)); assert.equal(url.searchParams.get('sname'), origin.code);
  input.slice(0, 5).forEach((stop, index) => { const key = 'v' + (index + 1); assert.equal(url.searchParams.get(key + 'lat'), String(stop.lat)); assert.equal(url.searchParams.get(key + 'lng'), String(stop.lng)); assert.equal(url.searchParams.get(key + 'name'), stop.code); });
  assert.equal(url.searchParams.get('dlat'), String(input[5].lat)); assert.equal(url.searchParams.get('dlng'), String(input[5].lng)); assert.equal(url.searchParams.get('dname'), input[5].code);
  assert.equal(url.searchParams.get('appname'), 'https://lanian.github.io/donggu-streetlight/'); assert.equal(url.searchParams.has('v6lat'), false); assert.deepEqual(batch, before);
});

test('Naver without an explicit origin leaves current-location choice to the map app', () => {
  const batch = Core.makeBatches(stops(1))[0], url = new URL(Core.makeUrl(batch, 'naver'));
  for (const key of ['slat', 'slng', 'sname', 'v1lat']) assert.equal(url.searchParams.has(key), false);
  assert.equal(url.searchParams.get('dlat'), String(batch.stops[0].lat));
});

test('Kakao web car URL retains an explicit start, five waypoints and the final destination', () => {
  const input = stops(6), batch = Core.makeBatches(input, origin)[0], url = new URL(Core.makeUrl(batch, 'kakao-web'));
  assert.equal(url.origin, 'https://map.kakao.com'); assert.ok(url.pathname.startsWith('/link/by/car/'));
  const points = url.pathname.split('/').slice(4).map(segment => decodeURIComponent(segment));
  assert.deepEqual(points, [origin, ...input].map(stop => stop.code + ',' + stop.lat + ',' + stop.lng));
  assert.equal(url.search, ''); assert.equal(url.hash, '');
});

test('Kakao app car URL retains start, vp through vp5 and the final destination', () => {
  const input = stops(6), url = new URL(Core.makeUrl(Core.makeBatches(input, origin)[0], 'kakao-app'));
  assert.equal(url.protocol, 'kakaomap:'); assert.equal(url.hostname, 'route'); assert.equal(url.searchParams.get('by'), 'car');
  assert.equal(url.searchParams.get('sp'), origin.lat + ',' + origin.lng); assert.equal(url.searchParams.get('ep'), input[5].lat + ',' + input[5].lng);
  ['vp', 'vp2', 'vp3', 'vp4', 'vp5'].forEach((key, index) => assert.equal(url.searchParams.get(key), input[index].lat + ',' + input[index].lng));
  assert.equal(url.searchParams.has('vp6'), false);
});

test('Kakao refuses a missing start instead of silently turning the first visit into the start', () => {
  for (const provider of ['kakao-web', 'kakao-app']) assert.throws(() => Core.makeUrl(Core.makeBatches(stops(1))[0], provider), error => error.code === 'origin-required');
});

test('a single remaining visit is a destination and does not become a duplicate waypoint', () => {
  const batch = Core.makeBatches(stops(1), origin)[0];
  const app = new URL(Core.makeUrl(batch, 'kakao-app')); assert.equal(app.searchParams.has('vp'), false); assert.notEqual(app.searchParams.get('sp'), app.searchParams.get('ep'));
  assert.equal(new URL(Core.makeUrl(batch, 'kakao-web')).pathname.split('/').slice(4).length, 2);
});

test('facility names with commas, slashes, controls and URL delimiters are encoded as names', () => {
  const name = '표찰, A/B\n&?#=한글', begin = { ...origin, code: name }, input = [{ ...stops(1)[0], code: name }], batch = Core.makeBatches(input, begin)[0];
  const naverRaw = Core.makeUrl(batch, 'naver'), naver = new URL(naverRaw); assert.equal(naver.searchParams.get('dname'), name); assert.equal(naver.searchParams.get('sname'), name); assert.equal(naver.searchParams.has('?#'), false); assert.doesNotMatch(naverRaw, /[\r\n]/);
  const webRaw = Core.makeUrl(batch, 'kakao-web'), web = new URL(webRaw), pieces = web.pathname.split('/').slice(4); assert.equal(pieces.length, 2); assert.ok(pieces.every(segment => decodeURIComponent(segment).startsWith(name + ','))); assert.equal(web.search, ''); assert.equal(web.hash, ''); assert.doesNotMatch(webRaw, /[\r\n]/);
});

test('later route URLs start at the previous destination and continue through every new visit', () => {
  const input = stops(7), batches = Core.makeBatches(input, origin);
  const url = new URL(Core.makeUrl(batches[1], 'kakao-app'));
  assert.equal(url.searchParams.get('sp'), input[5].lat + ',' + input[5].lng); assert.equal(url.searchParams.get('ep'), input[6].lat + ',' + input[6].lng); assert.equal(url.searchParams.has('vp'), false);
});

test('URL generation rejects unknown providers and malformed batches with generic errors', () => {
  const good = Core.makeBatches(stops(1), origin)[0];
  for (const provider of ['google', 'javascript:PRIVATE', '', null, {}]) invalid(() => Core.makeUrl(good, provider));
  for (const batch of [null, {}, { ...good, stops: [] }, { ...good, stops: stops(7) }, { ...good, stops: [stops(1)[0], stops(1)[0]] }, { ...good, start: { lat: Infinity, lng: 125 } }, { ...good, stops: [{ ...stops(1)[0], posApprox: true }] }]) invalid(() => Core.makeUrl(batch, 'naver'));
});

test('invalid getters do not execute or leak raw source errors', () => {
  let reads = 0; const source = { id: 'PRIVATE', code: 'SECRET', lng: 126.9 };
  Object.defineProperty(source, 'lat', { get() { reads++; throw new Error('PRIVATE-SECRET'); } });
  invalid(() => Core.makeBatches([source])); assert.equal(reads, 0);
});
