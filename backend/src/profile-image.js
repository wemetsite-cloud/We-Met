'use strict';

const AVATAR_RE = /^avatar-(0[1-9]|1[0-9]|20)\.svg$/;
const DATA_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_PROFILE_IMAGE_CHARS = 620000;

function normalizeProfileImage(value) {
  if (value === undefined) return undefined;
  const image = String(value || '').trim();
  if (!image) return null;
  if (AVATAR_RE.test(image)) return image;
  if (image.length <= MAX_PROFILE_IMAGE_CHARS && DATA_RE.test(image)) return image;
  return false;
}

function profileImageReference(value, userId = '') {
  const image = String(value || '').trim();
  if (AVATAR_RE.test(image)) return image;
  if (DATA_RE.test(image) && userId) return `photo:${userId}`;
  return null;
}

function decodeProfileImage(value) {
  const image = String(value || '').trim();
  const match = image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  return { mime: `image/${match[1]}`, buffer: Buffer.from(match[2], 'base64') };
}

module.exports = { normalizeProfileImage, profileImageReference, decodeProfileImage, AVATAR_RE, MAX_PROFILE_IMAGE_CHARS };
