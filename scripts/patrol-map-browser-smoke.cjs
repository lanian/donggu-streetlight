/* Night patrol map: heading-up follow mode, numbered markers that match the visible queue, and a record panel that
   does not squeeze the map. GPS is fed by hand (same fixture approach as patrol-compact-browser-smoke.cjs). */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.DONGGU_PLAYWRIGHT_MODULE||'playwright');
const root=process.env.DG_OPERATIONS_ROOT||path.resolve(__dirname,'..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{
  // Browser checks always run the device (체험) mode: the deployed firebase-config.js points at the real project.
  if (req.url.split('?')[0].endsWith('/firebase-config.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end('window.FIREBASE_CONFIG = null;'); }
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
 // tiles and any other outside request answer empty: the map still lays out and draws markers
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:200,body:'',contentType:route.request().url().includes('.js')?'text/javascript':'text/plain'}));
 const page=await context.newPage(),errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept()); await page.addInitScript(() => { /* in-app dialogs (app/dialog.js) replaced window.confirm: accept them like the native handler */ new MutationObserver(() => { const ok = document.querySelector('#dgDialog:not([hidden]) [data-dgdlg="ok"]'); if (ok) ok.click(); }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] }); });
 const numbers=()=>page.evaluate(()=>[...document.querySelectorAll('#ptMapBox .ptmapnum div')].map(d=>d.textContent).sort((a,b)=>a-b));
 // rotation angle of the number badges, read from the computed matrix once the transition has settled
 const badgeAngles=()=>page.evaluate(()=>[...new Set([...document.querySelectorAll('#ptMapBox .ptmapnum div')].map(d=>{const m=new DOMMatrixReadOnly(getComputedStyle(d).transform);return Math.round(Math.atan2(m.b,m.a)*180/Math.PI)}))]);
 const carScreenBearing=()=>page.evaluate(()=>{
   const car=pt.mapMe.getElement().querySelector('.car');let matrix=new DOMMatrixReadOnly();
   // Compose every actual DOM ancestor, including Leaflet's marker panes and the turning map plate.
   // A direction vector has w=0, so layout translations and transform origins cannot affect its bearing.
   for(let element=car;element;element=element.parentElement){const transform=getComputedStyle(element).transform;if(transform&&transform!=='none')matrix=new DOMMatrixReadOnly(transform).multiply(matrix)}
   const v=new DOMPoint(0,-1,0,0).matrixTransform(matrix);return ((Math.atan2(v.x,-v.y)*180/Math.PI)%360+360)%360;
 });
 const assertCarScreenBearing=async(expected,context)=>{const actual=await carScreenBearing(),error=Math.abs((((actual-expected)%360+540)%360)-180);assert.ok(error<1,context+': expected screen '+expected+'°, got '+actual.toFixed(3)+'°')};
 try{
   await page.goto(origin);
   await page.waitForFunction(()=>S.live&&DGOffline.ready&&S.me==='local'&&DGIntegration.initialized&&!!window.DGPatrolHistory);
   const start=await page.evaluate(()=>{
     S.demoRole='admin';S.tab='inspect';render();openPatrol('전체');
     // Freeze GPS only in this deterministic fixture: live patrol keeps its normal watcher.
     if(pt.watch!=null){navigator.geolocation.clearWatch(pt.watch);pt.watch=null}
     pt.watchRun=(pt.watchRun||0)+1;
     // start from the densest cluster of registered lights so the queue has several entries
     const ls=S.lights.filter(l=>Number.isFinite(l.lat)&&Number.isFinite(l.lng));const G=lightGrid();let best=null;
     for(const l of ls.slice(0,800)){const me=G.toXY(l);const n=G.near(me.x,me.y,120).length;if(!best||n>best.n)best={l,n}}
     return {lat:best.l.lat,lng:best.l.lng};
   });
   await page.evaluate(()=>ptView('map'));
   await page.waitForFunction(()=>pt.map&&pt.mapOn);
   const feed=async(i,heading)=>{await page.evaluate(({lat,lng,i,h})=>{const d=i*10;ptPos({coords:{latitude:lat+d*Math.cos(h*Math.PI/180)/110540,longitude:lng+d*Math.sin(h*Math.PI/180)/(111320*Math.cos(lat*Math.PI/180)),accuracy:8,speed:8,heading:h}})},{lat:start.lat,lng:start.lng,i,h:heading});await page.waitForTimeout(90)};
   for(let i=0;i<25;i++)await feed(i,40);
   await page.waitForTimeout(600);
   assert.ok(await page.evaluate(()=>pt.ahead.length>=2),'the fixture drive produces a queue of at least two lights');
   assert.equal(await page.evaluate(()=>pt.heading),40);

   // 1. heading-up by default: the map layer turns by -heading, the car and the numbers stay upright
   checks.push('heading-up follow rotates the map layer');
   await page.waitForTimeout(600); // let the .45s rotation transition settle
   assert.equal(await page.evaluate(()=>pt.headUp&&pt.mapFollow),true);
   assert.equal(await page.evaluate(()=>$('#ptMapRot').style.transform),'rotate(-40deg)');
   await assertCarScreenBearing(0,'heading-up composes the car and parent rotations');
   assert.equal(await page.evaluate(()=>$('#ptMapBox').style.getPropertyValue('--ptrot')),'-40deg');
   assert.deepEqual(await badgeAngles(),[40],'number badges are counter-rotated so they read upright');
   assert.equal(await page.locator('#ptMapHeadUp').getAttribute('aria-pressed'),'true');
   // the map is inside the rotating layer, the two buttons are outside it
   assert.equal(await page.evaluate(()=>pt.map.getContainer().id),'ptMapRot');
   assert.equal(await page.evaluate(()=>$('#ptMapRot').contains($('#ptMapFollow'))||$('#ptMapRot').contains($('#ptMapHeadUp'))),false);
   // the car sits in the lower part of the visible box so the road ahead gets the space
   const carY=await page.evaluate(()=>{const b=$('#ptMapBox').getBoundingClientRect(),c=pt.mapMe.getElement().getBoundingClientRect();return (c.top+c.height/2-b.top)/b.height});
   assert.ok(carY>0.55&&carY<0.9,'car is in the lower part of the map box, got '+carY.toFixed(2));

   // 2. the numbers on the map are the numbers of the card list
   checks.push('map numbers equal the visible queue');
   const queueLen=await page.evaluate(()=>DGPatrolHistory.candidates(pt.ahead,pt.marks,pt.showChecked).length);
   assert.deepEqual(await numbers(),Array.from({length:queueLen},(_,i)=>String(i+1)));
   assert.equal(await page.locator('#ptAhead .ptcard').count(),queueLen);

   // 3. marking the first light removes its number from the map and the list alike; its result circle stays
   checks.push('a marked light leaves the map numbering');
   const marked=await page.evaluate(()=>{const t=DGPatrolHistory.candidates(pt.ahead,pt.marks,pt.showChecked)[0].l;ptMark('고장');return t.id});
   await page.waitForTimeout(400);
   assert.equal(await page.evaluate(()=>pt.marks.length),1);
   assert.equal(await page.evaluate(id=>pt.ahead.some(a=>a.l.id===id),marked),true,'the light is still physically ahead');
   const after=await page.evaluate(()=>DGPatrolHistory.candidates(pt.ahead,pt.marks,pt.showChecked).length);
   assert.equal(after,queueLen-1);
   assert.deepEqual(await numbers(),Array.from({length:after},(_,i)=>String(i+1)),'no number is drawn for the marked light');
   assert.equal(await page.locator('#ptAhead .ptcard').count(),after);
   assert.ok(await page.evaluate(id=>{const l=S.lights.find(x=>x.id===id);return pt.mapMarks.getLayers().some(m=>m.getLatLng&&!(m.getElement&&m.getElement()&&m.getElement().classList.contains('ptmapnum'))&&Math.abs(m.getLatLng().lat-l.lat)<1e-7&&Math.abs(m.getLatLng().lng-l.lng)<1e-7)},marked),'the result circle of the marked light remains on the map');
   // "표시한 등 보기" brings the marked light back into both numberings
   await page.locator('#ptShowChecked').click();await page.waitForTimeout(300);
   assert.deepEqual(await numbers(),Array.from({length:queueLen},(_,i)=>String(i+1)));
   assert.equal(await page.locator('#ptAhead .ptcard').count(),queueLen);
   await page.locator('#ptShowChecked').click();await page.waitForTimeout(300);
   assert.equal((await numbers()).length,after);

   // 4. the open record panel shares the side area: the map keeps (nearly) its height, the next light and the mark buttons stay visible
   checks.push('open record panel keeps the map, the next light and the buttons');
   const mapBefore=await page.evaluate(()=>$('#ptMapBox').getBoundingClientRect().height);
   await page.locator('#ptHistory > summary').click();
   await page.waitForFunction(()=>$('#ptHistory').open&&$('#ptLog .ptlogrow'));
   const mapAfter=await page.evaluate(()=>$('#ptMapBox').getBoundingClientRect().height);
   assert.ok(mapAfter>=mapBefore*0.9,'map keeps at least 90% of its height: '+mapBefore.toFixed(0)+' → '+mapAfter.toFixed(0));
   const vis=sel=>page.evaluate(sel=>{const e=document.querySelector(sel);if(!e)return null;const r=e.getBoundingClientRect();return r.height>0&&r.bottom<=innerHeight&&r.top>=0},sel);
   assert.equal(await vis('#ptAhead .ptcard.first'),true,'the next light card is visible');
   assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#ptAhead .ptcard')].filter(c=>c.getBoundingClientRect().height>0).length),1,'only the next light stays while the records are open');
   assert.equal(await vis('#ptOkBtn'),true,'the mark buttons are visible');
   assert.equal(await vis('#ptLog .ptlogrow'),true,'the first record row is visible');
   assert.ok(await page.evaluate(()=>{const b=$('#ptMapBox').getBoundingClientRect(),c=pt.mapMe.getElement().getBoundingClientRect();return c.top>=b.top&&c.bottom<=b.bottom}),'the car stays inside the map box');
   await page.locator('#ptHistory > summary').click();
   await page.waitForFunction(()=>!$('#ptHistory').open);
   assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#ptAhead .ptcard')].filter(c=>c.getBoundingClientRect().height>0).length),after,'closing the panel brings the whole queue back');

   // 5. north-up on request: the layer is level, the car turns instead; dragging the map also levels it
   checks.push('north-up toggle and drag');
   await page.locator('#ptMapHeadUp').click();await page.waitForTimeout(700);
   assert.equal(await page.evaluate(()=>pt.headUp),false);
   assert.equal(await page.locator('#ptMapHeadUp').getAttribute('aria-pressed'),'false');
   assert.match(await page.locator('#ptMapHeadUp').textContent(),/북쪽 위/);
   assert.equal(await page.evaluate(()=>$('#ptMapRot').style.transform),'');
   assert.equal(await page.evaluate(()=>pt.mapMe.getElement().querySelector('.car').style.transform),'rotate(40deg)');
   assert.deepEqual(await badgeAngles(),[0]);
   assert.equal(await page.evaluate(()=>localStorage.getItem('dg_ptHeadUp')),'0','the choice is remembered');
   await page.locator('#ptMapHeadUp').click();await page.waitForTimeout(300);
   assert.equal(await page.evaluate(()=>$('#ptMapRot').style.transform),'rotate(-40deg)');
   await page.evaluate(()=>{pt.map.fire('dragstart')});await page.waitForTimeout(100);
   assert.equal(await page.evaluate(()=>pt.mapFollow),false);
   assert.equal(await page.evaluate(()=>$('#ptMapRot').style.transform),'','leaving follow mode levels the map so dragging is predictable');
   assert.equal(await page.locator('#ptMapFollow').getAttribute('aria-pressed'),'false');
   await page.locator('#ptMapFollow').click();await page.waitForTimeout(300);
   assert.equal(await page.evaluate(()=>pt.mapFollow&&$('#ptMapRot').style.transform==='rotate(-40deg)'),true,'따라가기 restores heading-up');

   // Parent and car rotations both contribute to what the user sees. Inline rotate(0deg) alone is not evidence
   // that the car points up when the entire Leaflet map above it is rotated.
   checks.push('composed screen heading covers cardinal bearings, wrap-around, head-up and follow combinations');
   for(const headUp of [true,false])for(const follow of [true,false])for(const heading of [0,90,180,270,359,1]){
     await page.evaluate(({headUp,follow,heading})=>{pt.headUp=headUp;pt.mapFollow=follow;pt.heading=heading;ptMapDraw(true)},{headUp,follow,heading});
     await page.waitForTimeout(520);
     await assertCarScreenBearing(headUp&&follow?0:heading,JSON.stringify({headUp,follow,heading}));
   }
   await page.evaluate(()=>{pt.headUp=true;pt.mapFollow=true;pt.heading=359;ptMapDraw()});await page.waitForTimeout(520);
   const wrap=await page.evaluate(()=>{const before=pt.mapRotAcc;pt.heading=1;ptMapDraw();return pt.mapRotAcc-before});
   assert.equal(wrap,-2,'359° to 1° rotates the parent by the short two-degree arc');
   await page.waitForTimeout(150);await assertCarScreenBearing(0,'heading-up stays upright during the 359° to 1° animation');
   await page.waitForTimeout(400);await assertCarScreenBearing(0,'heading-up stays upright across 359° to 1°');
   await page.evaluate(()=>{pt.headUp=true;pt.mapFollow=true;pt.heading=40;ptMapDraw(true)});await page.waitForTimeout(520);

   // 6. many records: the list scrolls inside the open panel and its last row is reachable (regression: PR #17 removed its height cap)
   checks.push('record list scrolls with many records');
   let innerSize='portrait';
   const scrollCase=async()=>{
     await page.evaluate(()=>{const ls=S.lights.filter(l=>Number.isFinite(l.lat)).slice(0,30);pt.marks=ls.slice(0,15).map((l,i)=>({id:l.id,code:l.code,result:i%3?'정상':'고장',at:Date.now()-i*60000}));ptDraw(true)});
     await page.evaluate(()=>{$('#ptHistory').open=true});await page.waitForFunction(()=>$('#ptHistory').open&&$('#ptLog .ptlogrow'));
     await page.evaluate(()=>ptDraw(true));await page.waitForTimeout(200);
     const m=await page.evaluate(()=>{const log=$('#ptLog'),panel=$('#ptHistory').getBoundingClientRect(),r=log.getBoundingClientRect();return {rows:log.querySelectorAll('.ptlogrow').length,scrollable:log.scrollHeight>log.clientHeight+2,inside:r.bottom<=panel.bottom+1&&r.top>=panel.top,client:log.clientHeight,overflow:getComputedStyle(log).overflowY}});
     assert.equal(m.rows,10,'first page of records is rendered');
     assert.equal(m.scrollable,true,'the list is taller than its box so it can scroll: '+JSON.stringify(m));
     assert.equal(m.inside,true,'the list box ends inside the panel, nothing is clipped away: '+JSON.stringify(m));
     assert.equal(m.overflow,'auto');
     await page.evaluate(()=>{const log=$('#ptLog');log.scrollTop=log.scrollHeight});await page.waitForTimeout(100);
     assert.ok(await page.evaluate(()=>$('#ptLog').scrollTop>0),'scrollTop moves');
     assert.ok(await page.evaluate(()=>{const b=$('#ptHistoryMore').getBoundingClientRect(),p=$('#ptHistory').getBoundingClientRect();return b.bottom<=p.bottom+1&&b.top>=p.top}),'the "더 보기" button at the end of the list can be scrolled into view');
     // the mark buttons stay usable while the records are open: visible, and not under the panel
     assert.ok(await page.evaluate(()=>{const b=$('#ptOkBtn').getBoundingClientRect(),p=$('#ptHistory').getBoundingClientRect();const el=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return b.height>0&&b.bottom<=innerHeight&&el&&(el===$('#ptOkBtn')||$('#ptOkBtn').contains(el))&&!(b.right>p.left&&b.left<p.right&&b.bottom>p.top&&b.top<p.bottom)}),'켜져 있음 button is visible and not covered by the open record panel ('+innerSize+')');
     await page.evaluate(()=>{$('#ptHistory').open=false});await page.waitForFunction(()=>!$('#ptHistory').open);
   };
   await scrollCase();
   await page.setViewportSize({width:844,height:390});await page.waitForTimeout(300);innerSize='landscape';
   await scrollCase();
   // landscape: the queue is not hidden under the buttons any more — at least two cards fit beside the map
   assert.ok(await page.evaluate(()=>[...document.querySelectorAll('#ptAhead .ptcard')].filter(c=>{const r=c.getBoundingClientRect(),a=$('#ptAhead').getBoundingClientRect();return r.top>=a.top-1&&r.bottom<=a.bottom+1}).length>=2),'two queue cards are visible in landscape');
   assert.ok(await page.evaluate(()=>{const b=$('.ptfull .ptbtns').getBoundingClientRect(),v=$('#ptMapBox').getBoundingClientRect();return b.top>=v.bottom-1&&b.left<v.right}),'in landscape the buttons sit under the map');
   await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);

   await page.evaluate(()=>ptFinish());
   assert.deepEqual(errors,[]);
   console.log(JSON.stringify({results:checks,browserErrors:errors},null,2));
 }finally{await context.close();await browser.close();server.close()}
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1});
