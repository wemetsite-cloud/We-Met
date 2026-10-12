function wholeNonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function calculateListenerEarnings(billedSeconds, ratePaisePerMinute) {
  const seconds = wholeNonNegative(billedSeconds);
  const ratePaise = wholeNonNegative(ratePaisePerMinute);
  if (!seconds || !ratePaise) return 0;

  // Calls are billed by connected second. Round only once, at call settlement,
  // so the listener receives the nearest paise for the complete call.
  return Math.round((seconds * ratePaise) / 60);
}

module.exports = { calculateListenerEarnings, wholeNonNegative };
