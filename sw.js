/* 동구 가로등 점검 — service worker
   App shell is cached on install; index.html is served from cache and refreshed in the background;
   map tiles and OCR assets are cached as they are used so a patrol in a known area works without signal. */
const VERSION="v3";
const SHELL="dg-shell-"+VERSION, RUNTIME="dg-runtime-"+VERSION, TILES="dg-tiles-"+VERSION;
const SHELL_FILES=["./","./index.html","./manifest.webmanifest","./data/lights.json","./seed/manifest.json","./vendor/jsQR.js","./vendor/leaflet.js","./vendor/qrcode.js","./icons/icon-192.png","./icons/icon-512.png","./icons/maskable-512.png","./icons/apple-touch-icon.png"];
const TILE_MAX=600, RUNTIME_HOSTS=["cdn.jsdelivr.net","unpkg.com","cdnjs.cloudflare.com","fonts.googleapis.com","fonts.gstatic.com"];

self.addEventListener("install",e=>{e.waitUntil(caches.open(SHELL).then(c=>c.addAll(SHELL_FILES)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith("dg-")&&![SHELL,RUNTIME,TILES].includes(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("message",e=>{if(e.data==="skipWaiting")self.skipWaiting()});

async function trim(name,max){const c=await caches.open(name);const keys=await c.keys();if(keys.length>max){for(const k of keys.slice(0,keys.length-max))await c.delete(k)}}

self.addEventListener("fetch",e=>{
  const req=e.request;if(req.method!=="GET")return;
  const url=new URL(req.url);
  // app shell: stale-while-revalidate so a deploy shows up on the next open
  if(url.origin===location.origin){
    e.respondWith(caches.open(SHELL).then(async c=>{
      const cached=await c.match(req,{ignoreSearch:true});
      const net=fetch(req).then(r=>{if(r&&r.ok)c.put(req,r.clone());return r}).catch(()=>null);
      return cached||(await net)||new Response("오프라인이에요. 연결되면 다시 열어 주세요.",{status:503,headers:{"Content-Type":"text/plain;charset=utf-8"}});
    }));return;
  }
  if(url.hostname==="tile.openstreetmap.org"){
    e.respondWith(caches.open(TILES).then(async c=>{const hit=await c.match(req);if(hit)return hit;try{const r=await fetch(req);if(r&&r.ok){c.put(req,r.clone());trim(TILES,TILE_MAX)}return r}catch(err){return new Response("",{status:504})}}));return;
  }
  if(RUNTIME_HOSTS.includes(url.hostname)){
    e.respondWith(caches.open(RUNTIME).then(async c=>{const hit=await c.match(req);if(hit)return hit;try{const r=await fetch(req);if(r&&(r.ok||r.type==="opaque"))c.put(req,r.clone());return r}catch(err){return hit||Response.error()}}));return;
  }
});
