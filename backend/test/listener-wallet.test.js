const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateListenerEarnings } = require('../src/listener-earnings');

test('calculates listener earnings from connected seconds and the rate snapshot', () => {
  assert.equal(calculateListenerEarnings(60, 500), 500);
  assert.equal(calculateListenerEarnings(30, 500), 250);
  assert.equal(calculateListenerEarnings(65, 700), 758);
  assert.equal(calculateListenerEarnings(1, 500), 8);
});

test('never creates negative or invalid listener earnings', () => {
  assert.equal(calculateListenerEarnings(0, 500), 0);
  assert.equal(calculateListenerEarnings(-60, 500), 0);
  assert.equal(calculateListenerEarnings(60, -500), 0);
  assert.equal(calculateListenerEarnings('invalid', 500), 0);
});
