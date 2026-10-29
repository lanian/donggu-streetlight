/* PC workspace smoke: real app, real CSS, History, and responsive widths. */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.DONGGU_PLAYWRIGHT_MODULE||'playwright');
const root=process.env.DG_OPERATIONS_ROOT||path.resolve(__dirname,'..');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(root,'.'+decodeURIComponent(pathname)+(pathname.endsWith('/')?'index.html':''));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return res.writeHead(404).end();
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
  res.end(fs.readFileSync(file));
});
const cssColumns=value=>value.split(' ').filter(Boolean).length;
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://localhost:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.DONGGU_CHROMIUM||undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']});
 const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:'',contentType:route.request().url().endsWith('.js')?'text/javascript':'text/plain'}));
 const page=await context.newPage(),errors=[],results=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const layout=()=>page.evaluate(()=>{
   const rect=s=>document.querySelector(s).getBoundingClientRect();
   const nav=rect('nav.tabs'),wrap=rect('.wrap');
   return {w:innerWidth,nav:{x:nav.x,y:nav.y,width:nav.width,height:nav.height,right:nav.right,bottom:nav.bottom},wrap:{x:wrap.x,width:wrap.width,right:wrap.right},overflow:document.documentElement.scrollWidth>innerWidth,
     menuCols:getComputedStyle(document.querySelector('#view .menu')).gridTemplateColumns,
     listCols:getComputedStyle(document.querySelector('#view .list')).gridTemplateColumns,
     buttonDirection:getComputedStyle(document.querySelector('nav.tabs button:not([hidden])')).flexDirection};
 });
 try{
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>S.live&&DGOffline.ready&&S.me==='local'&&DGIntegration.initialized);
  await page.evaluate(()=>{S.demoRole='admin';S.tab='admin';render();history.replaceState({nav:0,tab:'admin'},'')});
  assert.equal(await page.locator('nav.tabs button:not([hidden])').count(),2,'current public app has two visible tabs');
  for(const [width,menuCols] of [[1024,2],[1280,3],[1440,3],[1920,4]]){
    await page.setViewportSize({width,height:900});
    const d=await layout();
    assert.ok(!d.overflow,'no document horizontal scroll at '+width);
    assert.ok(Math.abs(d.nav.x)<1&&Math.abs(d.nav.width-216)<2&&Math.abs(d.nav.height-900)<2,'fixed left rail at '+width);
    assert.ok(d.wrap.x>=d.nav.right+24&&d.wrap.right<=width+1,'workspace clears rail at '+width);
    assert.equal(d.buttonDirection,'row','desktop icon/label side by side');
    assert.equal(cssColumns(d.menuCols),menuCols,'management card columns at '+width);
    assert.equal(cssColumns(d.listCols),2,'facility cards use two columns on desktop');
    const buttons=await page.locator('nav.tabs button:not([hidden])').evaluateAll(els=>els.map(x=>({w:x.getBoundingClientRect().width,h:x.getBoundingClientRect().height})));
    assert.ok(buttons.every(x=>x.w>=44&&x.h>=44),'large pointer targets at '+width);
  }
  results.push('1024/1280/1440/1920px: fixed sidebar, wider workspace, 2-column facilities, adaptive management cards, no overflow');

  await page.locator('nav.tabs [data-tab="inspect"]').click();
  await page.waitForFunction(()=>S.tab==='inspect');
  const actions=await page.locator('#view .actions').evaluate(e=>getComputedStyle(e).gridTemplateColumns);
  assert.equal(cssColumns(actions),4,'four desktop quick actions');
  await page.goBack();await page.waitForFunction(()=>S.tab==='admin');
  results.push('desktop tab interaction and browser Back preserve app History');

  await page.evaluate(()=>openAdminSection('works'));
  await page.locator('#sheet.open').waitFor();
  const drawer=await page.locator('.sheet').evaluate(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width}});
  assert.ok(drawer.left>=216&&Math.abs(drawer.right-1920)<1&&drawer.width<=860,'right-side desktop detail drawer');
  await page.goBack();await page.waitForFunction(()=>!document.querySelector('#sheet').classList.contains('open'));
  results.push('detail drawer stays to the right of the rail and closes with Back');

  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('nav.tabs').evaluate(e=>getComputedStyle(e).display),'none','print hides workspace navigation');
  await page.emulateMedia({media:'screen'});
  results.push('print layout continues hiding application navigation');

  await page.evaluate(()=>{S.demoRole='resident';render()});
  const hidden=await page.evaluate(()=>{const nav=document.querySelector('nav.tabs'),wrap=document.querySelector('.wrap').getBoundingClientRect();return{hidden:nav.hidden,navDisplay:getComputedStyle(nav).display,center:Math.abs((wrap.left+wrap.right)/2-innerWidth/2)}});
  assert.ok(hidden.hidden&&hidden.navDisplay==='none'&&hidden.center<2,'single/zero-tab screen centers without wasted left rail');
  results.push('hidden navigation restores centered single-screen desktop layout');

  await page.evaluate(()=>{S.demoRole='admin';S.tab='admin';render()});
  for(const width of [390,768,960]){
    await page.setViewportSize({width,height:900});
    const d=await layout();
    assert.ok(!d.overflow,'no mobile/tablet overflow');
    assert.ok(Math.abs(d.nav.bottom-900)<1,'bottom menu remains at '+width);
    assert.equal(d.buttonDirection,'column','mobile labels remain stacked at '+width);
  }
  results.push('390/768/960px retain the existing bottom tab bar and single-column facility list');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({results,browserErrors:errors},null,2));
 }catch(error){
  console.error(JSON.stringify(await page.evaluate(()=>({tab:S?.tab,live:S?.live,nav:getComputedStyle(document.querySelector('nav.tabs')).cssText,errors:window.__errors||[]})).catch(()=>({})),null,2));
  throw error;
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
