/* Read the deployed entry points for source-level VM tests, regardless of HTML/script separation.
   Only the extracted entry assets are expanded; independent feature modules keep their own tests. */
const fs = require('node:fs');
const path = require('node:path');
const entries = new Set(['app/staff-app.js', 'app/staff.css', 'report.js', 'report.css']);
function readSource(file, options) {
  const value = fs.readFileSync(file, options);
  if (path.extname(String(file)) !== '.html') return value;
  const parent = path.dirname(String(file));
  const expanded = value.toString().replace(/<script\b[^>]*src="([^"]+)"[^>]*>\s*<\/script>/g, (tag, src) => entries.has(src) ? '<script>\n' + fs.readFileSync(path.join(parent, src), 'utf8') + '\n</script>' : tag)
    .replace(/<link\b[^>]*href="([^"]+)"[^>]*>/g, (tag, src) => entries.has(src) && src.endsWith('.css') ? '<style>\n' + fs.readFileSync(path.join(parent, src), 'utf8') + '\n</style>' : tag);
  return Buffer.isBuffer(value) ? Buffer.from(expanded) : expanded;
}
module.exports = { readSource };
