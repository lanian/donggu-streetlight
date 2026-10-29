/* Browser-level verification of visible-only responsive bottom navigation. */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.DONGGU_PLAYWRIGHT_MODULE||'playwright');
const root=process.env.DG_OPERATIONS_ROOT||path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const file=path.resolve(root,'.'+decodeURIComponent(u.pathname)+(u.pathname.endsWith('/')?'index.html':''));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return res.writeHead(404).end();
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'})[path.extname(file)]||'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://localhost:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.DONGGU_CHROMIUM||undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:'',contentType:route.request().url().endsWith('.js')?'text/javascript':'text/plain'}));
 const page=await context.newPage(),errors=[],passed=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 async function measure(count){
   const v=await page.evaluate(()=>{
     const nav=document.querySelector('nav.tabs'),box=nav.getBoundingClientRect();
     return {hidden:nav.hidden,display:getComputedStyle(nav).display,right:box.right,viewport:innerWidth,
       children:[...nav.querySelectorAll('button')].map(e=>({key:e.dataset.tab,hidden:e.hidden,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,selected:e.getAttribute('aria-selected'),tabIndex:e.tabIndex}))};
   });
   assert.equal(v.hidden,count===0);
   if(!count){assert.equal(v.display,'none');return;}
   const show=v.children.filter(x=>!x.hidden);
   assert.equal(show.length,count);
   assert.ok(show.every(x=>x.w>=44&&x.h>=44),'touch targets >=44px');
   assert.ok(show.every(x=>x.left>=0&&x.right<=v.viewport+1),'no tab overflow');
   assert.ok(Math.max(...show.map(x=>x.w))-Math.min(...show.map(x=>x.w))<1,'visible widths equal');
   assert.equal(show.filter(x=>x.selected==='true').length,1);
   assert.equal(show.filter(x=>x.tabIndex===0).length,1);
 }
 try{
   await page.goto(origin);
   await page.waitForFunction(()=>S.live&&DGOffline.ready&&S.me==='local'&&DGIntegration.initialized);
   await page.evaluate(()=>{S.demoRole='admin';S.tab='inspect';FEATURES.reports=false;render();history.replaceState({nav:0,tab:'inspect'},'')});
   for(const width of [320,360,390,768]){await page.setViewportSize({width,height:844});await measure(2);}
   passed.push('two visible tabs evenly fill 320/360/390/768px without a blank third column');
   await page.setViewportSize({width:390,height:844});
   await page.locator('nav.tabs [data-tab="admin"]').click();
   await page.waitForFunction(()=>S.tab==='admin');
   assert.equal(await page.evaluate(()=>history.state.tab),'admin');
   await page.goBack();await page.waitForFunction(()=>S.tab==='inspect');
   passed.push('touch tab switch and phone Back restore the correct active tab');
   await page.locator('nav.tabs [data-tab="inspect"]').focus();
   await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>S.tab==='admin');
   assert.equal(await page.evaluate(()=>document.activeElement?.dataset.tab),'admin');
   await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>S.tab==='inspect');
   await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>S.tab==='admin');
   await page.keyboard.press('Home');await page.waitForFunction(()=>S.tab==='inspect');
   await page.keyboard.press('End');await page.waitForFunction(()=>S.tab==='admin');
   passed.push('Arrow keys, Home and End navigate visible tabs with focus');
   await page.evaluate(()=>{FEATURES.reports=true;render()});
   await measure(3);
   await page.locator('nav.tabs [data-tab="report"]').click();await page.waitForFunction(()=>S.tab==='report');
   await measure(3);
   passed.push('all three tabs redistribute and report tab remains operable if enabled');
   await page.evaluate(()=>{S.demoRole='resident';render()});
   await measure(0);
   assert.ok(parseFloat(await page.locator('.wrap').evaluate(e=>getComputedStyle(e).paddingBottom))<=40);
   passed.push('one allowed tab hides navigation and releases its bottom padding');
   await page.evaluate(()=>{S.demoRole='admin';FEATURES.reports=false;S.tab='inspect';render()});
   await page.addStyleTag({content:'nav.tabs{padding-bottom:28px!important}'});
   const safe=await page.locator('nav.tabs').evaluate(e=>({bottom:e.getBoundingClientRect().bottom,height:innerHeight,buttons:[...e.querySelectorAll('button:not([hidden])')].map(b=>b.getBoundingClientRect().bottom)}));
   assert.ok(Math.abs(safe.bottom-safe.height)<1);
   assert.ok(safe.buttons.every(bottom=>bottom<=safe.height-28));
   passed.push('simulated 28px gesture area remains outside touch controls');
   assert.deepEqual(errors,[]);
   console.log(JSON.stringify({passed,browserErrors:errors},null,2));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});