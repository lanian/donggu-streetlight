/* Browser verification: desktop network location must not overwrite field coordinates.
   Exercises registration, manual Leaflet location, live redraw, and map following. */
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
 const context=await browser.newContext({viewport:{width:1366,height:850},serviceWorkers:'block',permissions:['geolocation'],geolocation:{latitude:35.169,longitude:126.95,accuracy:2600}});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:'',contentType:route.request().url().endsWith('.js')?'text/javascript':'text/plain'}));
 const page=await context.newPage();const errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{
   await page.goto(origin);
   await page.waitForFunction(()=>S.live&&DGOffline.ready&&S.me==='local'&&DGIntegration.initialized);
   await page.evaluate(()=>{S.demoRole='admin';S.tab='admin';render();history.replaceState({nav:0,tab:'admin'},'')});
   await page.evaluate(()=>openAdminSection('reg'));
   await page.locator('#nLat').fill('35.146000');await page.locator('#nLng').fill('126.923000');
   const original=await page.evaluate(()=>[$('#nLat').value,$('#nLng').value]);
   await page.locator('#gps').click();
   await page.waitForFunction(()=>document.querySelector('#regLocHelp')?.textContent.includes('오차'));
   await page.waitForFunction(()=>!document.querySelector('#gps').disabled);
   assert.deepEqual(await page.evaluate(()=>[$('#nLat').value,$('#nLng').value]),original,'coarse location cannot modify existing form coordinates');
   assert.match(await page.locator('#regLocHelp').textContent(),/지도에서 설치 지점/);
   checks.push('2600m estimated location does not overwrite registration coordinates');

   await context.setGeolocation({latitude:35.172346,longitude:126.948765,accuracy:15});
   await page.locator('#gps').click();
   await page.waitForFunction(()=>document.querySelector('#nLat')?.value==='35.172346');
   assert.equal(await page.locator('#nLng').inputValue(),'126.948765');
   assert.equal(await page.evaluate(()=>window.__nAcc),15);
   checks.push('15m accuracy browser position fills registration fields with provenance');

   await page.locator('#regMapPickBtn').click();
   await page.waitForFunction(()=>regPickMap&&document.querySelector('#regMapPick')?.offsetHeight>0);
   assert.equal(await page.locator('#regMapPickBtn').getAttribute('aria-expanded'),'true');
   await page.evaluate(()=>{regPickMap.fire('click',{latlng:L.latLng(35.142345,126.925678)});});
   assert.equal(await page.locator('#nLat').inputValue(),'35.142345');
   assert.equal(await page.locator('#nLng').inputValue(),'126.925678');
   assert.equal(await page.evaluate(()=>window.__nAcc),null,'manual selection must clear the old GPS precision');
   await page.evaluate(()=>refreshAdminSection());
   assert.equal(await page.locator('#nLat').inputValue(),'35.142345');
   assert.equal(await page.evaluate(()=>regPickMap?.getContainer()?.isConnected),true,'map stays attached during a section redraw');
   await page.evaluate(()=>{regPickMarker.setLatLng([35.147654,126.931234]);regPickMarker.fire('dragend');});
   assert.equal(await page.locator('#nLng').inputValue(),'126.931234');
   checks.push('manual map click/drag and live refresh preserve selected coordinates');

   await page.goBack();
   await page.waitForFunction(()=>!document.querySelector('#sheet').classList.contains('open'));
   assert.equal(await page.evaluate(()=>regPickMap===null),true,'leaving registration disposes the map');
   checks.push('Back cleans up the picker and returns to its parent');

   await context.setGeolocation({latitude:35.15,longitude:126.95,accuracy:2300});
   const lightId=await page.evaluate(()=>S.lights.find(l=>Number.isFinite(l.lat)&&Number.isFinite(l.lng))?.id);
   assert.ok(lightId,'registry must load');
   await page.evaluate(id=>openLightEdit(id),lightId);
   await page.locator('#leLat').waitFor();
   const old=await page.locator('#leLat').inputValue();
   await page.locator('#leGps').click();
   await page.waitForFunction(()=>document.querySelector('#leAcc')?.textContent.includes('부정확'));
   assert.equal(await page.locator('#leLat').inputValue(),old);
   checks.push('editing an existing lamp blocks 2300m estimated location');

   await page.goBack();
   await page.waitForFunction(()=>!document.querySelector('#sheet').classList.contains('open'));
   await context.setGeolocation({latitude:35.169,longitude:126.95,accuracy:2600});
   await page.evaluate(()=>openMap('filtered'));
   await page.locator('#mapLoc').click();
   await page.waitForFunction(()=>ME.pos&&ME.pos.acc>150&&ME.follow===false);
   assert.match(await page.locator('#mapNote').textContent(),/추정치/);
   assert.equal(await page.locator('#mapLoc').getAttribute('aria-pressed'),'false');
   checks.push('map avoids automatic following when PC position is too imprecise');

   assert.deepEqual(errors,[]);
   console.log(JSON.stringify({checks,browserErrors:errors},null,2));
 } finally{await context.close();await browser.close();server.close();}
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
