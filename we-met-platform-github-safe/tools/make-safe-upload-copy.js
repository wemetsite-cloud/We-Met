const fs = require('fs');
const path = require('path');

const source = path.resolve(__dirname, '..');
const destination = path.resolve(source, '..', 'we-met-platform-github-safe');
const excludedNames = new Set(['node_modules', '.git', '.env']);

function shouldSkip(sourcePath, name) {
  if (excludedNames.has(name)) return true;
  if (name.endsWith('.log') || name === '.DS_Store') return true;
  return sourcePath === destination || sourcePath.startsWith(`${destination}${path.sep}`);
}

function copyDirectory(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const sourcePath = path.join(from, entry.name);
    if (shouldSkip(sourcePath, entry.name)) continue;
    const destinationPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath);
  }
}

fs.rmSync(destination, { recursive: true, force: true });
copyDirectory(source, destination);

const forbidden = [
  path.join(destination, 'backend', '.env'),
  path.join(destination, 'backend', 'node_modules'),
  path.join(destination, 'node_modules'),
];
if (forbidden.some((item) => fs.existsSync(item))) {
  throw new Error('The safe copy unexpectedly contains a private or generated path.');
}

console.log('\nSAFE GITHUB COPY CREATED:');
console.log(destination);
console.log('\nThis copy excludes backend/.env, node_modules, .git and log files.');
console.log('Upload this new folder to GitHub, not the local running folder.\n');
