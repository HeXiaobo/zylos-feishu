function requireInteger(value, field, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Pure coalescing policy for the Feishu projection. It knows when a durable
 * checkpoint becomes flushable, but owns neither timers nor CardKit I/O.
 */
export function createProgressCoalescer({ windowMs = 500 } = {}) {
  requireInteger(windowMs, 'progress coalescer windowMs', 250, 1_000);

  return Object.freeze({
    dueAt({
      now,
      currentDueAt = null,
      highWatermark,
      lastAppliedSequence,
      terminalSequence = null,
    }) {
      requireInteger(now, 'progress coalescer now', 0);
      requireInteger(highWatermark, 'progress coalescer highWatermark', 0);
      requireInteger(lastAppliedSequence, 'progress coalescer lastAppliedSequence', 0);
      if (terminalSequence !== null) {
        requireInteger(terminalSequence, 'progress coalescer terminalSequence', 1);
      }
      if (currentDueAt !== null) requireInteger(currentDueAt, 'progress coalescer currentDueAt', 0);
      if (highWatermark <= lastAppliedSequence) return null;
      if (terminalSequence !== null && highWatermark >= terminalSequence) return now;
      return currentDueAt ?? now + windowMs;
    },
  });
}
