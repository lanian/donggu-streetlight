const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const reportHtml = fs.readFileSync(path.join(root, 'report/index.html'), 'utf8');
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
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    focus() {}
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
    URLSearchParams, crypto: require('node:crypto').webcrypto,
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return response ? response() : { ok: true, json: async () => ({ receipt: 'R261022-TEST0001', id: 'test-document' }) };
    }
  };
  vm.createContext(sandbox);
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
  vm.runInContext(fs.readFileSync(path.join(root, 'report/config.js'), 'utf8'), configContext);
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
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
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

test('the shipped page files directly: one create-only Firestore write with typed fields and a fixed receipt', async () => {
  const config = shippedConfig();
  assert.equal(config.backend, 'firestore');
  let status = 200;
  const page = reportPage(config, { response: () => ({ ok: status < 300, status, json: async () => ({}) }) });
  page.run('st.photo = "data:image/jpeg;base64,dGVzdA=="; st.pos = null;');
  page.nodes.get('#useGps').checked = false; page.nodes.get('#desc').value = '마트 앞';
  assert.equal(page.nodes.get('#send').disabled, false);
  await page.submit();
  assert.equal(page.requests.length, 1);
  const { url } = page.requests[0], fields = page.requests[0].body.fields;
  assert.match(url, /^https:\/\/firestore\.googleapis\.com\/v1\/projects\/donggu-light\/databases\/\(default\)\/documents\/citizen_reports\?documentId=qr-[a-f0-9]{24}&key=/);
  assert.equal(fields.imported.booleanValue, false); assert.equal(fields.schemaVersion.integerValue, '1');
  assert.match(fields.at.integerValue, /^\d+$/); assert.ok(+fields.privacyExpiresAt.integerValue > +fields.at.integerValue);
  assert.equal(fields.desc.stringValue, '마트 앞'); assert.equal(fields.photo.stringValue, 'data:image/jpeg;base64,dGVzdA==');
  assert.equal('contact' in fields, false, 'no contact unless given');
  assert.match(fields.receipt.stringValue, /^R\d{6}-[0-9A-F]{8}$/);
  assert.equal(page.nodes.get('#receipt').textContent, fields.receipt.stringValue);
  assert.equal(page.nodes.get('#doneTitle').textContent, '접수됐어요');
});

test('direct filing: a retry of the same report keeps its ID, and an earlier success (409) counts as filed', async () => {
  let status = 503;
  const page = reportPage(shippedConfig(), { response: () => ({ ok: status < 300, status, json: async () => ({}) }) });
  page.nodes.get('#useGps').checked = false;
  await page.submit();
  assert.equal(page.nodes.get('#done').hidden, true); assert.match(page.nodes.get('#err').textContent, /보내지 못했어요/);
  status = 409; await page.submit();
  assert.equal(page.requests[0].url, page.requests[1].url, 'same document ID on retry');
  assert.equal(page.requests[0].body.fields.receipt.stringValue, page.requests[1].body.fields.receipt.stringValue);
  assert.equal(page.nodes.get('#doneTitle').textContent, '접수됐어요');
});

test('direct filing: a write the rules refuse explains what to check and shows no receipt', async () => {
  const page = reportPage(shippedConfig(), { response: () => ({ ok: false, status: 403, json: async () => ({}) }) });
  page.nodes.get('#useGps').checked = false;
  await page.submit();
  assert.equal(page.nodes.get('#done').hidden, true); assert.match(page.nodes.get('#err').textContent, /신고 내용을 확인/);
});
