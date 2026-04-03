const logger = require('./logger');

const DEFAULT_RESUME_TTL_SECONDS = 600;
const cache = new Map();

function parsePositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getResumeTtlSeconds(deviceConfig, fallback = DEFAULT_RESUME_TTL_SECONDS) {
  return parsePositiveInteger(
    deviceConfig?.resumeTtlSeconds,
    parsePositiveInteger(fallback, DEFAULT_RESUME_TTL_SECONDS)
  );
}

function normalizeCallerId(callerId) {
  return String(callerId || 'unknown').trim() || 'unknown';
}

function normalizeExtension(extension) {
  return String(extension || '').trim();
}

function buildCacheKey(callerId, extension) {
  const normalizedExtension = normalizeExtension(extension);
  if (!normalizedExtension) return null;
  return `${normalizeCallerId(callerId)}:${normalizedExtension}`;
}

function clearEntryTimeout(entry) {
  if (entry?.expiryTimer) {
    clearTimeout(entry.expiryTimer);
    entry.expiryTimer = null;
  }
}

function forgetRecentSession(callerId, extension, reason = 'manual_forget') {
  const key = buildCacheKey(callerId, extension);
  if (!key || !cache.has(key)) return false;

  const entry = cache.get(key);
  clearEntryTimeout(entry);
  cache.delete(key);

  logger.info('Recent session cache entry removed', {
    key,
    callerId: normalizeCallerId(callerId),
    extension: normalizeExtension(extension),
    sessionKey: entry?.sessionKey || null,
    reason,
  });

  return true;
}

function rememberRecentSession({
  callerId,
  extension,
  sessionKey,
  sessionType = null,
  deviceName = null,
  ttlSeconds = DEFAULT_RESUME_TTL_SECONDS,
}) {
  const key = buildCacheKey(callerId, extension);
  const ttl = parsePositiveInteger(ttlSeconds, DEFAULT_RESUME_TTL_SECONDS);

  if (!key || !sessionKey) {
    logger.warn('Skipping recent session cache write with missing key/sessionKey', {
      callerId: normalizeCallerId(callerId),
      extension: normalizeExtension(extension),
      sessionKey: sessionKey || null,
    });
    return null;
  }

  if (cache.has(key)) {
    clearEntryTimeout(cache.get(key));
  }

  const now = Date.now();
  const entry = {
    callerId: normalizeCallerId(callerId),
    extension: normalizeExtension(extension),
    sessionKey,
    sessionType,
    deviceName,
    storedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    ttlSeconds: ttl,
    expiryTimer: setTimeout(() => {
      const expiredEntry = cache.get(key);
      if (expiredEntry?.sessionKey === sessionKey) {
        cache.delete(key);
        logger.info('Recent session cache entry expired', {
          key,
          callerId: expiredEntry.callerId,
          extension: expiredEntry.extension,
          sessionKey: expiredEntry.sessionKey,
          expiresAt: expiredEntry.expiresAt,
        });
      }
    }, ttl * 1000),
  };

  if (typeof entry.expiryTimer.unref === 'function') {
    entry.expiryTimer.unref();
  }

  cache.set(key, entry);
  logger.info('Recent session cached', {
    key,
    callerId: entry.callerId,
    extension: entry.extension,
    sessionKey: entry.sessionKey,
    sessionType: entry.sessionType,
    deviceName: entry.deviceName,
    ttlSeconds: entry.ttlSeconds,
    expiresAt: entry.expiresAt,
  });

  return {
    callerId: entry.callerId,
    extension: entry.extension,
    sessionKey: entry.sessionKey,
    sessionType: entry.sessionType,
    deviceName: entry.deviceName,
    storedAt: entry.storedAt,
    expiresAt: entry.expiresAt,
    ttlSeconds: entry.ttlSeconds,
  };
}

function getRecentSession(callerId, extension) {
  const key = buildCacheKey(callerId, extension);
  if (!key) {
    return {
      hit: false,
      reason: 'invalid_extension',
      key: null,
      entry: null,
    };
  }

  const entry = cache.get(key);
  if (!entry) {
    logger.info('Recent session cache miss', {
      key,
      callerId: normalizeCallerId(callerId),
      extension: normalizeExtension(extension),
    });
    return {
      hit: false,
      reason: 'miss',
      key,
      entry: null,
    };
  }

  const expiresAtMs = Date.parse(entry.expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    forgetRecentSession(callerId, extension, 'expired_on_read');
    logger.info('Recent session cache expired on lookup', {
      key,
      callerId: normalizeCallerId(callerId),
      extension: normalizeExtension(extension),
      sessionKey: entry.sessionKey,
      expiresAt: entry.expiresAt,
    });
    return {
      hit: false,
      reason: 'expired',
      key,
      entry: null,
    };
  }

  logger.info('Recent session cache hit', {
    key,
    callerId: entry.callerId,
    extension: entry.extension,
    sessionKey: entry.sessionKey,
    sessionType: entry.sessionType,
    deviceName: entry.deviceName,
    expiresAt: entry.expiresAt,
  });

  return {
    hit: true,
    reason: 'hit',
    key,
    entry: {
      callerId: entry.callerId,
      extension: entry.extension,
      sessionKey: entry.sessionKey,
      sessionType: entry.sessionType,
      deviceName: entry.deviceName,
      storedAt: entry.storedAt,
      expiresAt: entry.expiresAt,
      ttlSeconds: entry.ttlSeconds,
    },
  };
}

function clearRecentSessions() {
  for (const entry of cache.values()) {
    clearEntryTimeout(entry);
  }
  cache.clear();
}

module.exports = {
  DEFAULT_RESUME_TTL_SECONDS,
  getResumeTtlSeconds,
  rememberRecentSession,
  getRecentSession,
  forgetRecentSession,
  clearRecentSessions,
};
