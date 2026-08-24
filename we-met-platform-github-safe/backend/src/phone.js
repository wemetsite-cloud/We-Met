'use strict';

function normalizePhone(value) {
  const original = String(value || '').trim();
  const digits = original.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

function indianMobile(value) {
  const normalized = normalizePhone(value);
  if (!normalized || !/^\+91[6-9]\d{9}$/.test(normalized)) return null;
  return normalized.slice(3);
}

function maskPhone(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return '';
  return `${normalized.slice(0, 3)} •••••• ${normalized.slice(-4)}`;
}

module.exports = { normalizePhone, indianMobile, maskPhone };
