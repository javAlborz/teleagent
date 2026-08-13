'use strict';

const express = require('express');
const logger = require('./logger');

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
  return bearerMatch ? bearerMatch[1].trim() : (req.get('x-api-key') || '').trim();
}

function requireUnlockAuthorization(req, res, next) {
  const configuredToken = String(
    process.env.VOICE_CONTROL_TOKEN ||
    process.env.OUTBOUND_API_TOKEN ||
    process.env.AGENT_API_TOKEN ||
    process.env.CLAUDE_API_TOKEN ||
    ''
  ).trim();

  if (!configuredToken) {
    return res.status(503).json({ success: false, error: 'voice_control_token_not_configured' });
  }
  if (getProvidedToken(req) === configuredToken) return next();
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ success: false, error: 'unauthorized' });
}

function createVoiceControlRouter({ jobBroker, agentBridge } = {}) {
  if (!jobBroker) throw new Error('createVoiceControlRouter requires jobBroker');
  if (!agentBridge) throw new Error('createVoiceControlRouter requires agentBridge');

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

  router.get('/voice-control/status', requireLoopback, (req, res) => {
    return res.json({ success: true, voiceExecution: jobBroker.getExecutionLock() });
  });

  router.post('/voice-control/unlock', requireUnlockAuthorization, async (req, res) => {
    const source = String(req.body?.source || 'operator');
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
  createVoiceControlRouter,
  getProvidedToken,
  isLoopbackAddress,
  requireLoopback,
  requireUnlockAuthorization,
};
