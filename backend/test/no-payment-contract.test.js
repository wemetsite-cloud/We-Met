'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('the release contains no customer checkout implementation', () => {
  const removed = [
    ['customer-site', 'checkout.html'],
    ['customer-site', 'checkout.css'],
    ['customer-site', 'checkout.js'],
    ['customer-site', 'pricing.html'],
    ['customer-site', 'delivery.html'],
    ['customer-site', 'refund.html'],
    ['backend', 'src', 'routes', 'razor' + 'pay.js'],
    ['backend', 'src', 'routes', 'subscriptions.js'],
    ['backend', 'src', 'routes', 'manual-payments.js'],
  ];
  for (const parts of removed) {
    assert.equal(fs.existsSync(path.join(root, ...parts)), false, `${parts.join('/')} must not ship`);
  }

  const html = read('customer-site', 'index.html');
  const app = read('customer-site', 'app.js');
  const server = read('backend', 'server.js');
  const config = read('backend', 'src', 'config.js');
  const packageJson = JSON.parse(read('backend', 'package.json'));
  const providerName = ['razor', 'pay'].join('');
  const forbidden = new RegExp(`${providerName}|checkout\\.${providerName}|create-order|verify-payment|payment_intents|payment_submissions`, 'i');

  assert.match(html, /Online purchases are not available/);
  assert.doesNotMatch(`${html}\n${app}\n${server}\n${config}`, forbidden);
  assert.doesNotMatch(`${html}\n${app}`, /data-buy-plan|data-subscribe|Continue to payment/i);
  assert.equal(packageJson.dependencies?.[providerName], undefined);
  assert.equal(packageJson.dependencies?.qrcode, undefined);
});

test('customer capture deterrence and v8.8 cache controls ship on every customer page', () => {
  const siteRoot = path.join(root, 'customer-site');
  const headers = read('customer-site', '_headers');
  const guard = read('customer-site', 'privacy-guard.js');
  const guardCss = read('customer-site', 'privacy-guard.css');
  const serviceWorker = read('customer-site', 'service-worker.js');

  assert.match(headers, /display-capture=\(\)/);
  assert.match(headers, /payment=\(\)/);
  assert.match(headers, /frame-src 'none'/);
  assert.match(guard, /visibilitychange/);
  assert.match(guard, /beforeprint/);
  assert.match(guard, /printscreen/i);
  assert.match(guardCss, /@media print/);
  assert.match(serviceWorker, /const VERSION = '8\.8\.0'/);

  for (const name of fs.readdirSync(siteRoot).filter((entry) => entry.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(siteRoot, name), 'utf8');
    assert.match(html, /privacy-guard\.css\?v=8\.8\.0/, `${name} must load capture CSS`);
    assert.match(html, /privacy-guard\.js\?v=8\.8\.0/, `${name} must load capture JS`);
  }
});

test('all portal caches use the same release version', () => {
  for (const site of ['customer-site', 'admin-site', 'employee-site']) {
    assert.match(read(site, 'service-worker.js'), /const VERSION = '8\.8\.0'/, `${site} cache is stale`);
  }
  assert.equal(JSON.parse(read('VERSION.json')).version, '8.8.0');
});
