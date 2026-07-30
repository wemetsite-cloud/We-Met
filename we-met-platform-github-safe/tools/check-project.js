const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.git']);
const jsFiles = [];
const htmlFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) jsFiles.push(full);
    else if (entry.name.endsWith('.html')) htmlFiles.push(full);
  }
}
walk(root);

let failed = false;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    console.error(`Syntax error: ${path.relative(root, file)}\n${result.stderr}`);
  }
}

for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) {
    failed = true;
    console.error(`Duplicate HTML ids in ${path.relative(root, htmlFile)}: ${[...new Set(duplicates)].join(', ')}`);
  }

  const appFile = path.join(path.dirname(htmlFile), 'app.js');
  if (fs.existsSync(appFile)) {
    const js = fs.readFileSync(appFile, 'utf8');
    const selectors = [...js.matchAll(/\$\(["'](#[A-Za-z][\w:-]*)["']\)/g)].map((m) => m[1].slice(1));
    const dynamicIds = [...js.matchAll(/\bid=[\\"']([A-Za-z][\w:-]*)[\\"']/g)].map((m) => m[1]);
    const available = new Set([...ids, ...dynamicIds]);
    const missing = [...new Set(selectors.filter((id) => !available.has(id)))];
    if (missing.length) {
      failed = true;
      console.error(`Missing HTML ids for ${path.relative(root, appFile)}: ${missing.join(', ')}`);
    }
  }
}

const required = [
  'customer-site/style.css', 'employee-site/style.css', 'admin-site/style.css',
  'customer-site/assets/logo.svg', 'employee-site/assets/logo.svg', 'admin-site/assets/logo.svg',
  'backend/.env.example', 'backend/database/schema.sql', 'SETUP_WINDOWS.bat', 'START_WINDOWS.bat',
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) {
    failed = true;
    console.error(`Missing required file: ${relative}`);
  }
}

if (failed) process.exit(1);
console.log(`Project check passed: ${jsFiles.length} JavaScript files and ${htmlFiles.length} HTML files.`);
