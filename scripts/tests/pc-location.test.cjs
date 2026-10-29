const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.resolve(__dirname,'../../index.html'),'utf8');
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
