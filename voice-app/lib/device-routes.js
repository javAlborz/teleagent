/**
 * Device API Routes
 * Express routes for listing configured phone devices
 */

const express = require('express');
const router = express.Router();
const logger = require('./logger');
const deviceRegistry = require('./device-registry');
const { getHoldMusicEnabled } = require('./phone-agent-config');

function publicDevice(device, { includeVoiceId = false } = {}) {
  const isRealtime = device.voiceMode === 'openai-realtime';
  return {
    name: device.name,
    extension: device.extension,
    voiceMode: device.voiceMode || 'legacy',
    modelProfile: isRealtime
      ? (device.defaultAgentProfile || 'codex-terra')
      : (device.sessionType || 'phone'),
    defaultAgentProfile: device.defaultAgentProfile,
    resumeTargetExtension: device.resumeTargetExtension,
    voiceThreadTtlSeconds: device.voiceThreadTtlSeconds,
    hasVoice: isRealtime || !!device.voiceId,
    hasPrompt: !!device.prompt,
    ...(includeVoiceId ? { voiceId: device.voiceId } : {}),
    agentTimeoutSeconds: device.agentTimeoutSeconds ?? device.claudeTimeoutSeconds,
    claudeTimeoutSeconds: device.claudeTimeoutSeconds,
    holdMusicEnabled: isRealtime ? false : getHoldMusicEnabled(device),
    maxTurns: device.maxTurns,
  };
}

/**
 * GET /devices
 * List all registered devices
 */
router.get('/devices', (req, res) => {
  try {
    const allDevices = deviceRegistry.getAll();

    const deviceList = Object.values(allDevices).map(device => publicDevice(device));

    res.json({
      success: true,
      count: deviceList.length,
      devices: deviceList
    });
  } catch (error) {
    logger.error('Get devices error', {
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'internal_error',
      message: 'Failed to retrieve devices'
    });
  }
});

/**
 * GET /device/:identifier
 * Get specific device by name or extension
 */
router.get('/device/:identifier', (req, res) => {
  try {
    const { identifier } = req.params;

    const device = deviceRegistry.get(identifier);

    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Device not found'
      });
    }

    res.json({
      success: true,
      device: publicDevice(device, { includeVoiceId: true })
    });
  } catch (error) {
    logger.error('Get device error', {
      error: error.message,
      identifier: req.params.identifier
    });

    res.status(500).json({
      success: false,
      error: 'internal_error',
      message: 'Failed to retrieve device'
    });
  }
});

module.exports = router;
module.exports.publicDevice = publicDevice;
