'use strict';

function normalizePhone(value) {
  const original = String(value || '').trim();
  const digits = original.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15 && digits[0] !== '0') return `+${digits}`;
  return null;
}

function internationalPhone(value) {
  const normalized = normalizePhone(value);
  return normalized && /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

function indianMobile(value) {
  const normalized = normalizePhone(value);
  if (!normalized || !/^\+91[6-9]\d{9}$/.test(normalized)) return null;
  return normalized.slice(3);
}

function maskPhone(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return '';
  const digits = normalized.slice(1);
  const countryLength = Math.max(1, digits.length - 10);
  return `+${digits.slice(0, countryLength)} •••••• ${digits.slice(-4)}`;
}

module.exports = { normalizePhone, internationalPhone, indianMobile, maskPhone };
