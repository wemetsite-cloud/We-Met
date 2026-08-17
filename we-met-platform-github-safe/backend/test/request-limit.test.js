const test = require('node:test');
const assert = require('node:assert/strict');
const createRateLimit = require('../src/request-limit');

function responseDouble() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('rate limiting is isolated by client and blocks only after the configured allowance', () => {
  const limit = createRateLimit({ windowMs: 60_000, max: 2, message: 'Please wait.' });
  let allowed = 0;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = responseDouble();
    limit({ ip: '203.0.113.10' }, response, () => { allowed += 1; });
    if (attempt < 3) {
      assert.equal(response.statusCode, 200);
    } else {
      assert.equal(response.statusCode, 429);
      assert.deepEqual(response.body, { error: 'Please wait.' });
      assert.equal(response.headers['RateLimit-Remaining'], '0');
      assert.ok(Number(response.headers['Retry-After']) >= 1);
    }
  }

  const otherClient = responseDouble();
  limit({ ip: '198.51.100.24' }, otherClient, () => { allowed += 1; });
  assert.equal(allowed, 3);
  assert.equal(otherClient.statusCode, 200);
});
