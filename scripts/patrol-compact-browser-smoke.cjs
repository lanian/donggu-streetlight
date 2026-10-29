/* Night patrol UX: compact history, unchecked queue and read-only summary grouping. */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.DONGGU_PLAYWRIGHT_MODULE||'playwright');
const root=process.env.DG_OPERATIONS_ROOT||path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 const file=path.resolve(root,'.'+decodeURIComponent(pathname)+(pathname.endsWith('/')?'index.html':''));
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return res.writeHead(404).end();
 res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
 res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://localhost:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.DONGGU_CHROMIUM||undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote']});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:'',contentType:route.request().url().includes('.js')?'text/javascript':'text/plain'}));
 const page=await context.newPage(),errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{
   await page.goto(origin);
   await page.waitForFunction(()=>S.live&&DGOffline.ready&&S.me==='local'&&DGIntegration.initialized&&!!window.DGPatrolHistory);
   const ids=await page.evaluate(()=>{
     S.demoRole='admin';S.tab='inspect';render();openPatrol('전체');
     const lights=S.lights.filter(l=>Number.isFinite(l.lat)&&Number.isFinite(l.lng)).slice(0,40);
     window.__testPatrolLights=lights;
     pt.ahead=lights.slice(0,4).map((l,i)=>({l,d:15+i*8,fwd:15+i*8,side:'정면',b:0}));
     pt.heading=0;ptDraw(true);
     return lights.map(l=>l.id);
   });
   assert.ok(ids.length>=30,'real local registry is available');
   assert.equal(await page.locator('#ptHistory').getAttribute('open'),null);
   assert.equal(await page.locator('#ptLog').locator('.ptlogrow').count(),0);
   assert.equal(await page.locator('#ptAhead .ptcard').count(),4);
   checks.push('default patrol screen shows pending lamps only; history starts collapsed');

   await page.locator('[data-ptmark="정상"]').click();
   await page.waitForFunction(()=>pt.marks.length===1);
   assert.equal(await page.locator('#ptAhead .ptcard').count(),3);
   assert.equal(await page.locator('#ptLog .ptlogrow').count(),0);
   assert.match(await page.locator('#ptHistoryTitle').textContent(),/기록 1건/);
   await page.locator('[data-ptmark="정상"]').click();
   assert.equal(await page.locator('#ptAhead .ptcard').count(),2);
   assert.equal(await page.evaluate(()=>pt.marks.length),2);
   checks.push('recording inspected lamps removes them from the default forward queue without deleting data');

   await page.locator('#ptShowChecked').click();
   assert.equal(await page.locator('#ptAhead .ptcard').count(),4);
   assert.equal(await page.locator('#ptShowChecked').getAttribute('aria-pressed'),'true');
   await page.locator('#ptAhead .ptcard[data-ptsel="'+ids[0]+'"]').click();
   await page.locator('[data-ptmark="고장"]').click();
   assert.equal(await page.evaluate(()=>pt.marks.length),2,'rechecking same lamp updates existing mark');
   assert.equal(await page.evaluate(id=>pt.marks.find(m=>m.id===id).result,ids[0]),'고장');
   await page.locator('#ptShowChecked').click();
   checks.push('reviewed lamps can be shown and deliberately reclassified');

   await page.evaluate(()=>{
     pt.marks=window.__testPatrolLights.slice(0,30).map((l,i)=>({id:l.id,code:l.code,result:i===0?'고장':i===1?'점검필요':'정상',at:Date.now()+i,pos:null}));
     pt.spots=[{lat:35.1489,lng:126.928,acc:8,at:Date.now()+40,near:pt.marks[0].code,nearD:42}];
     pt.ahead=window.__testPatrolLights.slice(0,4).map((l,i)=>({l,d:15+i*8,fwd:15+i*8,side:'정면',b:0}));
     ptDraw(true);
   });
   assert.equal(await page.locator('#ptAhead .ptcard').count(),0);
   assert.equal(await page.evaluate(()=>pt.marks.length),30);
   assert.equal(await page.evaluate(()=>pt.spots.length),1);
   assert.equal(await page.locator('#ptLog .ptlogrow').count(),0);
   assert.match(await page.locator('#ptHistoryTitle').textContent(),/기록 31건 · 확인 필요 3 · 정상 28/);
   checks.push('31 saved-in-memory observations remain available with one compact live summary');

   await page.locator('#ptHistory summary').click();
   await page.waitForFunction(()=>document.querySelector('#ptHistory')?.open===true);
   assert.equal(await page.locator('#ptLog .ptlogrow').count(),10);
   await page.locator('#ptHistoryMore').click();
   assert.equal(await page.locator('#ptLog .ptlogrow').count(),20);
   await page.locator('[data-ptlogfilter="issues"]').click();
   assert.equal(await page.locator('#ptLog .ptlogrow').count(),3);
   assert.match(await page.locator('#ptHistoryLatest').textContent(),/어두운 지점/);
   await page.locator('[data-ptlogfilter="normal"]').click();
   assert.equal(await page.locator('#ptLog .ptlogrow').count(),10);
   await page.locator('[data-ptlogfilter="all"]').click();
   assert.equal(await page.locator('#ptLog .ptlogrow').count(),10);
   const spot=page.locator('#ptLog [data-ptspotdel="0"]');
   await spot.click();
   assert.equal(await page.evaluate(()=>pt.spots.length),0,'removing one displayed spot removes just that spot');
   assert.equal(await page.evaluate(()=>pt.marks.length),30);
   checks.push('expanded log supports filtering, paging, individual correction without losing other results');

   await page.setViewportSize({width:812,height:375});
   assert.equal(await page.locator('#ptHistory').isVisible(),true);
   assert.equal(await page.locator('#ptHistory summary').isVisible(),true);
   const layout=await page.evaluate(()=>{
     const bottom=document.querySelector('#ptFull .bottom').getBoundingClientRect();
     const queue=document.querySelector('#ptQueueLabel').getBoundingClientRect();
     return {bottom:bottom.bottom,viewport:innerHeight,queue:queue.height};
   });
   assert.ok(layout.bottom<=layout.viewport+1&&layout.queue>0,'landscape keeps patrol navigation accessible');
   checks.push('landscape patrol retains the expandable history control');

   await page.setViewportSize({width:390,height:844});
   await page.locator('#ptHistory summary').click();
   await page.waitForFunction(()=>!document.querySelector('#ptHistory')?.open);
   assert.equal(await page.locator('#ptLog .ptlogrow').count(),0);
   await page.locator('#ptEnd').click();
   await page.locator('#ptSumm').waitFor();
   assert.equal(await page.evaluate(()=>pt.marks.length),30,'finishing patrol retains all 30 observations');
   assert.equal(await page.locator('#ptSummaryNormal').count(),1);
   assert.equal(await page.locator('#ptSummaryNormal').getAttribute('open'),null);
   assert.match(await page.locator('#ptSummaryNormal summary').textContent(),/28건/);
   assert.equal(await page.locator('#ptSumm .list').first().locator('.panel').count(),2);
   assert.equal(await page.locator('#ptSave').isEnabled(),true);
   await page.locator('#ptSummaryNormal summary').click();
   await page.waitForFunction(()=>document.querySelector('#ptSummaryNormal')?.open);
   assert.equal(await page.locator('#ptSummaryNormal .panel').count(),28);
   checks.push('final results prioritize two issues while preserving 28 normal records in a disclosure');
   assert.deepEqual(errors,[],'no browser JavaScript exceptions');
   console.log(JSON.stringify({checks,browserErrors:errors},null,2));
 } finally{await context.close();await browser.close();server.close()}
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1});
