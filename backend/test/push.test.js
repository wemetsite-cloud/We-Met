const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  JWT_SECRET: 'test-jwt-secret-that-is-longer-than-forty-eight-characters-123456789',
  ADMIN_PASSWORD: 'test-admin-password',
});

const { notificationPayload } = require('../src/push');

test('creates a privacy-safe bounded Web Push payload', () => {
  const payload = JSON.parse(notificationPayload({
    title: `  ${'A'.repeat(200)}  `,
    body: 'Incoming private Malayalam call',
    tag: 'call-1',
    url: './',
    requireInteraction: true,
    renotify: true,
    vibrate: [3000, -20, 150, 90, 80, 70, 60, 50, 40],
  }));

  assert.equal(payload.title.length, 120);
  assert.equal(payload.body, 'Incoming private Malayalam call');
  assert.equal(payload.tag, 'call-1');
  assert.equal(payload.requireInteraction, true);
  assert.equal(payload.renotify, true);
  assert.deepEqual(payload.vibrate, [2000, 0, 150, 90, 80, 70, 60, 50]);
});

test('uses generic app-safe defaults when optional push fields are missing', () => {
  const payload = JSON.parse(notificationPayload());
  assert.equal(payload.title, 'We Met');
  assert.equal(payload.url, './');
  assert.equal(payload.tag, 'we-met-update');
  assert.equal(payload.requireInteraction, false);
});

test('supports a silent caller-name notification for a closed listener app', () => {
  const payload = JSON.parse(notificationPayload({
    title: 'Priya',
    body: 'is calling you',
    tag: 'we-met-call-1',
    silent: true,
    renotify: false,
    requireInteraction: false,
    vibrate: [500, 500],
  }));

  assert.equal(payload.title, 'Priya');
  assert.equal(payload.body, 'is calling you');
  assert.equal(payload.silent, true);
  assert.equal(payload.renotify, false);
  assert.equal(payload.requireInteraction, false);
  assert.deepEqual(payload.vibrate, []);
});
