const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
for (const [page, script, stylesheet] of [['index.html', 'app/staff-app.js', 'app/staff.css'], ['report/index.html', 'report.js', 'report.css']]) {
  test(page + ' loads its application code and styles from cacheable local files', () => {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.ok(html.includes('src="' + script + '"'), 'application entry script is external');
    assert.ok(html.includes('href="' + stylesheet + '"'), 'application stylesheet is external');
    for (const m of html.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/(script|style)>/g)) assert.ok(m[2].length < 10000, 'large application code does not remain inline');
  });
}
