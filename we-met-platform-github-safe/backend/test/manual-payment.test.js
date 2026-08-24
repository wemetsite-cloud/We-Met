const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectImageMime,
  normaliseTransferReference,
  publicSubmission,
  upiPaymentUri,
} = require('../src/manual-payment');

test('normalises valid UPI transaction references and rejects unsafe values', () => {
  assert.equal(normaliseTransferReference('  4234 5678 9012  '), '423456789012');
  assert.equal(normaliseTransferReference('nesf/upi:abc-123'), 'NESF/UPI:ABC-123');
  assert.equal(normaliseTransferReference('short'), '');
  assert.equal(normaliseTransferReference('<script>alert(1)</script>'), '');
});

test('builds a private exact-amount payload for the server-rendered QR', () => {
  const uri = upiPaymentUri({
    upiId: 'merchant@example',
    payeeName: 'We Met Test',
    amountPaise: 4900,
    reference: 'WM-TEST-123456',
    note: 'We Met test payment',
  });
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'upi:');
  assert.equal(parsed.hostname, 'pay');
  assert.equal(parsed.searchParams.get('pa'), 'merchant@example');
  assert.equal(parsed.searchParams.get('am'), '49.00');
  assert.equal(parsed.searchParams.get('cu'), 'INR');
  assert.equal(parsed.searchParams.get('tr'), 'WM-TEST-123456');
  assert.match(uri, /pn=We%20Met%20Test/);
  assert.match(uri, /tn=We%20Met%20test%20payment/);
  assert.doesNotMatch(uri, /\+/);
  assert.doesNotMatch(uri, /gpay:|intent:/i);
});


test('builds the configured UPI account identity and unique transaction reference', () => {
  const uri = upiPaymentUri({
    upiId: 'paytm.s3hc53w@pty',
    payeeName: 'Sabith Salah K P',
    amountPaise: 199900,
    reference: 'WM-TEST-1999',
    note: 'We Met WM-TEST-1999',
  });
  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('pa'), 'paytm.s3hc53w@pty');
  assert.equal(parsed.searchParams.get('pn'), 'Sabith Salah K P');
  assert.equal(parsed.searchParams.get('tn'), 'We Met WM-TEST-1999');
  assert.equal(parsed.searchParams.get('am'), '1999.00');
  assert.equal(parsed.searchParams.get('tr'), 'WM-TEST-1999');
});

test('accepts only recognised raster-image signatures', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const webp = Buffer.from('RIFF0000WEBP', 'ascii');
  const svg = Buffer.from('<svg onload="alert(1)"></svg>', 'utf8');
  assert.equal(detectImageMime(png), 'image/png');
  assert.equal(detectImageMime(jpeg), 'image/jpeg');
  assert.equal(detectImageMime(webp), 'image/webp');
  assert.equal(detectImageMime(svg), '');
});

test('customer submission output excludes stored image bytes and payee details', () => {
  const output = publicSubmission({
    id: 'payment-1',
    plan_id: 'plan-1',
    plan_name: 'Starter',
    amount_paise: 4900,
    seconds: 300,
    payment_method: 'upi',
    checkout_reference: 'WM-TEST-1',
    destination_last4: '3453',
    utr_reference: '423456789012',
    proof_size: 1200,
    proof_data: Buffer.from('private'),
    payee_upi_id: 'private@example',
    status: 'pending',
  });
  assert.equal(output.method, 'upi_direct');
  assert.equal(output.proof_available, true);
  assert.equal('proof_data' in output, false);
  assert.equal('payee_upi_id' in output, false);
});
