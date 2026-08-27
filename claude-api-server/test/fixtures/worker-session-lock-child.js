'use strict';

const fs = require('node:fs');
const {
  acquireWorkerSessionSingletonLock,
} = require('../../worker-session-broker-service');

const [lockPath, auditPath] = process.argv.slice(2);
let lock = null;
let keepAlive = null;

function record(event) {
  fs.appendFileSync(auditPath, `${process.pid}:${event}\n`, { mode: 0o600 });
}

process.once('message', (message) => {
  if (message !== 'start') return;
  try {
    lock = acquireWorkerSessionSingletonLock(lockPath, {
      expectedUid: process.getuid(),
      allowTestPath: true,
    });
    record('lock_acquired');
    // These sentinels represent the first possible Store/recovery/provider/tmux
    // work. A lock loser must never reach any of them.
    record('store_open');
    record('recover');
    record('tmux');
    keepAlive = setInterval(() => {}, 60_000);
    process.send?.({ status: 'acquired', pid: process.pid });
  } catch (error) {
    record('lock_rejected');
    if (process.send) {
      process.send({ status: 'rejected', message: error.message, pid: process.pid }, () => {
        process.exit(17);
      });
    } else {
      process.exit(17);
    }
  }
});

function releaseAndExit() {
  clearInterval(keepAlive);
  lock?.release();
  process.exit(0);
}

process.on('SIGTERM', releaseAndExit);
process.on('SIGINT', releaseAndExit);
