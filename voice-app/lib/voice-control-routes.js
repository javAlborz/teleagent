'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const express = require('express');
const logger = require('./logger');
const { getRuntimeSecret } = require('./runtime-secrets');

const OTHER_VOICE_SCOPE_TOKENS = Object.freeze([
  'AGENT_API_TOKEN',
  'CLAUDE_API_TOKEN',
  'EXECUTOR_API_TOKEN',
  'OUTBOUND_API_TOKEN',
]);

class VoiceControlAuthConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceControlAuthConfigError';
    this.code = code;
  }
}

function normalizeVoiceControlToken(value) {
  const token = typeof value === 'string' ? value : '';
  const byteLength = Buffer.byteLength(token, 'utf8');
  if (byteLength < 32 || byteLength > 4096 ||
      !/^[\x21-\x7E]+$/.test(token) ||
      /(?:replace|change)[-_ ]?with|placeholder|example|changeme/i.test(token)) {
    return '';
  }
  return token;
}

function timingSafeTokenEqual(provided, expected) {
  const left = createHash('sha256').update(String(provided || ''), 'utf8').digest();
  const right = createHash('sha256').update(String(expected || ''), 'utf8').digest();
  return timingSafeEqual(left, right);
}

function loadVoiceControlAuthConfig({ env: suppliedSettings = null, runtimeSecrets = null } = {}) {
  const apiToken = normalizeVoiceControlToken(
    runtimeSecrets?.voiceControlToken ||
      (suppliedSettings ? suppliedSettings.VOICE_CONTROL_TOKEN : getRuntimeSecret('voiceControlToken'))
  );
  if (!apiToken) {
    throw new VoiceControlAuthConfigError(
      'VOICE_CONTROL_AUTH_NOT_CONFIGURED',
      'VOICE_CONTROL_TOKEN must be a clean non-placeholder ASCII token from 32 to 4096 bytes.'
    );
  }
  for (const name of OTHER_VOICE_SCOPE_TOKENS) {
    const runtimeName = {
      EXECUTOR_API_TOKEN: 'executorApiToken',
      OUTBOUND_API_TOKEN: 'outboundApiToken',
    }[name];
    const other = String(
      suppliedSettings ? suppliedSettings[name] : (runtimeName
        ? (runtimeSecrets?.[runtimeName] || getRuntimeSecret(runtimeName, { required: false }))
        : '')
    ).trim();
    if (other && timingSafeTokenEqual(apiToken, other)) {
      throw new VoiceControlAuthConfigError(
        'VOICE_CONTROL_TOKEN_REUSED',
        `VOICE_CONTROL_TOKEN must be distinct from ${name}.`
      );
    }
  }
  return Object.freeze({ apiToken });
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function requireLoopback(req, res, next) {
  if (isLoopbackAddress(req.socket?.remoteAddress)) return next();
  return res.status(403).json({ success: false, error: 'loopback_required' });
}

function getProvidedToken(req) {
  const authHeader = req.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  return bearerMatch ? bearerMatch[1].trim() : '';
}

function createUnlockAuthorizationMiddleware(apiToken) {
  const configuredToken = normalizeVoiceControlToken(apiToken);
  if (!configuredToken) {
    throw new VoiceControlAuthConfigError(
      'VOICE_CONTROL_AUTH_NOT_CONFIGURED',
      'A validated voice-control token is required by the unlock router.'
    );
  }
  return function requireUnlockAuthorization(req, res, next) {
    if (timingSafeTokenEqual(getProvidedToken(req), configuredToken)) return next();
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ success: false, error: 'unauthorized' });
  };
}

function createVoiceControlRouter({ jobBroker, agentBridge, voiceControlAuth = null } = {}) {
  if (!jobBroker) throw new Error('createVoiceControlRouter requires jobBroker');
  if (!agentBridge) throw new Error('createVoiceControlRouter requires agentBridge');
  const auth = voiceControlAuth || loadVoiceControlAuthConfig();
  const requireUnlockAuthorization = createUnlockAuthorizationMiddleware(auth.apiToken);

  const router = express.Router();

  router.post('/voice-control/stop', requireLoopback, async (req, res) => {
    const source = String(req.body?.source || req.query?.source || 'asterisk_1001');
    const reason = String(req.body?.reason || req.query?.reason || 'voice_panic_stop');

    try {
      const result = await jobBroker.panicStop(reason, source);
      const success = Boolean(
        result.locked &&
        result.persistent &&
        result.bridge?.success
      );
      logger.warn('Voice panic stop activated', {
        source,
        success,
        canceledCount: result.canceledCount,
        runningCount: result.runningCount,
        bridgeSuccess: Boolean(result.bridge?.success),
      });

      if (String(req.query?.response || '').toLowerCase() === 'plain') {
        return res.status(success ? 200 : 503).type('text/plain').send(success ? 'STOPPED' : 'PARTIAL');
      }
      return res.status(success ? 200 : 503).json({ success, ...result });
    } catch (error) {
      logger.error('Voice panic stop failed', { source, error: error.message });
      if (String(req.query?.response || '').toLowerCase() === 'plain') {
        return res.status(503).type('text/plain').send('PARTIAL');
      }
      return res.status(503).json({ success: false, error: error.message });
    }
  });

  router.get('/voice-control/status', requireLoopback, requireUnlockAuthorization, (req, res) => {
    return res.json({ success: true, voiceExecution: jobBroker.getExecutionLock() });
  });

  router.post('/voice-control/unlock', requireUnlockAuthorization, async (req, res) => {
    const source = String(req.body?.source || 'operator');
    const readiness = jobBroker.getUnlockReadiness?.() || { ready: true };
    if (readiness.ready !== true) {
      return res.status(503).json({
        success: false,
        error: readiness.error || 'local_voice_unlock_not_ready',
        local: readiness,
      });
    }
    const bridge = await agentBridge.unlockVoiceExecution(source);
    if (!bridge.success || bridge.voiceExecution?.locked !== false) {
      return res.status(503).json({
        success: false,
        error: bridge.error || 'agent_bridge_unlock_failed',
        bridge,
      });
    }

    const local = jobBroker.unlockExecution(source);
    const success = local.locked === false;
    logger.warn('Voice execution lock cleared', { source, success });
    return res.status(success ? 200 : 503).json({ success, local, bridge });
  });

  return router;
}

module.exports = {
  VoiceControlAuthConfigError,
  createUnlockAuthorizationMiddleware,
  createVoiceControlRouter,
  getProvidedToken,
  isLoopbackAddress,
  loadVoiceControlAuthConfig,
  normalizeVoiceControlToken,
  requireLoopback,
  timingSafeTokenEqual,
};
