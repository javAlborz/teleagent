#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { probeUnixSocket } = require('./server');
const { PrivilegedActionStore } = require('./store');
const {
  normalizePrivilegedStateConfiguration,
} = require('./state-configuration');

const BROKER_SOCKET = '/run/teleagent-privileged-action/broker.sock';
const CHILD_MARKER = 'TELEAGENT_PRIVILEGED_ACTION_CHILD=1';

function markedPrivilegedProcesses() {
  const pids = [];
  const unreadable = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    try {
      const environment = fs.readFileSync(`/proc/${entry}/environ`, 'utf8');
      if (environment.split('\0').includes(CHILD_MARKER)) pids.push(Number(entry));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unreadable.push(Number(entry));
    }
  }
  return { pids, unreadable };
}

async function socketIsLive() {
  if (!fs.existsSync(BROKER_SOCKET)) return false;
  return probeUnixSocket(BROKER_SOCKET);
}

async function main() {
  if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) {
    throw new Error('The privileged action local control must run as root.');
  }
  const command = String(process.argv[2] || 'status');
  if (!['status', 'unlock-panic'].includes(command)) {
    throw new Error('Usage: control.js [status|unlock-panic]');
  }
  const liveSocket = await socketIsLive();
  const processState = markedPrivilegedProcesses();
  const state = normalizePrivilegedStateConfiguration(process.env);
  const store = new PrivilegedActionStore({
    dbPath: state.databasePath,
    expectedUid: 0,
    expectedGid: 0,
    strictOwnership: true,
    assertStorageOpen: () => state.storage.assertOpen(),
    admitNewWork: () => state.storage.assertNewWork(),
  });
  try {
    if (command === 'status') {
      process.stdout.write(`${JSON.stringify({
        panic: store.getPanicStatus(),
        activeActionCount: store.countActiveActions(),
        markedChildPids: processState.pids,
        procEntriesUnverifiable: processState.unreadable.length,
        brokerSocketLive: liveSocket,
      })}\n`);
      return;
    }
    if (liveSocket) {
      throw new Error('Stop the privileged action broker before local panic unlock.');
    }
    if (processState.unreadable.length > 0) {
      throw new Error('Process quiescence could not be verified; panic remains locked.');
    }
    // Any durable execution intent left by a stopped/crashed broker is
    // conservatively terminalized outcome_unknown before the active-count gate.
    store.recoverInterrupted();
    const result = store.unlockPanic({
      source: 'root_local_control_cli',
      activeChildCount: processState.pids.length,
    });
    process.stdout.write(`${JSON.stringify({ success: true, panic: result.panic })}\n`);
  } finally {
    store.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Privileged action control refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { markedPrivilegedProcesses };
