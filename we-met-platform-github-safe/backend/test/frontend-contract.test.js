const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const sites = ['customer-site', 'admin-site', 'employee-site'];

function localReference(value) {
  const clean = value.split('#')[0].split('?')[0];
  if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  return clean;
}

test('every local HTML asset and page reference resolves to a shipped file', () => {
  for (const site of sites) {
    const siteRoot = path.join(projectRoot, site);
    for (const name of fs.readdirSync(siteRoot).filter((entry) => entry.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(siteRoot, name), 'utf8');
      for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
        const reference = localReference(match[1]);
        if (!reference) continue;
        const target = path.resolve(siteRoot, path.dirname(name), reference);
        assert.equal(fs.existsSync(target), true, `${site}/${name} references missing ${reference}`);
      }
    }
  }
});

test('all web manifests are valid and their icons resolve', () => {
  for (const site of sites) {
    const siteRoot = path.join(projectRoot, site);
    const manifest = JSON.parse(fs.readFileSync(path.join(siteRoot, 'manifest.webmanifest'), 'utf8'));
    assert.ok(manifest.name);
    assert.ok(manifest.short_name);
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
    for (const icon of manifest.icons) {
      assert.equal(fs.existsSync(path.resolve(siteRoot, icon.src)), true, `${site} manifest icon ${icon.src} is missing`);
    }
  }
});

test('the public sitemap only points to shipped customer pages', () => {
  const siteRoot = path.join(projectRoot, 'customer-site');
  const sitemap = fs.readFileSync(path.join(siteRoot, 'sitemap.xml'), 'utf8');
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.ok(locations.length >= 6);
  for (const location of locations) {
    const url = new URL(location);
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    assert.equal(fs.existsSync(path.join(siteRoot, name)), true, `sitemap page ${name} is missing`);
  }
});

test('every admin page and listener tab navigation target exists', () => {
  const admin = fs.readFileSync(path.join(projectRoot, 'admin-site', 'index.html'), 'utf8');
  for (const match of admin.matchAll(/data-page="([^"]+)"/g)) {
    assert.match(admin, new RegExp(`id="page-${match[1]}"`), `admin page ${match[1]} is missing`);
  }

  const listener = fs.readFileSync(path.join(projectRoot, 'employee-site', 'index.html'), 'utf8');
  for (const match of listener.matchAll(/data-tab="([^"]+)"/g)) {
    assert.match(listener, new RegExp(`id="tab-${match[1]}"`), `listener tab ${match[1]} is missing`);
  }
});

test('the customer portal ships the v7 app layout and guided authentication', () => {
  const siteRoot = path.join(projectRoot, 'customer-site');
  const html = fs.readFileSync(path.join(siteRoot, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(siteRoot, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(siteRoot, 'app.js'), 'utf8');
  const serviceWorker = fs.readFileSync(path.join(siteRoot, 'service-worker.js'), 'utf8');

  assert.match(html, /id="tabs"[\s\S]*data-tab="home"[\s\S]*data-tab="history"[\s\S]*data-tab="wallet"[\s\S]*data-tab="profile"/);
  assert.match(html, /data-auth-flow="login"/);
  assert.match(html, /data-auth-flow="register"/);
  assert.equal((html.match(/data-auth-step="[1-4]"/g) || []).length, 6);
  assert.match(css, /\.plans-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(min-width:600px\)\{\.plans-grid\{grid-template-columns:repeat\(4/);
  assert.match(css, /@media\(min-width:840px\)\{\.plans-grid\{grid-template-columns:repeat\(5/);
  assert.match(css, /@media\(min-width:1080px\)\{\.plans-grid\{grid-template-columns:repeat\(6/);
  assert.match(app, /class="plan-minutes"/);
  assert.match(app, /Start voice call/);
  assert.doesNotMatch(app, /data-video|Start video call/);
  assert.match(serviceWorker, /const VERSION = '7\.0\.0'/);
});
