import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
for (const file of ['index.html', 'report/index.html']) {
  const scripts = [];
  for (const match of read(file).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\btype\s*=\s*["']application\//.test(match[1])) continue;
    const src = /\bsrc=["']([^"']+)["']/.exec(match[1]);
    if (src && /^(?:https?:|\/\/)/.test(src[1])) continue;
    const code = src ? read(resolve(dirname(file), src[1].split('?')[0])) : match[2];
    new Script(code, { filename: src ? src[1] : `${file}:inline-${scripts.length + 1}` });
    scripts.push(code);
  }
  assert.ok(scripts.length > 0, `${file}: application scripts are missing`);
  new Script(scripts.join('\n;\n'), { filename: `${file}:combined-global-scope` });
}
for (const file of ['sw.js', 'firebase-config.js', 'report/config.js', ...(existsSync(resolve(root, 'security.js')) ? ['security.js'] : []), ...readdirSync(resolve(root, 'app')).filter(name => name.endsWith('.js')).map(name => 'app/' + name)]) {
  new Script(read(file), { filename: file });
}
for (const file of ['index.html', 'report/index.html']) {
  for (const match of read(file).matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)) {
    if (/^(?:https?:|data:|\/\/|#)/.test(match[1])) continue;
    assert.ok(existsSync(resolve(root, dirname(file), match[1].split('?')[0])), `Missing local asset: ${file} → ${match[1]}`);
  }
}
// The staff app's classic scripts share one global scope: a name declared twice at the top level would silently replace
// the first (function) or stop the whole app with a SyntaxError (let/const). Declarations must be unique across files.
{
  const html = read('index.html'), seen = new Map(), dupes = [];
  const files = [...html.matchAll(/<script src="((?:app\/|security|firebase-config|report\/config)[^"]*)"/g)].map(m => [m[1], read(m[1])]);
  [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(m => !/\bsrc\s*=/.test(m[1])).forEach((m, i) => files.push(['index.html inline ' + (i + 1), m[2]]));
  for (const [file, code] of files) for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1] || m[2];
    if (seen.has(name)) dupes.push(`${name}: ${seen.get(name)} and ${file}`); else seen.set(name, file);
  }
  assert.deepEqual(dupes, [], 'Top-level names declared twice in the staff app');
}
const manifest = JSON.parse(read('manifest.webmanifest'));
JSON.parse(read('seed/manifest.json'));
for (const icon of manifest.icons) assert.ok(existsSync(resolve(root, icon.src)), `Missing icon: ${icon.src}`);
const registry = JSON.parse(read('data/lights.json'));
assert.ok(registry.cols.length && registry.rows.length, 'Registry must not be empty');
assert.equal(registry.count, registry.rows.length, 'Registry count must match rows');
const ids = new Set();
for (const row of registry.rows) {
  assert.equal(row.length, registry.cols.length, 'Registry row width');
  const light = Object.fromEntries(registry.cols.map((name, i) => [name, row[i]]));
  assert.ok(typeof light.id === 'string' && light.id && !ids.has(light.id), `Duplicate/missing ID: ${light.id}`);
  ids.add(light.id);
  assert.ok(Number.isFinite(light.lat) && Math.abs(light.lat) <= 90, `Invalid latitude: ${light.id}`);
  assert.ok(Number.isFinite(light.lng) && Math.abs(light.lng) <= 180, `Invalid longitude: ${light.id}`);
}
console.log(`Source syntax, manifest assets, and ${ids.size} registry records verified.`);
const tests = readdirSync(resolve(root, 'scripts/tests')).filter(name => name.endsWith('.test.cjs')).sort();
assert.ok(tests.length, 'Regression tests are missing');
const result = spawnSync(process.execPath, ['--test', ...tests.map(name => `scripts/tests/${name}`)], {
  cwd: root, stdio: 'inherit', timeout: 120000
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
