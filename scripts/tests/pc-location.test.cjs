const { readSource } = require('./source.cjs');
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=readSource(path.resolve(__dirname,'../../index.html'),'utf8');
const from=html.indexOf('const POSITION_INPUT_MAX_M=50'),to=html.indexOf('let regPickMap=',from);
assert.ok(from>=0&&to>from,'position quality helper source exists');
const scope=vm.createContext({});
vm.runInContext(html.slice(from,to)+'\nthis.quality=positionQuality;this.errorText=positionErrorText;',scope);
const pos=(acc,lat=35.146,lng=126.923)=>({coords:{latitude:lat,longitude:lng,accuracy:acc}});
test('network estimated 3000m PC position cannot overwrite facility coordinates',()=>{
  assert.equal(scope.quality(pos(3000)).ok,false);
  assert.equal(scope.quality(pos(50)).ok,true);
  assert.equal(scope.quality(pos(51)).ok,false);
  assert.equal(scope.quality(pos(12)).label,'±12m');
});
test('unknown accuracy and invalid coordinates are never accepted',()=>{
  assert.equal(scope.quality({coords:{latitude:35,longitude:126}}).ok,false);
  assert.equal(scope.quality(pos(NaN)).ok,false);
  assert.equal(scope.quality(pos(-1)).ok,false);
  assert.equal(scope.quality(pos(5,500,126.923)).ok,false);
  assert.equal(scope.quality(pos(5,35.146,300)).ok,false);
});
test('map following may accept 120m but never facility editing',()=>{
  assert.equal(scope.quality(pos(120),150).ok,true);
  assert.equal(scope.quality(pos(120),50).ok,false);
  assert.equal(scope.quality(pos(300),150).ok,false);
});
test('location failures explain permission, timeout and manual map fallback',()=>{
  assert.match(scope.errorText({code:1}),/위치 권한/);
  assert.match(scope.errorText({code:3}),/시간이 초과/);
  assert.match(scope.errorText({code:2}),/지도에서/);
});

function facilityLocationFixture() {
  let now = 100000, nextTimer = 0, nextWatch = 0, confirm = async () => true;
  const timers = new Map(), watches = new Map(), cleared = [], writes = [];
  const light = { id: 'A', code: '검사용 등', lat: 35.146, lng: 126.923, posApprox: true };
  const state = { me: 'fixture', canWrite: true, near: true, q: '', mine: false, kind: '전체', pos: null, lights: [light] };
  const els = Object.fromEntries(['#posTxt', '#posD', '#posFix'].map(id => [id, { hidden: false }]));
  const ctx = vm.createContext({
    Date: { now: () => now }, S: state, draft: null, db: {}, DEV: { gps: true },
    DongguField: require('../../app/field.js'), byId: id => id === light.id ? light : null,
    navGen: () => 1, navAlive: token => token === 1, can: () => true, inDong: () => true,
    fmtDist: String, toRad: degrees => degrees * Math.PI / 180,
    navigator: { geolocation: { watchPosition: callback => { watches.set(++nextWatch, callback); return nextWatch; }, clearWatch: id => cleared.push(id) } },
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id), $: selector => els[selector] || null, toast() {},
    dgConfirm: () => confirm(), withEdit: () => [], write: async fn => { await fn(); return true; },
    patchLight: async (id, patch) => writes.push({ id, ...patch })
  });
  const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start) + start.length));
  vm.runInContext([
    html.slice(from, to), section('const POS_OK=25','async function posApplySuggest('),
    section('function filtered(){','function nearToggle(){'), section('function distM(a,b){','\nfunction ')
  ].join('\n'), ctx);
  return {
    state, light, els, cleared, writes, start: id => { ctx.posCheckStart(id || light.id); return nextWatch; },
    stop: () => ctx.posCheckStop(false), sort: () => ctx.filtered(),
    feed: (watch, acc, lat = 35.147, timestamp = now) => watches.get(watch)({ ...pos(acc, lat), timestamp }),
    advance: ms => {
      const until = now + ms;
      while (true) {
        const event = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!event || event[1].at > until) break;
        timers.delete(event[0]); now = event[1].at; event[1].fn();
      }
      now = until;
    },
    confirm: fn => { confirm = fn; }, correct: () => ctx.posFix()
  };
}

test('retrying a location check for the same facility ignores its previous callbacks and timeout', async () => {
  const h = facilityLocationFixture(), oldWatch = h.start();
  h.advance(20000);
  const newWatch = h.start();
  h.feed(oldWatch, 8, 35.2);
  assert.equal(h.state.pos, null);
  h.advance(10000);
  assert.deepEqual(h.cleared, [oldWatch]);
  h.feed(newWatch, 8);
  await h.correct();
  assert.equal(h.writes[0]?.lat, 35.147);
});

test('facility correction rejects a fix that expires while the confirmation is open', async () => {
  const h = facilityLocationFixture(), watch = h.start();
  h.feed(watch, 8);
  h.confirm(async () => { h.advance(31000); return true; });
  await h.correct();
  assert.deepEqual(h.writes, []);
  assert.equal(h.els['#posFix'].hidden, true);
});

test('facility correction rejects a previous location request even if its measurement is still fresh', async () => {
  const h = facilityLocationFixture(), watch = h.start();
  h.feed(watch, 8);
  h.confirm(async () => { h.start(); return true; });
  await h.correct();
  assert.deepEqual(h.writes, []);
});

test('imprecise facility GPS does not replace a trusted nearby-search location', () => {
  const h = facilityLocationFixture(), watch = h.start(), accepted = { lat: 35.146, lng: 126.923, acc: 10, at: 100000 };
  h.state.pos = accepted;
  h.feed(watch, 3000, 35.2);
  assert.equal(h.state.pos, accepted);
  assert.equal(h.els['#posFix'].hidden, true);
});

test('nearby list sorts the 0 m facility before a facility farther away', () => {
  const h = facilityLocationFixture();
  const other = { ...h.light, id: 'farther', lat: h.light.lat + .00009 };
  h.state.pos = { lat: h.light.lat, lng: h.light.lng };
  h.state.lights = [other, h.light];
  assert.equal(h.sort()[0].id, h.light.id);
});
