const { readSource } = require('./source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const reportHtml = readSource(path.join(root, 'report/index.html'), 'utf8');
const reportScript = [...reportHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(source => source.includes('function sendGateway'));

// Execute the shipped page script with a small DOM/fetch substitute. No network is used.
function reportPage(config, { search = '', response } = {}) {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.textContent = '';
      this.innerHTML = '';
      this.checked = false;
      this.children = [];
      this.listeners = {};
      this.attributes = {};
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    focus() {}
    select() {}
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    scrollIntoView() {}
  }
  const nodes = new Map();
  for (const match of reportHtml.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = new Element(match[1]);
    node.hidden = /\bhidden\b/.test(match[2]);
    node.checked = /\bchecked\b/.test(match[2]);
    nodes.set('#' + match[3], node);
  }
  const requests = [];
  const window = { REPORT_CONFIG: config, scrollTo() {} };
  const sandbox = {
    window,
    document: {
      querySelector(selector) { assert.ok(nodes.has(selector), selector); return nodes.get(selector); },
      querySelectorAll() { return []; },
      createElement(tag) { return new Element(tag); }
    },
    navigator: { userAgent: 'Offline test', clipboard: { writeText: async () => {} } },
    location: { search },
    URL, URLSearchParams, crypto: require('node:crypto').webcrypto,
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return response ? response() : { ok: true, json: async () => ({ receipt: 'R261022-TEST0001', id: 'test-document' }) };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(readSource(path.join(root, 'report/official-handoff.js'), 'utf8'), sandbox);
  vm.runInContext(reportScript, sandbox, { filename: 'report/index.html' });
  const run = source => vm.runInContext(source, sandbox);
  run('st.issue = "불이 꺼져 있어요";if(!st.code)st.code="산수동 1";');
  return { nodes, requests, run, submit: () => nodes.get('#send').onclick() };
}

const firebaseConfig = {
  backend: 'gateway', gatewayUrl: 'http://127.0.0.1:5001/demo/api', allowLocalGateway: true,
  firestore: { projectId: 'demo-donggu-streetlight', apiKey: 'offline-test-key' }
};

function shippedConfig() {
  const configContext = { window: {} };
  vm.createContext(configContext);
  vm.runInContext(readSource(path.join(root, 'report/config.js'), 'utf8'), configContext);
  return configContext.window.REPORT_CONFIG;
}

test('an unconfigured report page cannot show a receipt or attempt a submission', async () => {
  const page = reportPage({ ...shippedConfig(), backend: null, sms: '', mail: '', firestore: {} });
  assert.equal(page.nodes.get('#send').disabled, true);
  assert.match(page.nodes.get('#deliveryNotice').textContent, /준비 중/);
  assert.doesNotMatch(page.nodes.get('#phoneLine').textContent, /000-0000/);
  await page.submit(); // A forced click must not bypass the disabled button.
  assert.equal(page.requests.length, 0);
  assert.equal(page.nodes.get('#done').hidden, true);
  assert.equal(page.nodes.get('#form').hidden, false);
  assert.equal(page.nodes.get('#err').hidden, false);
});

test('partially configured Firebase is not treated as a working submission route', () => {
  const page = reportPage({ backend: 'firestore', firestore: { projectId: 'demo-donggu-streetlight' } });
  assert.equal(page.nodes.get('#send').disabled, true);
});

test('SMS and email preparation never claim that the report was received', async () => {
  const page = reportPage({ backend: null, sms: '01012345678', mail: 'desk@example.invalid' });
  page.nodes.get('#desc').value = '<not markup> & 위치';
  await page.submit();
  assert.equal(page.requests.length, 0);
  assert.equal(page.nodes.get('#done').hidden, false);
  assert.match(page.nodes.get('#doneTitle').textContent, /전송 전/);
  assert.match(page.nodes.get('#doneMsg').textContent, /아직 접수되지/);
  assert.equal(page.nodes.get('#receipt').hidden, true);
  assert.equal(page.nodes.get('#receipt').textContent, '');
  const links = page.nodes.get('#alt').children;
  assert.equal(links.length, 2);
  assert.match(links[0].href, /^sms:01012345678\?body=/);
  assert.match(links[1].href, /^mailto:desk@example\.invalid\?subject=/);
  assert.ok(decodeURIComponent(links[0].href).includes('<not markup> & 위치'));
});

test('a blank optional description is serialized and receipt appears after server success', async () => {
  const page = reportPage(firebaseConfig);
  await page.submit();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].body.desc, '');
  assert.equal('imported' in page.requests[0].body, false);
  assert.equal('at' in page.requests[0].body, false);
  assert.match(page.requests[0].body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(page.nodes.get('#doneTitle').textContent, '접수됐어요');
  assert.equal(page.nodes.get('#receipt').hidden, false);
  assert.match(page.nodes.get('#receipt').textContent, /^R\d{6}-/);
});

test('pending or failed server writes do not produce a receipt', async () => {
  let respond;
  const response = new Promise(resolve => { respond = resolve; });
  const page = reportPage(firebaseConfig, { response: () => response });
  const pending = page.submit();
  assert.equal(page.nodes.get('#done').hidden, true);
  assert.equal(page.nodes.get('#send').disabled, true);
  respond({ ok: false, status: 403, json: async () => ({error:'접수 거부'}) });
  await pending;
  assert.equal(page.nodes.get('#done').hidden, true);
  assert.equal(page.nodes.get('#form').hidden, false);
  assert.equal(page.nodes.get('#send').disabled, false);
  assert.match(page.nodes.get('#err').textContent, /보내지 못했어요/);
});

test('QR light identity is preserved for submission and cleared when its plate is edited', async () => {
  const page = reportPage(firebaseConfig, { search: '?c=%EC%82%B0%EC%88%98%EB%8F%99%20642&lid=p2872307' });
  assert.equal(page.run('st.lightId'), 'p2872307');
  await page.submit();
  assert.equal(page.requests[0].body.lightId, 'p2872307');
  page.nodes.get('#codeEdit').onclick();
  assert.equal(page.run('st.lightId'), null);
  page.nodes.get('#codeIn').listeners.input({ target: { value: '산수동 643' } });
  assert.equal(page.run('st.code'), '산수동 643');
  assert.equal(page.run('st.lightId'), null);
  const invalid = reportPage(firebaseConfig, { search: '?c=test&lid=lights%2Fp2872307' });
  assert.equal(invalid.run('st.lightId'), null);
});

test('admin edit map and custom light options escape database text', async () => {
  const source = readSource(path.join(root, 'index.html'), 'utf8');
  const start = source.indexOf('function openLightEdit(id)');
  const end = source.indexOf('async function saveLightEdit(', start);
  assert.ok(start >= 0 && end > start);
  const escapeSource = source.match(/^const esc=.*;$/m)[0];
  const tooltipContents = [];
  let sheetHtml = '';
  const selected = { id: 'p1', code: '산수동 1', lat: 35.15, lng: 126.92,
    lampType: '</option></select><img src=x onerror="window.bad=true">' };
  const neighbor = { id: 'p2', code: '<img src=x onerror="window.bad=true">', lat: 35.15, lng: 126.92 };
  const layer = () => ({
    addTo() { return this; },
    bindTooltip(content) { tooltipContents.push(content); return this; },
    on() { return this; }
  });
  const L = {
    map: () => ({ setView() { return this; } }),
    tileLayer: layer, circleMarker: layer, marker: layer, divIcon: value => value
  };
  const sandbox = {
    L, window: { L }, S: { lights: [selected, neighbor] }, DongguPWA: { tileLayer: () => layer() },
    byId: () => selected, openSheet(html) { sheetHtml = html; }, repBox: () => '',
    LAMP_OPTS: [], POLE_OPTS: [], SW_OPTS: [], KIND_COL: {},
    ensureRepPhotos: async () => {}, refreshRepBox() {}, distM: () => 5, setTimeout() {}
  };
  vm.createContext(sandbox);
  vm.runInContext('let leMap=null, leMarker=null;\n' + escapeSource + '\n' + source.slice(start, end), sandbox);
  vm.runInContext('openLightEdit("p1")', sandbox);
  assert.equal(tooltipContents.length, 1);
  assert.equal(tooltipContents[0], '&lt;img src=x onerror=&quot;window.bad=true&quot;&gt;');
  assert.doesNotMatch(tooltipContents[0], /<img|<script/i);
  assert.doesNotMatch(sheetHtml, /<img|<script/i);
  assert.ok(sheetHtml.includes('&lt;/option&gt;&lt;/select&gt;&lt;img src=x onerror=&quot;window.bad=true&quot;&gt;'));
});

test('shipped resident page hands off to the official service without collecting or submitting', async () => {
  const config = shippedConfig();
  assert.equal(config.backend, 'official'); assert.equal(config.phone, '');
  const page = reportPage(config);
  assert.equal(page.nodes.get('#officialEntry').hidden, false);
  assert.equal(page.nodes.get('#privateInputs').hidden, true);
  assert.equal(page.nodes.get('#legacySubmit').hidden, true);
  assert.equal(page.nodes.get('#officialOpen').href, 'https://gjd.roadlighting.kr/slamp/repair/map');
  assert.equal(page.nodes.get('#officialStatus').href, 'https://gjd.roadlighting.kr/slamp/repair/status');
  assert.equal(page.nodes.get('#send').disabled, true);
  await page.submit();
  assert.equal(page.requests.length, 0); assert.equal(page.nodes.get('#done').hidden, true);
});

test('a stale direct-intake configuration cannot reopen public database writes', async () => {
  const page = reportPage({ ...shippedConfig(), backend: 'firestore' });
  assert.equal(page.nodes.get('#send').disabled, true);
  await page.submit(); assert.equal(page.requests.length, 0); assert.equal(page.nodes.get('#done').hidden, true);
});

test('editing a QR plate keeps the visible plate in the memo and removes its verified identity', () => {
  const page = reportPage(shippedConfig(), { search: '?c=%EC%82%B0%EC%88%98%EB%8F%99%2042' });
  page.run('st.lightId="p42";st.facility={id:"p42",code:"산수동 42",lampId:"42"};updateOfficialSummary();');
  page.nodes.get('#codeEdit').onclick();
  assert.equal(page.nodes.get('#codeIn').value, '산수동 42');
  assert.equal(page.run('st.code'), '산수동 42');
  assert.equal(page.run('st.lightId'), null);
  assert.equal(page.run('st.facility'), null);
  assert.equal(page.nodes.get('#codeKnown').hidden, true);
  assert.equal(page.nodes.get('#codeAsk').hidden, false);
  assert.match(page.nodes.get('#officialSummary').value, /입력한 표찰\(대장 미확인\): 산수동 42/);
  assert.doesNotMatch(page.nodes.get('#officialSummary').value, /운영 시설번호:/);
});

test('gateway retries keep their request ID and a conflicting response never claims success', async () => {
  let status = 503;
  const page = reportPage(firebaseConfig, { response: () => ({ ok: status < 300, status, json: async () => ({ receipt: 'R261107-TEST0001' }) }) });
  page.nodes.get('#useGps').checked = false;
  await page.submit(); assert.equal(page.nodes.get('#done').hidden, true);
  status = 409; await page.submit();
  assert.equal(page.requests[0].body.requestId, page.requests[1].body.requestId);
  assert.equal(page.nodes.get('#done').hidden, true);
  status = 200; await page.submit(); assert.equal(page.nodes.get('#doneTitle').textContent, '접수됐어요');
});

test('a report filed from outside the district goes through without the position', async () => {
  const page = reportPage(firebaseConfig);
  page.run('st.pos = { lat: 37.5665, lng: 126.978, acc: 10 };');
  page.nodes.get('#useGps').checked = true; page.nodes.get('#desc').value = '산수동 마트 앞';
  await page.submit();
  const fields = page.requests[0].body;
  assert.equal(fields.lat, null); assert.equal(fields.lng, null);
  assert.equal(page.nodes.get('#doneTitle').textContent, '접수됐어요');
  // with nothing else to go on, it asks for a plate or place instead of failing at the server
  const bare = reportPage(firebaseConfig);
  bare.run('st.pos = { lat: 37.5665, lng: 126.978, acc: 10 }; st.code = ""; st.lightId = null;'); bare.nodes.get('#useGps').checked = true; bare.nodes.get('#desc').value = '';
  await bare.submit();
  assert.equal(bare.requests.length, 0); assert.match(bare.nodes.get('#err').textContent, /동구 밖/);
});
