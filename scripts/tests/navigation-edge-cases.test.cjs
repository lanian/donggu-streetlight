const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const source = readFileSync(resolve(__dirname, '../../index.html'),'utf8');
function fn(name, end) {
  const start = source.indexOf('function '+name+'(');
  assert.ok(start >= 0, name+' exists');
  const stop = source.indexOf(end,start);
  assert.ok(stop > start, name+' boundary exists');
  return source.slice(start,stop);
}
test('initial history root preserves the currently selected tab',()=>{
  assert.match(source,/history\.replaceState\(\{nav:0,tab:S\.tab\}/);
  assert.doesNotMatch(source,/history\.replaceState\(\{nav:0,tab:\(history\.state/);
});
test('autosave acknowledges the actual fingerprint rather than an earlier draft',()=>{
  const persist=fn('fdPersist','async function fdClear');
  assert.match(persist,/st\.savedFingerprint=fp/);
  const guard=fn('fdGuard','for\(const type of');
  assert.match(guard,/st\.savedFingerprint===fdFingerprint\(fdSnapshot\(key\)\)/);
});
test('restored draft gets matching fingerprint and clear invalidates it',()=>{
  const arm=fn('fdArm','function fdDirty');
  assert.match(arm,/st\.savedFingerprint=fdFingerprint\(fdSnapshot\(key\)\)/);
  const clear=fn('fdClear','function fdGuard');
  assert.match(clear,/st\.savedFingerprint=null/);
});
test('permission revalidation bypasses draft guard before forced close',()=>{
  const check=fn('navRevalidate','function navRoute');
  assert.match(check,/if\(top\)top\.guard=null;closeSheet\("all"\)/);
});
