import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
for (const file of ['index.html', 'report/index.html']) {
  let count = 0;
  for (const match of read(file).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/.test(match[1]) || /\btype\s*=\s*["']application\//.test(match[1])) continue;
    new Script(match[2], { filename: `${file}:inline-${++count}` });
  }
  assert.ok(count > 0, `${file}: inline application script is missing`);
}
for (const file of ['sw.js', 'firebase-config.js', 'report/config.js']) {
  new Script(read(file), { filename: file });
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
