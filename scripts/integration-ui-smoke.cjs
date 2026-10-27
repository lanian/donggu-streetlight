/* Optional browser integration smoke. Uses an isolated profile and local data only.
   npm install --no-save playwright && npx playwright install chromium
   node scripts/integration-ui-smoke.cjs
   DONGGU_PLAYWRIGHT_MODULE and DONGGU_CHROMIUM optionally select existing installations. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.DONGGU_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
// Poll resolved async results; Playwright waitForFunction does not await before its truthiness check.
async function poll(page, predicate, arg, label = 'asynchronous browser state') {
  const deadline = Date.now() + 30000;
  do {
    if (await page.evaluate(predicate, arg)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}
const results = [], defects = [];
function expect(name, actual, expected) { try { assert.deepEqual(actual, expected); results.push({name, pass:true}); } catch (e) { defects.push({name, actual, expected}); } }
const server = http.createServer((req,res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.'+decodeURIComponent(url.pathname)+(url.pathname.endsWith('/')?'index.html':''));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end();
  res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm','.webmanifest':'application/manifest+json'})[path.extname(file)]||'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function main() {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://localhost:'+server.address().port;
  const browser=await chromium.launch({executablePath:process.env.DONGGU_CHROMIUM||undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.route('**/*',route=>{const u=new URL(route.request().url());return u.origin===origin?route.continue():route.fulfill({status:200,contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css',body:''});});
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',dialog=>dialog.accept());
  const boot=async()=>{await page.goto(origin);await page.waitForFunction(()=>typeof S!=='undefined'&&S.live&&DGOffline.ready);assert.equal(await page.evaluate(()=>window.FIREBASE_CONFIG),null);assert.equal(await page.evaluate(()=>DGIntegration.whenReady()),true);await page.evaluate(()=>DGOperations.load());};
  // Escape/Back now leave one level at a time (navigation stack); the helper closes every level.
  const close=async()=>{if(await page.locator('#sheet.open').count()){await page.evaluate(()=>closeSheet('all'));await page.waitForFunction(()=>!document.querySelector('#sheet').classList.contains('open'));}};
  const admin=async key=>{await close();await page.locator('[data-tab="admin"]').click();await page.locator('[data-asec="'+key+'"]').click();};
  try {
    await boot();
    if(await page.locator('#demoRole').inputValue()!=='admin')await page.locator('#demoRole').selectOption('admin');
    await admin('inbox');
    const sample=await page.evaluate(()=>S.lights.find(l=>l.code==='산수동 642')||S.lights.find(l=>l.kind==='보안등'&&!l.noPlate));
    const values={ibNum:sample.code,ibLoc:'로컬 검증 위치',ibDesc:'입력 도중 실시간 갱신을 받아도 유지할 신고 내용',ibRc:'R261022-TEST',ibContact:'000-TEST'};
    for(const[id,value]of Object.entries(values))await page.locator('#'+id).fill(value);
    await page.locator('#ibIssue button').nth(1).click();
    const issue=await page.locator('#ibIssue button[aria-pressed="true"]').getAttribute('data-ibissue');
    await page.locator('#ibDesc').focus();await page.evaluate(()=>document.querySelector('#ibDesc').setSelectionRange(3,7));
    await page.evaluate(async()=>{await db.collection('reports').add({issue:'로컬 실시간 이벤트',location:'다른 작성자',desc:'다른 보고 갱신',status:'접수',createdAt:Date.now(),reporterId:'test-other'});});
    await page.waitForFunction(()=>S.reports.some(r=>r.desc==='다른 보고 갱신'));
    const kept=await page.evaluate(ids=>Object.fromEntries(ids.map(id=>[id,document.getElementById(id).value])),Object.keys(values));
    expect('staff inbox retains fields during real local snapshot',kept,values);
    expect('staff inbox retains selected issue',await page.locator('#ibIssue button[aria-pressed="true"]').getAttribute('data-ibissue'),issue);
    expect('staff inbox retains focus and selection',await page.evaluate(()=>[document.activeElement.id,document.activeElement.selectionStart,document.activeElement.selectionEnd]),['ibDesc',3,7]);
    await page.locator('#ibAdd').click();
    await page.waitForFunction(text=>S.reports.some(r=>r.desc===text),values.ibDesc);
    await page.waitForFunction(()=>document.querySelector('#ibDesc').value==='');
    expect('staff inbox clears submitted fields',await page.evaluate(ids=>ids.map(id=>document.getElementById(id).value),Object.keys(values)),Object.keys(values).map(()=>''));
    expect('staff inbox creates one linked report',await page.evaluate(({desc,id})=>S.reports.filter(r=>r.desc===desc&&r.lightId===id).length,{desc:values.ibDesc,id:sample.id}),1);
    console.log('inbox done');

    await admin('due');await page.locator('#dgDueFilter').selectOption('all');await page.locator('#dgDueDong').selectOption('a:서남동');
    const expected=await page.evaluate(()=>S.lights.filter(l=>!l.removed&&inDong(l,'a:서남동')).map(l=>l.id).sort());
    const shown=await page.locator('[data-plan-light]').evaluateAll(els=>els.map(el=>el.dataset.planLight));
    expect('administrative dong list contains only selected area',shown.every(id=>expected.includes(id)),true);
    expect('administrative dong select preserved',await page.locator('#dgDueDong').inputValue(),'a:서남동');
    await page.locator('[data-dg="due-map"]').click();await page.waitForFunction(()=>typeof gmapPts!=='undefined'&&!!document.querySelector('#gmap'));
    expect('due map and complete filtered list use same facilities',await page.evaluate(()=>gmapPts.map(l=>l.id).sort()),expected);
    await admin('due');
    await page.locator('[data-plan-light]').nth(0).check();await page.locator('[data-plan-light]').nth(1).check();
    const chosen=await page.locator('[data-plan-light]:checked').evaluateAll(els=>els.map(el=>el.dataset.planLight));
    await page.evaluate(()=>render());expect('visit choices survive refresh',await page.locator('[data-plan-light]:checked').evaluateAll(els=>els.map(el=>el.dataset.planLight)),chosen);
    const lastInspection=await page.evaluate(ids=>Object.fromEntries(ids.map(id=>[id,byId(id).lastInspected||null])),chosen);
    await page.locator('[data-dg="make-plan"]').click();await page.waitForFunction(()=>DGOperations.state.plan&&DGOperations.state.plan.stops.length===2);
    expect('visit plan contains selected facility IDs',await page.evaluate(()=>DGOperations.state.plan.stops.map(s=>s.id).sort()),[...chosen].sort());
    await page.locator('[data-plan-visited="0"]').check();await page.waitForFunction(()=>DGOperations.state.plan.stops[0].visited);
    expect('visited toggle does not mark inspection complete',await page.evaluate(ids=>Object.fromEntries(ids.map(id=>[id,byId(id).lastInspected||null])),chosen),lastInspection);
    const oldOrder=await page.evaluate(()=>DGOperations.state.plan.stops.map(s=>s.id));await page.locator('[data-dg="plan-up"][data-index="1"]').click();
    await page.waitForFunction(id=>DGOperations.state.plan.stops[0].id===id,oldOrder[1]);
    await poll(page, async id=>(await DGOffline.get('plan','current'))?.stops[0].id===id, oldOrder[1], 'the reordered visit plan to persist');
    const savedPlan=await page.evaluate(()=>JSON.parse(JSON.stringify(DGOperations.state.plan)));
    await boot();await admin('due');
    expect('visit order and visited state survive reload',await page.evaluate(()=>DGOperations.state.plan),savedPlan);
    console.log('due / visit done');

    await admin('registryupdate');
    expect('registry file input keeps its identity during a live refresh',await page.evaluate(()=>{const input=document.getElementById('dgRegistryFile');render();return input===document.getElementById('dgRegistryFile')&&input.isConnected;}),true);
    const original=await page.evaluate(()=>BASE.find(l=>typeof l.lat==='number'&&typeof l.lng==='number'&&!OV[l.id]));
    const changed1={...original,lampType:'로컬 테스트 광원 1'};
    const upload=async(row,name)=>{await page.locator('#dgRegistryFile').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify([row]))});await page.waitForFunction(name=>DGManagement.state.registry&&DGManagement.state.source===name,name);};
    await upload(changed1,'registry-first.json');
    expect('registry first diff recognizes one change',await page.evaluate(()=>[DGManagement.state.registry.added.length,DGManagement.state.registry.changed.length]),[0,1]);
    await page.locator('[data-mgmt="registry-apply"]').click();
    await page.waitForFunction(id=>byId(id).lampType==='로컬 테스트 광원 1',original.id);
    await page.waitForFunction(()=>DGManagement.state.registry===null);
    const changed2={...changed1,lampType:'로컬 테스트 광원 2'};
    await upload(changed2,'registry-second.json');
    expect('registry second diff compares against last accepted registry',await page.evaluate(()=>({changed:DGManagement.state.registry.changed.length,conflicts:DGManagement.state.registry.changed[0].conflicts})),{changed:1,conflicts:[]});
    await page.locator('[data-mgmt="registry-apply"]').click();
    await page.waitForFunction(id=>byId(id).lampType==='로컬 테스트 광원 2',original.id);
    expect('second registry update applied with stable ID',await page.evaluate(id=>({id:byId(id).id,lampType:byId(id).lampType}),original.id),{id:original.id,lampType:changed2.lampType});
    expect('new registry baseline remains attached',await page.evaluate(id=>OV[id].registryValues.lampType,original.id),changed2.lampType);
    console.log('registry done');
    expect('no uncaught browser exceptions',errors,[]);
    console.log(JSON.stringify({results,defects,errors},null,2));
    if(defects.length)process.exitCode=1;
  } catch (error) {
    const diagnostic=await page.evaluate(async()=>({source:DGManagement.state.source,registryError:DGManagement.state.registryError,registryChanged:DGManagement.state.registry?.changed.length,selectedFile:document.querySelector('#dgRegistryFile')?.files[0]?.name,toast:document.querySelector('#toast')?.textContent,jobs:(await DGOffline.jobs()).map(j=>({kind:j.kind,state:j.state,error:j.error}))})).catch(()=>({}));
    console.error(JSON.stringify({diagnostic,browserErrors:errors},null,2));throw error;
  } finally { await browser.close();server.close(); }
}
main().catch(e=>{console.error(e.stack);console.error(JSON.stringify({results,defects}));server.close();process.exitCode=1;});
