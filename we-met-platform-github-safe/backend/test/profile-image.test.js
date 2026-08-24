const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProfileImage, profileImageReference, decodeProfileImage } = require('../src/profile-image');

test('accepts only the shipped listener avatar names', () => {
  assert.equal(normalizeProfileImage('avatar-01.svg'), 'avatar-01.svg');
  assert.equal(normalizeProfileImage('avatar-20.svg'), 'avatar-20.svg');
  assert.equal(normalizeProfileImage('avatar-21.svg'), false);
  assert.equal(normalizeProfileImage('../avatar-01.svg'), false);
});

test('accepts supported compressed data images and exposes only a lightweight public reference', () => {
  const data = `data:image/jpeg;base64,${Buffer.from('small-profile-image').toString('base64')}`;
  assert.equal(normalizeProfileImage(data), data);
  assert.equal(profileImageReference(data, 'abc-123'), 'photo:abc-123');
  const decoded = decodeProfileImage(data);
  assert.equal(decoded.mime, 'image/jpeg');
  assert.equal(decoded.buffer.toString(), 'small-profile-image');
});

test('rejects svg data uploads and unsafe arbitrary profile-image strings', () => {
  assert.equal(normalizeProfileImage('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(normalizeProfileImage('https://example.com/photo.jpg'), false);
});
