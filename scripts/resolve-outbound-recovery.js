#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { OutboundRuntimeFence } = require('../voice-app/lib/outbound-runtime-fence');
const {
  OUTBOUND_QUIESCENCE_CONFIRMATION,
  VoiceStateStore,
} = require('../voice-app/lib/voice-state-store');

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--db', '--call-id', '--confirm'].includes(argument)) {
      throw new Error(
        'Usage: npm run outbound-recovery -- --db /absolute/voice.sqlite ' +
        `--call-id <exact-call-id> --confirm ${OUTBOUND_QUIESCENCE_CONFIRMATION}`
      );
    }
    if (index + 1 >= argv.length) throw new Error(`${argument} requires a value`);
    parsed[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function assertSecureStateFile(dbPath) {
  if (!path.isAbsolute(dbPath)) throw new Error('--db must be an absolute path');
  const stat = fs.lstatSync(dbPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('The voice state DB must be a regular file, not a symlink');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('The voice state DB must not be accessible by group or other users');
  }
}

function resolveOutboundRecovery({
  argv = process.argv.slice(2),
  effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : null,
  FenceClass = OutboundRuntimeFence,
  StoreClass = VoiceStateStore,
} = {}) {
  if (effectiveUid !== 0) {
    throw new Error('Outbound recovery resolution must run as root with voice-app stopped');
  }
  const args = parseArguments(argv);
  const dbPath = String(args.db || '').trim();
  const callId = String(args['call-id'] || '').trim();
  const confirmation = String(args.confirm || '');
  if (!callId || callId.length > 200 || /[\u0000-\u001F\u007F]/.test(callId)) {
    throw new Error('--call-id must be an exact clean outbound call ID');
  }
  if (confirmation !== OUTBOUND_QUIESCENCE_CONFIRMATION) {
    throw new Error(`--confirm must be exactly ${OUTBOUND_QUIESCENCE_CONFIRMATION}`);
  }
  assertSecureStateFile(dbPath);

  // This process-lifetime lock is the authoritative proof that voice-app and
  // its dial worker are stopped. It is acquired before the primary DB opens.
  const runtimeFence = new FenceClass({ stateDbPath: dbPath });
  let stateStore = null;
  try {
    stateStore = new StoreClass({
      dbPath,
      managePermissions: false,
    });
    const resolved = stateStore.resolveOutboundRecoveryBarrier({
      callId,
      confirmation,
      source: 'offline_root_cli',
      runtimeFence,
    });
    if (!resolved.changed) {
      throw new Error(resolved.reason || 'Outbound recovery barrier was not resolved');
    }
    return {
      success: true,
      callId: resolved.record.callId,
      state: resolved.record.state,
      recoveryRequired: resolved.record.recoveryRequired,
      recoveryBarrierResolvedAt: resolved.record.recoveryBarrierResolvedAt,
    };
  } finally {
    stateStore?.close();
    runtimeFence.release();
  }
}

function main() {
  const result = resolveOutboundRecovery();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Outbound recovery failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertSecureStateFile,
  parseArguments,
  resolveOutboundRecovery,
};
